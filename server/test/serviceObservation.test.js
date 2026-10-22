// The laptop HUD cannot see services that bind 127.0.0.1 on the mini, so it
// reported Free harness :8080, WebSocket :8081, Trading bot :8765 and Cloudflared
// :20241 as offline every 30 minutes while the mini's own health endpoint said all
// four were online. Rows marked `via: 'mini'` are therefore read from the mini HUD.
//
// Two properties are held here: the config key `via` must never leak into the
// payload, and every row must expose the same keys whether it was probed locally or
// projected from the mini -- a row that changes shape by observation path is the
// same class of bug harnessHealthShape.test.js guards on /api/harness/health.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const server = require('../index.js');
const I = server.internals;

const ROW_KEYS = ['attempts', 'error', 'latencyMs', 'name', 'observedVia', 'port', 'role', 'status'];

function miniPayload(status = 'online') {
  return {
    byPort: new Map(I.SERVICE_PORTS.filter(s => s.via === 'mini').map(s => [
      s.port,
      { port: s.port, status, latencyMs: 7, error: status === 'online' ? null : 'ECONNREFUSED', attempts: 1 },
    ])),
    error: null,
    latencyMs: 12,
  };
}

test('mini-hosted rows are marked, and only those', () => {
  const marked = I.SERVICE_PORTS.filter(s => s.via === I.SERVICE_OBSERVED_VIA.mini).map(s => s.port);
  assert.deepEqual(marked.sort(), [20241, 8080, 8081, 8765],
    'the four false negatives must be read from the mini; forwarded ports stay local');
});

test('publicServiceFields drops the config key so it cannot reach the payload', () => {
  const row = I.publicServiceFields({ name: 'x', port: 1, role: 'r', via: 'mini' });
  assert.deepEqual(Object.keys(row).sort(), ['name', 'port', 'role']);
});

test('a mini row that answered keeps the same keys as any other row', () => {
  for (const service of I.SERVICE_PORTS) {
    const projected = I.projectMiniServiceRow(service, miniPayload());
    assert.deepEqual(Object.keys(projected).sort(), ROW_KEYS, `${service.name} must expose the row contract`);
    assert.equal(projected.observedVia, 'mini');
  }
});

test('a port missing from the mini payload is offline, never silently healthy', () => {
  const service = { name: 'Ghost', port: 9999, role: 'none', via: 'mini' };
  const row = I.projectMiniServiceRow(service, miniPayload());
  assert.equal(row.status, 'offline');
  assert.equal(row.error, 'not-observed-by-mini-hud');
});

test('getServiceHealth reports mini services online even when this host cannot reach them', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const harness = I.SERVICE_PORTS.find(s => s.port === 8080);
  global.fetch = async (url) => {
    assert.equal(String(url), I.MINI_HUD_HEALTH_URL, 'mini rows must come from the mini HUD forward');
    const services = I.SERVICE_PORTS.filter(s => s.via === 'mini')
      .map(s => ({ port: s.port, status: 'online', latencyMs: 3, error: null, attempts: 1 }));
    return { ok: true, json: async () => ({ host: 'Mac', services }) };
  };

  const health = await I.getServiceHealth();
  const byPort = new Map(health.services.map(s => [s.port, s]));

  assert.equal(health.services.length, I.SERVICE_PORTS.length, 'every configured row must still be answered');
  for (const service of I.SERVICE_PORTS) {
    assert.equal(byPort.has(service.port), true, `${service.name} must never be dropped from the payload`);
  }
  assert.equal(byPort.get(8080).status, 'online', 'a live mini service must not read as offline on the laptop');
  assert.equal(byPort.get(8080).observedVia, 'mini');
  assert.equal(byPort.get(harness.port).role, 'OpenAI API');
  assert.deepEqual(Object.keys(byPort.get(8080)).sort(), ROW_KEYS);
  assert.equal(byPort.get(11434).observedVia, 'local', 'Ollama is probed here as before');
});

async function listenOn(host, t) {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, host, resolve);
  });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  return listener.address().port;
}

// The Bridge forward came up bound to ::1 with nothing on 127.0.0.1, and the IPv4-only
// probe filed it as a supervised outage. Either loopback family answering is online.
test('a listener bound only to the IPv6 loopback is online, not an outage', async (t) => {
  const port = await listenOn('::1', t);
  const row = await I.checkServicePort({ name: 'IPv6-only forward', port, role: 'test' });
  assert.equal(row.status, 'online', 'a service reachable on ::1 must not read as down');
  assert.equal(row.error, null);
  assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, 'a local row keeps the row contract');
});

test('a listener bound only to the IPv4 loopback still reads online', async (t) => {
  const port = await listenOn('127.0.0.1', t);
  const row = await I.checkServicePort({ name: 'IPv4-only', port, role: 'test' });
  assert.equal(row.status, 'online');
});

test('a closed port is offline and says why', async () => {
  const row = await I.checkServicePort({ name: 'unclaimed', port: 1, role: 'test' });
  assert.equal(row.status, 'offline');
  assert.ok(row.error, 'an offline row must carry a reason');
  assert.equal(row.attempts, 2, 'SERVICE_PROBE_ATTEMPTS probes, never more');
});

// getServiceHealth passed the row index into checkServicePort as `attempt`, so every
// row after the first skipped its retry and published attempts equal to its position.
test('probe attempts are per row, not inherited from the row index', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => { throw new Error('forward dead'); };

  const health = await I.getServiceHealth();
  assert.equal(health.services.every(s => s.observedVia === 'local'), true,
    'with no mini forward every row falls back to a local probe');
  for (const row of health.services) {
    assert.ok(row.attempts <= 2, `${row.name} reported attempts=${row.attempts} after at most 2 probes`);
  }
});
