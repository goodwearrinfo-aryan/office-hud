// The HUD must not call a degeneracy filter "real work".
//
// THE DEFECT, MEASURED
// --------------------
// index.js computed:
//
//     const realWorkRatePct = scanned > 0
//       ? Math.round(((tally.OK || 0) / scanned) * 1000) / 10
//       : null;
//
// and /api/verify returned `realWorkRatePct: 100` on the live hive. The verdicts
// come from hive/lib/verify.py, whose own docstring says OK means "substantive
// answer" -- i.e. not junk, not a failure marker, not a refusal. It says nothing
// about whether work happened.
//
// Reading hive/verify_state.json directly confirmed the gap: its only keys were
// at, first_strike, off_topic, quarantined, requeued and verdict_tally. It
// contained no commit, artifact, verifier, sha, proof, deployment or independent
// field of any kind. A metric reading 100% while its own evidence file contains
// no evidence is worse than no metric, because it looks like a reason to scale.
//
// WHAT IS ASSERTED
// ----------------
// 1. No field is named realWork, and no real-work rate is published. The ratio
//    that does exist is named for what it measures.
// 2. The numerator and denominator are both published, so the rate cannot be
//    read without its population.
// 3. verifiedWork is null -- "not measured" -- rather than 0 (a claim that
//    nothing was verified) or 100 (the original lie).
// 4. verificationBasis states why it is unmeasured, so null is not mistaken for a
//    missing value.
// 5. The synthetic case from the brief: many OK verdicts and no artifacts must
//    NOT produce a high verified-work number. This is the negative control the
//    original implementation failed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

/** Write a verify_state.json with the given verdict tally into a fixture hive. */
function hiveWithVerdicts(tally) {
  const fixture = makeFixtureHive();
  fs.writeFileSync(
    path.join(fixture.hive, 'verify_state.json'),
    JSON.stringify({
      at: new Date().toISOString(),
      verdict_tally: tally,
      requeued: [],
      quarantined: [],
    }),
  );
  return fixture;
}

async function verifyStateFor(tally) {
  const fixture = hiveWithVerdicts(tally);
  const server = loadServer(fixture.hive);
  const http = await startTestServer(server.app);
  try {
    const res = await http.get('/api/verify');
    assert.equal(res.status, 200);
    return res.json;
  } finally {
    await http.close();
    fixture.cleanup();
  }
}

test('the payload publishes no real-work rate', async () => {
  const v = await verifyStateFor({ OK: 603 });

  assert.equal(
    v.realWorkRatePct, undefined,
    'realWorkRatePct must not exist: it is a degeneracy filter presented as real work',
  );
  const serialised = JSON.stringify(v);
  for (const banned of ['realWorkRate', 'realWork']) {
    assert.ok(
      !new RegExp(`"${banned}`).test(serialised),
      `no key may begin with ${banned}; a real-work rate needs an independent `
        + 'verifier and a durable artifact, neither of which this pipeline has',
    );
  }
});

test('the published rate is named for what it measures, with both halves shown', async () => {
  const v = await verifyStateFor({ OK: 603 });

  assert.equal(v.outputQualityRatePct, 100,
    '603 of 603 results were not junk, which is what this ratio actually means');
  assert.equal(v.verdict_tally_total, 603,
    'the denominator must be published, or the rate cannot be reasoned about');
  assert.equal(v.verdict_tally.OK, 603, 'the numerator is published in the tally');
});

test('verified work is reported as unmeasured, not as zero and not as high', async () => {
  // The brief's synthetic case: 600 COMPLETE, 604 OK verdicts, 2 valid artifacts.
  // With no artifact ledger, none of those OK verdicts is verified work, and the
  // honest answer is that the figure is not measured at all.
  const v = await verifyStateFor({ OK: 604 });

  assert.equal(v.verifiedWork, null,
    'null means "not measured"; 0 would claim nothing was verified and a number '
      + 'would claim verification that never happened');
  assert.equal(v.verifiedWorkDenominator, null,
    'with no numerator there is no meaningful denominator either');
  assert.equal(v.verificationCoverage, null, 'coverage is unknown, not zero');
  assert.match(v.verificationBasis, /no independent verifier/,
    'the reason must be stated, so null is not mistaken for a missing value');
});

test('many OK verdicts and no artifacts cannot produce a high verified-work number', async () => {
  // The negative control the original implementation failed. Every verdict is
  // "OK" and the state file carries no artifact field at all.
  const v = await verifyStateFor({ OK: 10000 });
  assert.equal(v.outputQualityRatePct, 100, 'output quality is genuinely 100% here');
  const numeric = [v.verifiedWork, v.verifiedWorkDenominator, v.verificationCoverage]
    .filter((x) => typeof x === 'number');
  assert.deepEqual(numeric, [],
    'no numeric verified-work field may exist while nothing verifies anything');
});

test('a mixed tally reports the output-quality ratio, not a pass rate of everything', async () => {
  const v = await verifyStateFor({ OK: 90, DODGE: 5, SHORT: 3, FAIL: 1, EMPTY: 1 });
  assert.equal(v.verdict_tally_total, 100);
  assert.equal(v.outputQualityRatePct, 90, '90 of 100 results were not junk');
  assert.equal(v.verifiedWork, null, 'output quality says nothing about verification');
});

test('an absent verify_state.json is still reported as not present', async () => {
  const fixture = makeFixtureHive();
  const server = loadServer(fixture.hive);
  const http = await startTestServer(server.app);
  try {
    const res = await http.get('/api/verify');
    assert.equal(res.status, 200);
    assert.equal(res.json.present, false, 'no state file means not present, not zero');
    assert.equal(res.json.outputQualityRatePct, undefined,
      'nothing is claimed when there is nothing to measure');
  } finally {
    await http.close();
    fixture.cleanup();
  }
});
