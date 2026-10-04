'use strict';
// The live hub: one WebSocket per browser tab carries resource payloads,
// presence and alerts. Clients subscribe to the resource names they actually
// render, so a floor that is not open costs nothing.

const { attachWebSocketServer } = require('./ws');

const SOCKET_PATH = '/api/live/socket';
const MAX_KEYS_PER_CLIENT = 32;

let nextClientId = 1;

class Client {
  constructor(connection, hub) {
    this.id = `c${nextClientId++}`;
    this.connection = connection;
    this.hub = hub;
    this.keys = new Set();
    this.floor = null;
    this.label = null;
    this.lastSeen = Date.now();
  }

  get open() {
    return !this.connection.closed;
  }

  send(type, payload) {
    return this.connection.sendJson({ type, seq: this.hub.sequence, at: Date.now(), ...payload });
  }

  toJSON() {
    return { id: this.id, floor: this.floor, label: this.label, keys: [...this.keys] };
  }
}

class LiveHub {
  /**
   * @param {{snapshot: (name: string) => any, alerts?: () => any[], heartbeatMs?: number,
   *          isHostAllowed?: (host?: string) => boolean}} options
   */
  constructor(options) {
    this.snapshot = options.snapshot;
    this.getAlerts = options.alerts || (() => []);
    // Kept on the instance: attach() runs after the constructor, so it cannot
    // close over the parameter.
    this.isHostAllowed = options.isHostAllowed;
    this.heartbeatMs = options.heartbeatMs || 25000;
    this.clients = new Map();
    this.sequence = 0;
    this.heartbeat = null;
    this.transport = null;
    this.stats = { publishes: 0, pushes: 0 };
  }

  attach(server) {
    this.transport = attachWebSocketServer(server, {
      path: SOCKET_PATH,
      maxClients: 12,
      onConnection: (connection) => this._addClient(connection),
      isHostAllowed: this.isHostAllowed,
    });
    this.heartbeat = setInterval(() => this._heartbeat(), this.heartbeatMs);
    this.heartbeat.unref?.();
    return this;
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.transport?.close();
    this.transport = null;
  }

  _addClient(connection) {
    const client = new Client(connection, this);
    this.clients.set(client.id, client);

    client.send('hello', {
      clientId: client.id,
      socketPath: SOCKET_PATH,
      heartbeatMs: this.heartbeatMs,
      serverTime: Date.now(),
    });
    this._broadcastPresence();

    connection.on('message', (message, raw) => {
      client.lastSeen = Date.now();
      if (message === null) {
        // Unparseable frames get an explicit error instead of silent death.
        client.send('error', { error: 'invalid JSON frame' });
        return;
      }
      this._onMessage(client, message);
    });

    connection.on('close', () => {
      this.clients.delete(client.id);
      this._broadcastPresence();
    });
  }

  _onMessage(client, message) {
    if (!message || typeof message !== 'object') {
      client.send('error', { error: 'message must be a JSON object' });
      return;
    }
    switch (message.type) {
      case 'subscribe': {
        const keys = Array.isArray(message.keys)
          ? message.keys.filter((key) => typeof key === 'string').slice(0, MAX_KEYS_PER_CLIENT)
          : [];
        client.keys = new Set(keys);
        if (typeof message.floor === 'string') client.floor = message.floor;
        if (typeof message.label === 'string') client.label = message.label;
        // Send current state for everything just subscribed to.
        for (const key of client.keys) this._pushResource(client, key);
        client.send('subscribed', { keys: [...client.keys] });
        this._broadcastPresence();
        return;
      }
      case 'unsubscribe': {
        const keys = Array.isArray(message.keys) ? message.keys : [];
        for (const key of keys) client.keys.delete(key);
        client.send('subscribed', { keys: [...client.keys] });
        this._broadcastPresence();
        return;
      }
      case 'presence': {
        if (typeof message.floor === 'string') client.floor = message.floor;
        if (typeof message.label === 'string') client.label = message.label;
        this._broadcastPresence();
        return;
      }
      case 'ping':
        client.send('pong', { echo: message.at ?? null });
        return;
      default:
        client.send('error', { error: `unknown message type ${message.type}` });
    }
  }

  _pushResource(client, key) {
    let payload;
    try {
      payload = this.snapshot(key);
    } catch (error) {
      return client.send('resource', { key, error: error.message });
    }
    if (payload && typeof payload.then === 'function') {
      payload.then(
        (value) => client.send('resource', { key, payload: value }),
        (error) => client.send('resource', { key, error: error.message })
      );
      return true;
    }
    return client.send('resource', { key, payload });
  }

  /**
   * Push the named resources to every client subscribed to them.
   * @param {string[]} names
   * @returns {number} deliveries attempted
   */
  publish(names) {
    if (!names || names.length === 0) return 0;
    this.sequence += 1;
    this.stats.publishes += 1;
    let delivered = 0;
    for (const client of this.clients.values()) {
      if (!client.open) {
        this.clients.delete(client.id);
        continue;
      }
      for (const name of names) {
        if (!client.keys.has(name)) continue;
        this._pushResource(client, name);
        delivered += 1;
      }
    }
    this.stats.pushes += delivered;
    return delivered;
  }

  publishAlerts(alerts) {
    this.sequence += 1;
    for (const client of this.clients.values()) {
      if (client.open) client.send('alerts', { alerts });
    }
  }

  _broadcastPresence() {
    this.sequence += 1;
    const viewers = [...this.clients.values()].filter((c) => c.open).map((c) => c.toJSON());
    for (const client of this.clients.values()) {
      if (client.open) client.send('presence', { viewers });
    }
  }

  _heartbeat() {
    const now = Date.now();
    for (const client of this.clients.values()) {
      if (!client.open) {
        this.clients.delete(client.id);
        continue;
      }
      client.connection.ping();
      if (now - client.lastSeen > this.heartbeatMs * 4) {
        client.connection.close(1001, 'no heartbeat');
        this.clients.delete(client.id);
      }
    }
  }

  /** Every resource name any client is currently subscribed to. */
  subscribedKeys() {
    const keys = new Set();
    for (const client of this.clients.values()) {
      if (client.open) for (const key of client.keys) keys.add(key);
    }
    return [...keys];
  }

  /** Every resource name any client is currently subscribed to. */
  subscribedKeys() {
    const keys = new Set();
    for (const client of this.clients.values()) {
      if (client.open) for (const key of client.keys) keys.add(key);
    }
    return [...keys];
  }

  status() {
    return {
      socketPath: SOCKET_PATH,
      clients: this.clients.size,
      sequence: this.sequence,
      stats: this.stats,
      viewers: [...this.clients.values()].map((client) => client.toJSON()),
    };
  }
}

module.exports = { LiveHub, SOCKET_PATH, MAX_KEYS_PER_CLIENT };
