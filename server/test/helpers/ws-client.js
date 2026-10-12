'use strict';
// A minimal WebSocket client for the tests, so the hand-rolled server is
// exercised over a real socket instead of a mocked one.

const crypto = require('crypto');
const net = require('net');
const { EventEmitter } = require('events');
const { encodeFrame, OPCODE, acceptKey } = require('../../lib/ws');

class TestWebSocketClient extends EventEmitter {
  static connect(port, path = '/api/live/socket', host = '127.0.0.1', options = {}) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(port, host, () => {
        // Extra raw headers, for cases a browser sends and this helper must be
        // able to imitate — Origin being the one that matters for the guards.
        const extra = Object.entries(options.headers || {})
          .filter(([, value]) => value != null)
          .map(([name, value]) => `${name}: ${value}\r\n`)
          .join('');
        socket.write(
          `GET ${path} HTTP/1.1\r\n` +
          `Host: ${options.host || `${host}:${port}`}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          `${extra}\r\n`
        );
      });

      let handshake = Buffer.alloc(0);
      const onData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = handshake.subarray(0, end).toString();
        socket.off('data', onData);
        const expected = acceptKey(key);
        if (!head.includes('101') || !head.toLowerCase().includes(expected.toLowerCase())) {
          reject(new Error(`handshake failed: ${head.split('\r\n')[0]}`));
          socket.destroy();
          return;
        }
        const client = new TestWebSocketClient(socket);
        const rest = handshake.subarray(end + 4);
        if (rest.length) client._onData(rest);
        resolve(client);
      };
      socket.on('data', onData);
      socket.on('error', reject);
    });
  }

  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.closed = false;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => { this.closed = true; this.emit('close'); });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this._read();
      if (!frame) return;
      if (frame.opcode === OPCODE.TEXT) {
        let parsed = null;
        try { parsed = JSON.parse(frame.payload.toString('utf8')); } catch { /* keep null */ }
        const message = { ...parsed, raw: frame.payload.toString('utf8') };
        this.messages.push(message);
        this.emit('message', message);
      } else if (frame.opcode === OPCODE.CLOSE) {
        this.closed = true;
        this.emit('close', frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000);
      }
    }
  }

  _read() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0f;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      length = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    if (buf.length < offset + length) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + length));
    this.buffer = buf.subarray(offset + length);
    return { opcode, payload };
  }

  /** Client frames must be masked. */
  send(value) {
    const payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];

    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | payload.length;
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    header[0] = 0x80 | OPCODE.TEXT;
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  /** Wait for the first message matching `predicate`, with a timeout. */
  waitFor(predicate, timeoutMs = 4000) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', onMessage);
        reject(new Error('timed out waiting for message'));
      }, timeoutMs);
      const onMessage = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.off('message', onMessage);
        resolve(message);
      };
      this.on('message', onMessage);
    });
  }

  waitForType(type, timeoutMs) {
    return this.waitFor((message) => message.type === type, timeoutMs);
  }

  close() {
    try { this.socket.end(); } catch { /* already ended */ }
    this.socket.destroy();
    this.closed = true;
  }
}

module.exports = { TestWebSocketClient, encodeFrame };
