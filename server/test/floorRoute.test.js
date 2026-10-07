/**
 * GET /api/floors -- the probe-grade floor route.
 *
 * The assertions here are about honesty, not plumbing. A floor route that
 * quietly returns twelve healthy rows when the probe is absent is worse than no
 * route at all, because it looks like a measurement.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const floorRoute = require('../floor_route');
const { FLOOR_IDS } = require('../floor_health');

function fakeApp() {
  const handlers = new Map();
  return {
    _router: { stack: [] },
    get(p, h) { handlers.set(p, h); },
    handler(p) { return handlers.get(p); },
  };
}

function call(app, p) {
  const res = {
    _json: null,
    _headers: {},
    set(k, v) { this._headers[k] = v; },
    json(v) { this._json = v; },
  };
  return Promise.resolve(app.handler(p)({}, res)).then(() => res);
}

/** A hive with no probe at all: the shape of this laptop right now. */
function hiveWithoutProbe() {
  const hive = fs.mkdtempSync(path.join(os.tmpdir(), 'floors-noprobe-'));
  fs.mkdirSync(path.join(hive, 'lib'), { recursive: true });
  return hive;
}

test('the route is registered once, not once per require', () => {
  const app = fakeApp();
  floorRoute.register(app);
  const first = app.handler('/api/floors');
  floorRoute.register(app);
  const second = app.handler('/api/floors');
  assert.equal(typeof first, 'function');
  assert.equal(typeof second, 'function');
  assert.equal(app._floorRoutes, true);
});

test('register refuses anything that is not an app', () => {
  assert.throws(() => floorRoute.register(null), /needs an express app/);
  assert.throws(() => floorRoute.register({}), /needs an express app/);
});

test('a hive with no probe reports every floor UNKNOWN and never claims health', async () => {
  floorRoute.resetFloorCache();
  const payload = await floorRoute.getFloorRoutePayload({ hive: hiveWithoutProbe() });
  assert.equal(payload.not_verified, true, 'a missing probe must be flagged unverified');
  assert.equal(payload.source, 'unavailable');
  assert.equal(payload.floors.length, FLOOR_IDS.length, 'every floor still appears');
  for (const f of payload.floors) {
    assert.equal(f.state, 'UNKNOWN');
    assert.equal(f.manager_alive, false);
    assert.match(f.reason, /missing/, 'each UNKNOWN floor says why');
  }
  // The whole point: an absent floor must never render as a healthy one.
  assert.ok(!Object.values(payload.summary).includes('IDLE'));
  assert.ok(!Object.values(payload.summary).includes('working'));
});

/**
 * A hive whose probe answers, but only partially -- one floor of twelve.
 *
 * This is the case that matters for the truth contract: a missing floor in a
 * table reads as "no such floor", which is a different claim from "cannot
 * confirm". The real probe is a subprocess, so the partial is produced by a real
 * subprocess rather than by stubbing the reader out.
 */
function hiveWithPartialProbe(rows) {
  const hive = fs.mkdtempSync(path.join(os.tmpdir(), 'floors-partial-'));
  fs.mkdirSync(path.join(hive, 'lib'), { recursive: true });
  // The payload is embedded as a JSON *string* and round-tripped, because
  // JSON's `true`/`null` are not Python literals and pasting them straight into
  // source produces a NameError -- which the route would then report as a probe
  // failure, passing this test for entirely the wrong reason.
  fs.writeFileSync(
    path.join(hive, 'lib', 'floor_health.py'),
    `import json\nprint(json.dumps(json.loads(${JSON.stringify(JSON.stringify(rows))})))\n`,
  );
  return hive;
}

test('a probe reporting one floor is padded to all twenty-two, and the gaps say why', async () => {
  floorRoute.resetFloorCache();
  const hive = hiveWithPartialProbe([
    { floor: 'f1', state: 'BUSY', manager_alive: true, task_counts: { COMP: 3 } },
  ]);
  const payload = await floorRoute.getFloorRoutePayload({ hive });
  assert.equal(payload.not_verified, false, 'a working probe is explicitly verified, not merely absent');
  assert.equal(payload.floors.length, FLOOR_IDS.length, 'the partial was padded to the full set');

  const f1 = payload.floors.find((f) => f.floor === 'f1');
  assert.equal(f1.state, 'BUSY', 'the reported floor keeps its state');
  assert.equal(f1.manager_alive, true);

  for (const f of payload.floors.filter((x) => x.floor !== 'f1')) {
    assert.equal(f.state, 'UNKNOWN', `${f.floor} must not inherit a healthy state`);
    assert.match(f.reason, /not reported/, `${f.floor} says it was not reported`);
  }
  assert.deepEqual(payload.summary, { BUSY: 1, UNKNOWN: 21 });
});

test('a probe that fails loudly is reported as unverified, not swallowed', async () => {
  floorRoute.resetFloorCache();
  const hive = fs.mkdtempSync(path.join(os.tmpdir(), 'floors-broken-'));
  fs.mkdirSync(path.join(hive, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(hive, 'lib', 'floor_health.py'),
    'import sys\nsys.stderr.write("probe exploded\\n")\nsys.exit(3)\n',
  );
  const payload = await floorRoute.getFloorRoutePayload({ hive });
  assert.equal(payload.not_verified, true);
  assert.equal(payload.source, 'error');
  assert.match(payload.floors[0].reason, /floor health probe failed/);
});

test('counts come from the same read as floors, so they cannot disagree', () => {
  floorRoute.resetFloorCache();
  const payload = floorRoute.readFloors(hiveWithoutProbe());
  assert.deepEqual(Object.keys(payload.counts).sort(), payload.floors.map((f) => f.floor).sort());
  for (const f of payload.floors) {
    const c = payload.counts[f.floor];
    assert.ok(c, `${f.floor} has a count entry`);
    assert.equal(c.state, f.state, 'count state is the floor state');
    assert.equal(c.degraded, true, 'UNKNOWN is a degraded state to read');
  }
});

test('a read is memoised so repeated calls cannot disagree or re-spawn', async () => {
  floorRoute.resetFloorCache();
  const hive = hiveWithoutProbe();
  const a = await floorRoute.getFloorRoutePayload({ hive });
  const b = await floorRoute.getFloorRoutePayload({ hive });
  assert.deepEqual(a, b, 'two reads inside the window are the same answer');
});

test('the payload is served with no-store and as JSON', async () => {
  floorRoute.resetFloorCache();
  const app = fakeApp();
  floorRoute.register(app);
  const res = await call(app, '/api/floors');
  assert.equal(res._headers['Cache-Control'], 'no-store');
  assert.ok(res._json, 'responded with a body');
  assert.equal(typeof res._json.not_verified, 'boolean');
});