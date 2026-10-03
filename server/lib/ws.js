'use strict';
// Minimal RFC 6455 WebSocket server. The HUD runs with `npm prune --omit=dev` and
// no network access at install time, so this avoids taking a dependency for
// ~150 lines of frame handling. Text frames, ping/pong and close are supported;
// fragmentation is reassembled, extensions are not negotiated.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode a server->client frame (never masked). */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

class WebSocketConnection extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.isAlive = true;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._close(1006, ''));
    socket.on('end', () => this._close(1006, ''));
    socket.on('error', (err) => this._close(1006, String(err.message || err)));
  }

  send(value) {
    if (this.closed || this.socket.destroyed) return false;
    const payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
    try {
      this.socket.write(encodeFrame(OPCODE.TEXT, payload));
      return true;
    } catch {
      this._close(1006, 'write failed');
      return false;
    }
  }

  sendJson(value) {
    return this.send(JSON.stringify(value));
  }

  ping() {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(OPCODE.PING, Buffer.alloc(0)));
    } catch {
      this._close(1006, 'ping failed');
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, body));
      this.socket.end();
    } catch { /* peer already gone */ }
    this._close(code, reason);
  }

  _close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    // A client that never completes a frame could grow this without bound.
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.close(1009, 'message too big');
      return;
    }
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
      if (this.closed) return;
    }
  }

  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < offset + 2) return null;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(8 * 1024 * 1024)) {
        this.close(1009, 'message too big');
        return null;
      }
      length = Number(big);
      offset += 8;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + length) return null;

    const payload = Buffer.from(buf.subarray(offset, offset + length));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    this.buffer = buf.subarray(offset + length);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODE.PING:
        try {
          this.socket.write(encodeFrame(OPCODE.PONG, payload));
        } catch {
          this._close(1006, 'pong failed');
        }
        return;
      case OPCODE.PONG:
        this.isAlive = true;
        return;
      case OPCODE.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        try {
          this.socket.end();
        } catch { /* already ended */ }
        this._close(code, payload.subarray(2).toString('utf8'));
        return;
      }
      case OPCODE.CONTINUATION:
        this.fragments.push(payload);
        if (!fin) return;
        this._emitMessage(this.fragmentOpcode, Buffer.concat(this.fragments));
        this.fragments = [];
        this.fragmentOpcode = null;
        return;
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (!fin) {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
          return;
        }
        this._emitMessage(opcode, payload);
        return;
      default:
        this.close(1002, `unsupported opcode ${opcode}`);
    }
  }

  _emitMessage(opcode, payload) {
    if (opcode !== OPCODE.TEXT) return;
    const text = payload.toString('utf8');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    this.emit('message', parsed, text);
  }
}

/**
 * Attach a WebSocket endpoint to an existing http.Server.
 * @param {import('http').Server} server
 * @param {{path: string, maxClients?: number, onConnection: (conn: WebSocketConnection) => void}} options
 */
function attachWebSocketServer(server, options) {
  const { path: wsPath, maxClients = 12, onConnection, isHostAllowed } = options;
  const clients = new Set();

  const onUpgrade = (req, socket, head) => {
    const requestPath = (req.url || '').split('?')[0];
    if (requestPath !== wsPath) return; // not ours; leave the socket alone
    // The upgrade bypasses express middleware, so the rebinding guard has to be
    // applied here too.
    if (typeof isHostAllowed === 'function' && !isHostAllowed(req.headers.host)) {
      socket.write('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (clients.size >= maxClients) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.setNoDelay(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );

    const connection = new WebSocketConnection(socket, req);
    if (head && head.length) connection._onData(head);
    clients.add(connection);
    connection.on('close', () => clients.delete(connection));
    onConnection(connection);
  };

  server.on('upgrade', onUpgrade);

  return {
    clients,
    close() {
      server.off('upgrade', onUpgrade);
      for (const client of [...clients]) client.close(1001, 'server shutting down');
    },
  };
}

module.exports = { attachWebSocketServer, WebSocketConnection, encodeFrame, OPCODE, acceptKey };
