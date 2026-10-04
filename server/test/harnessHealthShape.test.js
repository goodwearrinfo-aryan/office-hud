// getHarnessHealth must return the same keys whether the probe succeeds or fails.
//
// The failure this prevents was intermittent and load-dependent. Under the full
// suite the harness took 2.578s to answer /health, which exceeded the 2s
// AbortSignal in getHarnessHealth, so the catch branch returned a payload with
// no degradedProviders key while the success branch had one. Consequences:
//
//   - resources.test.js failed on "/api/harness/health and /api/live/harness
//     must expose the same top-level fields", reproducibly in the full suite
//     and never when the file ran alone.
//   - A panel that reads the field conditionally would render a different card
//     for a slow response than for a fast one. That is the part that matters:
//     the same resource changing shape depending on latency is a HUD lying
//     about its own contract.
//
// Both branches are exercised here directly, with no network involved, so this
// is deterministic rather than timing-dependent.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const INTERNALS_URL = '../index.js';

/**
 * Pull getHarnessHealth out of the module without booting a server.
 * It is reached through the same require path the harness uses, so the source
 * under test is the file that runs.
 */
function loadGetHarnessHealth() {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const server = require(INTERNALS_URL);
  return server.internals && server.internals.getHarnessHealth;
}

test('getHarnessHealth is exported for direct testing', () => {
  const fn = loadGetHarnessHealth();
  assert.equal(typeof fn, 'function',
    'getHarnessHealth must be reachable from internals so its two return shapes can be compared');
});

test('both return paths expose the same keys', async (t) => {
  const fn = loadGetHarnessHealth();
  if (typeof fn !== 'function') return t.skip('getHarnessHealth is not exported yet');

  // Success path: the stub answers 200 with a provider payload.
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ status: 'ok', provider: 'nim', model: 'm', degraded_providers: ['x'] }),
  });
  const healthy = await fn();

  // Failure path: the stub rejects the way an expired AbortSignal does.
  global.fetch = async () => { throw new Error('The operation was aborted due to timeout'); };
  const offline = await fn();

  assert.deepEqual(
    Object.keys(healthy).sort(),
    Object.keys(offline).sort(),
    'a slow harness and a fast harness must expose the same keys; a resource that '
      + 'changes shape with latency breaks any consumer that reads it conditionally',
  );

  // The values must still tell the truth about which state we are in.
  assert.equal(healthy.ok, true);
  assert.equal(healthy.status, 'ok');
  assert.deepEqual(healthy.degradedProviders, ['x']);

  assert.equal(offline.ok, false);
  assert.equal(offline.status, 'offline');
  assert.deepEqual(offline.degradedProviders, [],
    'an unmeasured provider list is an empty list, not a missing field');
  assert.match(String(offline.error), /abort/i);
});
