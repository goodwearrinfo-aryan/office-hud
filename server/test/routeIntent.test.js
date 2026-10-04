'use strict';
/**
 * Every GET route must be claimed by the web build or carry a stated reason.
 *
 * The sweep that prompted this found 19 of 59 GETs with no consumer anywhere:
 * not the web build, not a script. None were broken, so nothing went red. They
 * just accumulated, and the HUD paid for computing them while nobody could see
 * the result. See server/routeIntent.js for why that is worth a file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { routeIntent, classify } = require('../routeIntent');

const ROOT = path.join(__dirname, '..', '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const WEB_DIR = path.join(ROOT, 'web', 'src');

/** Every `app.get('/api/...')` path the server registers. */
function servedPaths() {
  const out = new Set();
  for (const m of INDEX.matchAll(/app\.get\(\s*'(\/api\/[^']+)'/g)) out.add(m[1]);
  for (const m of INDEX.matchAll(/\.get\(\s*'(\/api\/[^']+)'\s*,\s*/g)) out.add(m[1]);
  return [...out].sort();
}

/**
 * Does the web build reference this route?
 *
 * The subtlety is template literals: the web fetches `/api/agents/${id}`, which
 * is the server's `/api/agents/:id`. Compared as strings they do not match, and
 * a naive check reports a route nobody uses while an entire component reads it.
 * So `:param` in the served path matches any single segment in the source.
 */
function makeWebPredicate() {
  const blob = fs.readdirSync(WEB_DIR, { recursive: true })
    .filter((f) => typeof f === 'string' && /\.tsx?$/.test(f))
    .map((f) => fs.readFileSync(path.join(WEB_DIR, f), 'utf8'))
    .join('\n');
  const cache = new Map();
  return (servedPath) => {
    if (cache.has(servedPath)) return cache.get(servedPath);
    // /api/agents/:id -> /api\/agents\/[^\/`"']+
    const source = servedPath
      .split('/')
      .map((seg) => (seg.startsWith(':') ? "[^/\\`\"']+" : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    const re = new RegExp(source);
    const hit = re.test(blob);
    cache.set(servedPath, hit);
    return hit;
  };
}

test('the sweep actually found routes, so the checks below are not vacuous', () => {
  const served = servedPaths();
  assert.ok(served.length > 40, `expected a real API surface, parsed ${served.length}`);
  assert.ok(served.includes('/api/summary'), 'sanity: the parser reads real paths');
  assert.ok(served.includes('/api/agents/:id'), 'sanity: parameterised paths are parsed');
});

test('every GET is claimed by the web or carries a stated reason', () => {
  const referencedByWeb = makeWebPredicate();
  const unstated = servedPaths()
    .map((p) => ({ p, ...classify(p, referencedByWeb) }))
    .filter((r) => r.status === 'unstated')
    .map((r) => r.p);
  assert.deepEqual(
    unstated, [],
    `these GET routes have no web consumer and no stated reason in server/routeIntent.js: ${unstated.join(', ')}`,
  );
});

test('template-literal references count as claimed', () => {
  // The case a naive string compare gets wrong: the web fetches
  // `/api/agents/${godId}` and the server serves `/api/agents/:id`.
  const referencedByWeb = makeWebPredicate();
  assert.equal(referencedByWeb('/api/agents/:id'), true);
});

test('every stated reason says something a reader can act on', () => {
  const referencedByWeb = makeWebPredicate();
  const weak = /^(internal|unused|tbd|none|unknown|internal use)$/i;
  for (const [route, intent] of Object.entries(routeIntent())) {
    assert.ok(intent.reason && intent.reason.length > 40, `${route} needs a real reason`);
    assert.ok(!weak.test(intent.reason.trim()), `${route}'s reason is a non-statement: ${intent.reason}`);
    // A reason that names a future floor must name it in the field too, so the
    // list can be worked through rather than admired.
    if (/belongs|belongs with|goes with/i.test(intent.reason) || /surface/i.test(intent.surface ?? '')) {
      assert.ok(intent.surface, `${route} points at a floor and must say which`);
    }
  }
});

test('the intent registry does not claim routes the server does not serve', () => {
  // A stale entry is worse than none: it reads as a decision about a route that
  // no longer exists, and it hides the fact that the route was removed.
  const served = new Set(servedPaths());
  const orphans = Object.keys(routeIntent()).filter((p) => !served.has(p));
  assert.deepEqual(orphans, [], `routeIntent.js describes routes the server no longer serves: ${orphans.join(', ')}`);
});

test('the unclaimed list is the one this branch actually measured', () => {
  const referencedByWeb = makeWebPredicate();
  const unclaimed = servedPaths().filter((p) => !referencedByWeb(p));
  // 15 at the time of writing: the terminal sub-routes, the REST mirror and its
  // catch-all, the SSE fallback, and the four awaiting-a-floor payloads.
  //
  // It was 19 when the sweep began, and mounting the three orphan panels is why
  // it fell: GodPanel reads /api/agents/:id, AutopilotPanel posts to
  // /api/autopilot/proposals/<id>/land, and AlphaInsiderPanel already fetched
  // /api/alphainsider/positions. Wiring UI up is what consumes routes -- which is
  // the argument for making the remainder visible rather than leaving it silent.
  //
  // The exact count is asserted so a change is noticed instead of absorbed: if a
  // floor starts consuming one, this fails and the stale reason must go with it.
  assert.equal(
    unclaimed.length, 11,
    `expected 15 unconsumed GETs, found ${unclaimed.length}: ${unclaimed.join(', ')}`,
  );
});