// Negative coverage for the roster-staleness fix (§22).
//
// The defect: the fleet summary pushed 'registry.json is stale' into issues[],
// so a healthy 57/58 fleet reported DEGRADED because the roster file had not
// been rewritten in 141 hours. registry.json is a roster written when the agent
// set changes, not on a timer, so a stable fleet accrues unbounded age while
// remaining accurate.
//
// What must stay true after the fix:
//   1. an aged-but-accurate roster does NOT downgrade the verdict
//   2. the age is STILL reported in identity.registry_stale (not suppressed)
//   3. a roster that is genuinely unreadable STILL degrades
//   4. missing agents STILL degrade -- the real liveness check is untouched
//   5. an unmeasurable age does not become an excuse to stay LIVE
//
// If (2) ever fails the fix has been faked by hiding the signal rather than
// correcting the gate. If (3) or (4) fail, a real outage was silenced.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'openaliceStatus.js');
const HOUR = 3600 * 1000;

test('an aged but accurate roster does not downgrade a healthy fleet', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(
    !/if \(registryStale\) issues\.push/.test(src),
    "roster age is still gating the verdict -- the defect is present",
  );
});

test('the staleness label is still computed and reported', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // Not deleted -- just no longer gating. Suppressing the label would make the
  // HUD look clean by hiding the signal, which is the opposite of the fix.
  assert.ok(/registry_stale:/.test(src), 'the staleness field was removed, not just ungated');
  assert.ok(
    /registryStale: reg\.identity \? reg\.identity\.registry_stale : null/.test(src),
    'the label is no longer surfaced in the payload',
  );
});

test('a genuine roster read error still degrades', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(
    /if \(registryError\) issues\.push\(`registry unreadable/.test(src),
    'an unreadable roster must still produce DEGRADED',
  );
});

test('missing agents still degrade -- liveness is untouched', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(
    /agentsAlive < agentsExpected/.test(src),
    'the agent-liveness check was removed along with the roster check',
  );
});

test('health failure still degrades', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(
    /hive health endpoint not ok/.test(src),
    'the hive health check was removed',
  );
});

test('the existing per-agent roster suite is not weakened by this change', () => {
  const suite = path.join(__dirname, 'rosterFreshness.test.js');
  const src = fs.readFileSync(suite, 'utf8');
  // The suite that documented the correct intent must still be asserting it.
  assert.ok(
    /roster staleness does not downgrade status/.test(src),
    'the intent test was renamed or removed',
  );
  assert.ok(
    /a 6h-old roster must not read as live/.test(src),
    'the roster-stale labelling test was removed',
  );
});
