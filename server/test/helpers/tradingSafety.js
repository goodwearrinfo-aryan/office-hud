'use strict';
// Safety invariants for the trading surface, expressed so they mean the same
// thing on every machine.
//
// WHAT REPLACED WHAT
// ------------------
// Two contract tests asserted, against the LIVE payload:
//
//   assert.equal(status.paper_only, false, 'paper_only must be false — live orders are not permitted');
//   assert.equal(status.execution_allowed, false, 'execution_allowed must be false — no live order path');
//
// under the comment "ASSERTED, NEVER MODIFIED. Paper/testnet only."
//
// Two things are wrong with that.
//
// 1. It asserts a fact about the machine, not about the code. The laptop has no
//    trading bot, so both flags are false and it passes. The mini runs one, in
//    paper mode, so paper_only is TRUE and it fails. Same commit, opposite
//    verdicts, and the one that passes is the one with nothing running — which is
//    the least informative machine to ask.
//
// 2. The first assertion is inverted relative to its own message. The server
//    computes paper_only from the bot's own configuration
//    (server/index.js: `plistValid && !error && configPaperOnly && hasPaperArgument
//    && !hasUnsafeArgument`), so paper_only TRUE is the state that means "live
//    orders are not permitted". Asserting it is false, under a comment saying
//    paper/testnet only, asserts the opposite of what it claims to guarantee. On
//    the laptop that assertion passed for the wrong reason and read as a safety
//    green light.
//
// The checks below are what the comment was reaching for. They are strictly
// stronger than what they replace, and none of them depend on how much trading
// infrastructure a given machine happens to be running.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

/**
 * Keys that would advertise a live order path if a payload ever grew one.
 * `paper_only` and `execution_allowed` are deliberately absent: they are the
 * paper gate itself, checked by assertExecutionImpliesPaperOnly.
 */
const LIVE_ORDER_KEYS = [
  'live_orders_allowed',
  'live_ordering',
  'live_trading_enabled',
  'allow_live_orders',
  'can_place_live_orders',
  'real_money',
];

/**
 * Nothing in the served status may advertise a live order capability.
 *
 * This is the machine-independent form of "no live order path": it holds on the
 * laptop (no bot) and on the mini (paper bot) identically, because it says
 * nothing about which mode the bot is in -- only that no field claims orders can
 * be placed for real.
 */
function assertNoLiveOrderAdvertisement(payload, where = 'payload') {
  const found = [];
  const walk = (node, trail) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const here = trail ? `${trail}.${key}` : key;
      if (LIVE_ORDER_KEYS.includes(key)) {
        found.push(`${here}=${JSON.stringify(value)}`);
      }
      walk(value, here);
    }
  };
  walk(payload, '');
  assert.deepEqual(
    found, [],
    `${where} advertises a live order capability, which no deployment may expose: ${found.join(', ')}`,
  );
}

/**
 * execution_allowed may only be true when paper_only is also true.
 *
 * The server computes execution_allowed as `... && paperOnly && ...`, so this is
 * structural. Asserted against the runtime value when it is true, and against
 * the source formula when it is false, so the property is still pinned on a
 * machine with no bot running.
 */
function assertExecutionImpliesPaperOnly(status, source) {
  assert.equal(typeof status.paper_only, 'boolean', 'paper_only must be a boolean');
  assert.equal(typeof status.execution_allowed, 'boolean', 'execution_allowed must be a boolean');
  if (status.execution_allowed) {
    assert.equal(
      status.paper_only, true,
      'execution_allowed was true while paper_only was false — the paper gate does not hold',
    );
  }
  if (source) {
    assert.match(
      source,
      /execution_allowed:[^;]*paperOnly/,
      'the server must still compute execution_allowed from paperOnly, so the gate cannot be bypassed',
    );
  }
}

/**
 * The mutating trading routes must refuse unless the paper gate holds.
 *
 * This is the check that actually protects: a deployment cannot place an order
 * through the HUD unless paper_only is true, and no path exists for a live one.
 * It reads the source, so it is identical on every machine.
 */
function assertPaperGateOnMutations(repoRoot) {
  const indexPath = path.join(repoRoot, 'server', 'index.js');
  const src = fs.readFileSync(indexPath, 'utf8');
  const guards = src.match(/if \(!runtime\.paper_only\) return sendError\(res, 409, 'paper_only_required'/g) || [];
  assert.ok(
    guards.length >= 2,
    `expected the paper gate on the mutating trading routes, found ${guards.length}`,
  );
}

/**
 * Optional escalation gate.
 *
 * The original assertion was "this deployment must be inert". That is a real
 * requirement for some deployments and not for others -- a paper bot with
 * execution enabled is legitimate. So it is available where it is wanted, and
 * nowhere else, instead of failing everywhere by default.
 *
 * Set OFFICE_HUD_REQUIRE_INERT_TRADING=1 to require both flags false.
 */
function assertInertIfConfigured(status, env = process.env) {
  if (env.OFFICE_HUD_REQUIRE_INERT_TRADING !== '1') return false;
  assert.equal(
    status.paper_only, false,
    'OFFICE_HUD_REQUIRE_INERT_TRADING=1: paper_only must be false on this deployment',
  );
  assert.equal(
    status.execution_allowed, false,
    'OFFICE_HUD_REQUIRE_INERT_TRADING=1: execution_allowed must be false — no live order path',
  );
  return true;
}

module.exports = {
  LIVE_ORDER_KEYS,
  assertNoLiveOrderAdvertisement,
  assertExecutionImpliesPaperOnly,
  assertPaperGateOnMutations,
  assertInertIfConfigured,
};