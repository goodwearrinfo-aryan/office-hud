'use strict';
// End-to-end over a real HTTP server, a real socket, and a real fs.watch on a
// throwaway hive. This is the one path unit tests cannot fake: a write to the
// hive must reach a subscribed client as a pushed payload.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');
const { TestWebSocketClient } = require('./helpers/ws-client');
const { LiveHub } = require('../lib/live_hub');
const { AlertEngine } = require('../lib/alerts');

const fixture = makeFixtureHive();
const server = loadServer(fixture.hive);
const internals = server.internals;

let http;
let hub;
let watcher;
let watchTimer;
let clients = [];

// Mirrors index.js's watcher tail: invalidate, diff, push.
function onHiveChanged() {
  watchTimer = null;
  internals.invalidateCaches();
  hub.publish(internals.changedResources(internals.resourceNames()));
}

test.before(async () => {
  http = await startTestServer(server.app);
  hub = new LiveHub({ snapshot: (name) => Promise.resolve(internals.buildSnapshot(name)) });
  hub.attach(http.server);
  // Mirror index.js's watcher: debounce, then push what changed.
  watcher = fs.watch(fixture.hive, { recursive: true }, () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(onHiveChanged, 120);
  });
});

test.after(async () => {
  watcher?.close();
  hub?.close();
  for (const client of clients) client.close();
  await http?.close();
  fixture.cleanup();
});

async function connect() {
  const client = await TestWebSocketClient.connect(http.port);
  clients.push(client);
  await client.waitForType('hello');
  return client;
}

test('a write to the hive is pushed to a subscribed client', async () => {
  const client = await connect();
  client.send({ type: 'subscribe', keys: ['queue', 'projects'] });
  await client.waitForType('subscribed');
  await client.waitFor((m) => m.type === 'resource' && m.key === 'queue');
  client.messages.length = 0;

  // Change the hive: two new tasks.
  const tasksFile = path.join(fixture.hive, 'tasks.json');
  const doc = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  doc.tasks.push(
    { task_id: 't-new-1', title: 'fresh', status: 'QUEUED', created_at: new Date().toISOString() },
    { task_id: 't-new-2', title: 'fresh', status: 'QUEUED', created_at: new Date().toISOString() },
  );
  fs.writeFileSync(tasksFile, JSON.stringify(doc, null, 2));

  const pushed = await client.waitFor((m) => m.type === 'resource' && m.key === 'queue', 8000);
  assert.equal(pushed.payload.total, 7, 'the pushed payload reflects the new tasks');
  assert.equal(pushed.payload.queued, 4);
});

test('an unchanged hive produces no further pushes', async () => {
  const client = await connect();
  client.send({ type: 'subscribe', keys: ['queue'] });
  await client.waitFor((m) => m.type === 'resource' && m.key === 'queue');
  client.messages.length = 0;

  // Touch a file with identical content: mtime changes, the signature does not.
  const projectsFile = path.join(fixture.hive, 'projects.json');
  const before = fs.readFileSync(projectsFile, 'utf8');
  fs.writeFileSync(projectsFile, before);
  await new Promise((resolve) => setTimeout(resolve, 900));

  const queuePushes = client.messages.filter((m) => m.type === 'resource' && m.key === 'queue');
  assert.equal(queuePushes.length, 0, 'an unchanged resource must not be re-pushed');
});

test('the alert engine publishes new alerts over the socket', async () => {
  const client = await connect();
  const engine = new AlertEngine({
    read: () => ({
      summary: { agents: [{ id: 'ghost', name: 'Ghost', display: 'busy', archived: false, breaker: 'healthy', lastSeen: new Date(Date.now() - 3600000).toISOString() }] },
      queue: null, breakers: { breakers: {} }, costs: null, services: { services: [] },
    }),
    intervalMs: 0,
  });
  engine.evaluate();
  hub.publishAlerts(engine.snapshotList());

  const message = await client.waitForType('alerts');
  const alert = message.alerts.find((a) => a.fingerprint === 'stall:ghost');
  assert.ok(alert, 'the stalling agent should be reported');
  assert.equal(alert.severity, 'critical');
  assert.equal(alert.acknowledged, false);
  engine.stop();
});

test.after(() => { setImmediate(() => process.exit(process.exitCode ?? 0)); });
