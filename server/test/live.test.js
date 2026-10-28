'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');
const { TestWebSocketClient } = require('./helpers/ws-client');
const { LiveHub } = require('../lib/live_hub');

const fixture = makeFixtureHive();
const server = loadServer(fixture.hive);
const internals = server.internals;

let http;
let hub;
const clients = [];

test.before(async () => {
  http = await startTestServer(server.app);
  // A hub on the same HTTP server, the way bootstrap() wires it.
  hub = new LiveHub({
    snapshot: (name) => Promise.resolve(internals.buildSnapshot(name)),
    heartbeatMs: 1000,
    isHostAllowed: internals.hostIsAllowed,
    isOriginAllowed: internals.originIsAllowed,
  });
  hub.attach(http.server);
});

test.after(async () => {
  for (const client of clients) client.close();
  hub?.close();
  await http?.close();
  fixture.cleanup();
});

/** Connect and return the client with its id resolved. */
async function connect() {
  const client = await TestWebSocketClient.connect(http.port);
  clients.push(client);
  const hello = await client.waitForType('hello');
  client.clientId = hello.clientId;
  return client;
}

/**
 * Subscribe, wait for the initial payloads, and return them. The recorded
 * messages are handed back (rather than read off the client later) because a
 * test may want the subscribe burst, and the buffer must not be cleared before
 * the caller has looked at it.
 */
async function subscribe(client, keys, extra = {}) {
  client.send({ type: 'subscribe', keys, ...extra });
  await client.waitForType('subscribed');
  const resources = [];
  for (const key of keys) {
    resources.push(await client.waitFor((m) => m.type === 'resource' && m.key === key));
  }
  return { client, resources };
}

/** Subscribe, then discard the burst so a test can observe only later pushes. */
async function subscribeQuiet(client, keys, extra = {}) {
  const result = await subscribe(client, keys, extra);
  client.messages.length = 0;
  return result;
}

test('handshake succeeds and greets with hello', async () => {
  const client = await TestWebSocketClient.connect(http.port);
  clients.push(client);
  const hello = await client.waitForType('hello');
  assert.match(hello.clientId, /^c\d+$/);
  assert.equal(hello.socketPath, '/api/live/socket');
  assert.ok(hello.serverTime > 0);
});

test('a cross-origin upgrade is refused (websockets bypass CORS)', async () => {
  // A page on any origin can open a socket at 127.0.0.1 and read everything the
  // hub pushes, so the Origin check has to run on the upgrade itself.
  await assert.rejects(
    () => TestWebSocketClient.connect(http.port, '/api/live/socket', '127.0.0.1', {
      headers: { Origin: 'http://evil.example.com' },
    }),
    /403|handshake failed/
  );
});

test('a same-origin upgrade is served', async () => {
  const client = await TestWebSocketClient.connect(http.port, '/api/live/socket', '127.0.0.1', {
    headers: { Origin: `http://127.0.0.1:${http.port}` },
  });
  try {
    const hello = await client.waitForType('hello');
    assert.match(hello.clientId, /^c\d+$/);
  } finally {
    // Not registered in `clients`: the hub caps at 12 sockets and the rest of
    // this file needs those slots.
    client.close();
  }
});

test('subscribe pushes current state for each requested resource only', async () => {
  const { resources } = await subscribe(await connect(), ['queue', 'taskCounts']);
  const keys = resources.map((m) => m.key);
  assert.deepEqual([...new Set(keys)].sort(), ['queue', 'taskCounts'], 'no unrequested resource is sent');
  assert.equal(resources.find((m) => m.key === 'queue').payload.total, 5);
});

test('presence lists this client with its floor and keys', async () => {
  const { client } = await subscribe(await connect(), ['queue'], { floor: 'f9', label: 'tab-a' });
  const presence = await client.waitFor(
    (m) => m.type === 'presence' && m.viewers.some((v) => v.id === client.clientId && v.floor === 'f9')
  );
  const me = presence.viewers.find((v) => v.id === client.clientId);
  assert.equal(me.label, 'tab-a');
  assert.deepEqual(me.keys, ['queue']);
});

