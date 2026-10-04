'use strict';
// The trading-safety helper replaces two assertions that inverted paper_only and
// asserted a property of the machine rather than of the code. That is subtle
// enough to regress silently, so the replacements are pinned here directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  LIVE_ORDER_KEYS,
  assertNoLiveOrderAdvertisement,
  assertExecutionImpliesPaperOnly,
  assertPaperGateOnMutations,
  assertInertIfConfigured,
} = require('./helpers/tradingSafety');

const clean = { paper_only: true, execution_allowed: true, running: true, pid: 42 };

test('a status advertising no live order path passes', () => {
  assertNoLiveOrderAdvertisement(clean);
  assert.doesNotThrow(() => assertExecutionImpliesPaperOnly(clean));
});

test('any field advertising live orders is caught, at any depth', () => {
  for (const key of LIVE_ORDER_KEYS) {
    const payload = { ...clean, runtime: { nested: { deeper: { [key]: true } } } };
    assert.throws(
      () => assertNoLiveOrderAdvertisement(payload),
      new RegExp(key),
      `${key} must be refused wherever it appears`,
    );
  }
});

test('a false value for a live-order key is still an advertisement', () => {
  // The key existing at all is the finding: the codebase forbids it, so a payload
  // carrying it is telling a reader something the HUD must never claim. Only
  // `undefined` is acceptable, and that is absence rather than a claim.
  assert.throws(() => assertNoLiveOrderAdvertisement({ ...clean, live_orders_allowed: false }));
});

test('execution_allowed true with paper_only false is refused', () => {
  assert.throws(
    () => assertExecutionImpliesPaperOnly({ ...clean, paper_only: false }),
    /paper gate does not hold/,
  );
});

test('the paper gate is present in the server source', () => {
  assert.doesNotThrow(() => assertPaperGateOnMutations(path.join(__dirname, '..', '..')));
});

test('the inert requirement is opt-in, and then it is enforced', () => {
  // Off by default: a paper bot with execution enabled is a legitimate deployment,
  // and asserting otherwise made the suite machine-dependent.
  assert.equal(assertInertIfConfigured(clean, {}), false);
  // On when asked, and then it fails a deployment that is not inert.
  assert.throws(
    () => assertInertIfConfigured(clean, { OFFICE_HUD_REQUIRE_INERT_TRADING: '1' }),
    /must be false/,
  );
  assert.equal(
    assertInertIfConfigured({ paper_only: false, execution_allowed: false }, { OFFICE_HUD_REQUIRE_INERT_TRADING: '1' }),
    true,
  );
});

test('a non-boolean flag is refused outright', () => {
  assert.throws(() => assertExecutionImpliesPaperOnly({ paper_only: 'yes', execution_allowed: false }), /boolean/);
});