test('publish reaches subscribers of that resource and nobody else', async () => {
  const { client } = await subscribeQuiet(await connect(), ['queue']);

  hub.publish(['providers']);   // nobody is subscribed to providers
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(client.messages.filter((m) => m.type === 'resource').length, 0);

  hub.publish(['queue']);
  const pushed = await client.waitForType('resource');
  assert.equal(pushed.key, 'queue');
  assert.equal(client.messages.filter((m) => m.type === 'resource').length, 1);
});

test('unsubscribe stops delivery', async () => {
  const { client } = await subscribe(await connect(), ['queue']);
  client.send({ type: 'unsubscribe', keys: ['queue'] });
  await client.waitFor((m) => m.type === 'subscribed' && m.keys.length === 0);
  client.messages.length = 0;

  hub.publish(['queue']);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(client.messages.filter((m) => m.type === 'resource').length, 0);
});

test('alerts are broadcast to every client', async () => {
  const client = await connect();
  hub.publishAlerts([{ fingerprint: 'test:1', severity: 'warn', title: 'unit test' }]);
  const message = await client.waitForType('alerts');
  assert.equal(message.alerts[0].fingerprint, 'test:1');
});

test('a producer that throws reports the error and keeps the socket open', async () => {
  // Its own listener, so the upgrade is not claimed by the main hub first.
  const failing = new LiveHub({
    snapshot: (name) => {
      if (name === 'boom') throw new Error('producer exploded');
      return { ok: true };
    },
  });
  const scratch = require('http').createServer((_req, res) => res.end('ok'));
  failing.attach(scratch);
  await new Promise((resolve) => scratch.listen(0, '127.0.0.1', resolve));
  const port = scratch.address().port;
  try {
    const client = await TestWebSocketClient.connect(port);
    clients.push(client);
    client.send({ type: 'subscribe', keys: ['boom'] });
    const message = await client.waitForType('resource');
    assert.equal(message.error, 'producer exploded');
    assert.equal(client.closed, false, 'connection must stay open');
    // the socket is still usable afterwards
    client.send({ type: 'ping', at: 7 });
    const pong = await client.waitForType('pong');
    assert.equal(pong.echo, 7);
  } finally {
    failing.close();
    await new Promise((resolve) => scratch.close(resolve));
  }
});

test('a key outside the registry degrades to an error payload', async () => {
  const client = await connect();
  client.send({ type: 'subscribe', keys: ['not-a-resource'] });
  const message = await client.waitForType('resource');
  assert.match(message.error, /Unknown resource/);
});

test('malformed JSON gets an explicit error frame', async () => {
  const client = await connect();
  // A masked text frame carrying "{x}" — valid framing, invalid JSON.
  client.send('{x}');
  const message = await client.waitForType('error');
  assert.equal(message.error, 'invalid JSON frame');
});

test('unknown message types are rejected, not fatal', async () => {
  const client = await connect();
  client.send({ type: 'nonsense' });
  const message = await client.waitForType('error');
  assert.match(message.error, /unknown message type/);
});

test('a non-object frame is rejected', async () => {
  const client = await connect();
  client.send('"just a string"');
  const message = await client.waitForType('error');
  assert.match(message.error, /JSON object/);
});

test('ping is answered with pong', async () => {
  const client = await connect();
  client.send({ type: 'ping', at: 1234 });
  const pong = await client.waitForType('pong');
  assert.equal(pong.echo, 1234);
});

test('hub status counts clients and viewers', async () => {
  const { client } = await subscribe(await connect(), ['queue'], { floor: 'f1', label: 'test tab' });
  const status = hub.status();
  assert.ok(status.clients >= 1);
  assert.equal(status.socketPath, '/api/live/socket');
  assert.ok(status.viewers.some((v) => v.id === client.clientId && v.label === 'test tab'));
});

test('the live status route answers even with no hub attached', async () => {
  // bootstrap() owns the hub; the test process deliberately does not start it.
  const res = await http.get('/api/live/status');
  assert.equal(res.status, 200);
  assert.equal(res.json.clients, 0);
});

test.after(() => { setImmediate(() => process.exit(process.exitCode ?? 0)); });
