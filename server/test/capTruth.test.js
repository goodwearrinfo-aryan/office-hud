'use strict';
// The HUD had no vocabulary for a spending cap, so it could not report that none
// exists. This file is the measurement that made the module necessary.
//
// Traced on the live mini, in order:
//
//   1. There IS a cap on the request path. hive/lib/llm/client.ts calls
//      `this.checkCostLimits(...)` on every LLM call, and deadlineParity.js asserts
//      the method is still present, so it is not dead by accident.
//   2. Its limits come from the agent registry:
//        costLimitUsdPerDay:   a.cost_limit_usd_per_day
//        costLimitUsdPerMonth: a.cost_limit_usd_per_month
//   3. **Zero of the 66 agents in registry.json carry either field.** Measured.
//   4. So `config.costLimitUsdPerDay` is `undefined`, and `undefined && ...` never
//      enters the comparison. The check runs on every request and cannot fire.
//   5. It compares against `this.costTracker`, a Map private to the client instance --
//      a different account from cost.js's `costCache`, and a third from
//      `calculateCostFromUsage`. Three cost paths, no shared ledger.
//   6. The exported `checkCostLimit(agentId, limitUsd, period)` in cost.js has no
//      caller anywhere in the hive.
//   7. The summary payload carries no cap field, so the floor had nothing to render.
//
// Each test below is one of those facts, expressed as a rule the HUD must keep.

const test = require('node:test');
const assert = require('node:assert/strict');

const { capVerdict, fleetCapVerdict, NO_CAP, WITHIN, EXCEEDED, UNKNOWN } = require('../capTruth.js');

const unmeasuredRecord = () => ({
  model: 'free-harness-auto', provider: 'FreeHarness',
  promptTokens: null, completionTokens: null, costUsd: null, taskId: 'todo-x',
});

test('no cap configured is its own verdict, never "within"', () => {
  const v = capVerdict({ limitUsd: undefined, period: 'daily', measurementVerdict: 'measured', measuredSpend: 0 });
  assert.equal(v.verdict, NO_CAP);
  assert.notEqual(v.verdict, WITHIN);
  assert.equal(v.may_show_within, false, 'absence of a cap must never render as compliance');
  assert.equal(v.limit_usd, null);
  assert.match(v.reason, /No daily spending cap is set/);
  assert.match(v.reason, /cannot fire/, 'says what the missing cap means operationally');
});

test('a zero cap value is a real cap, not a missing one', () => {
  // `config.costLimitUsdPerDay && ...` in client.ts means a 0 limit is falsy and is
  // silently ignored upstream. The HUD must not repeat that: 0 is a ceiling.
  const v = capVerdict({ limitUsd: 0, period: 'daily', measurementVerdict: 'measured', measuredSpend: 0 });
  assert.equal(v.verdict, EXCEEDED);
  assert.equal(v.limit_usd, 0);
});

test('an unmeasured spend is never within the cap', () => {
  // The rule the whole file exists for: absence of a measurement must not become
  // compliance, or a cap reports silence as safety.
  for (const measurementVerdict of ['unmeasured', 'no_records', 'partial']) {
    const v = capVerdict({ limitUsd: 10, period: 'daily', measurementVerdict, measuredSpend: 0 });
    assert.equal(v.verdict, UNKNOWN, `${measurementVerdict} must not be within`);
    assert.notEqual(v.verdict, WITHIN);
    assert.equal(v.may_show_within, false);
    assert.match(v.reason, /unknown/i, 'every unmeasured branch says the state is unknown');
  }
});

test('a measured spend is compared, and the verdict names the numbers', () => {
  const under = capVerdict({ limitUsd: 10, period: 'daily', measurementVerdict: 'measured', measuredSpend: 2.5 });
  assert.equal(under.verdict, WITHIN);
  assert.equal(under.may_show_within, true);
  assert.match(under.reason, /\$2\.50 measured against a daily cap of \$10\.00/);

  const over = capVerdict({ limitUsd: 1, period: 'daily', measurementVerdict: 'measured', measuredSpend: 2.5 });
  assert.equal(over.verdict, EXCEEDED);
  assert.equal(over.may_show_within, false);
});

test('spend exactly at the cap is exceeded, not within', () => {
  // `>=` in the hive's check. Boundary behaviour worth pinning so the HUD and the
  // gate do not disagree about the same number.
  assert.equal(capVerdict({ limitUsd: 5, period: 'daily', measurementVerdict: 'measured', measuredSpend: 5 }).verdict, EXCEEDED);
});

test('a nonsense limit is unknown rather than ignored', () => {
  for (const limitUsd of ['lots', -1, NaN, Infinity]) {
    const v = capVerdict({ limitUsd, period: 'daily', measurementVerdict: 'measured', measuredSpend: 1 });
    assert.equal(v.verdict, UNKNOWN, `${String(limitUsd)} must not pass as a cap`);
    assert.equal(v.may_show_within, false);
  }
});

test('a missing measurement with no cap is still no_cap, not unknown', () => {
  // No cap is a stronger and more actionable statement than "cannot evaluate".
  const v = capVerdict({ limitUsd: null, measurementVerdict: 'unmeasured' });
  assert.equal(v.verdict, NO_CAP);
});

test('this hive: every agent has no cap, and that is the fleet verdict', () => {
  // 66 agents in registry.json, 0 carrying cost_limit_usd_per_day. The 27 cost records
  // are unpriced, so even a configured cap could not be evaluated.
  const agents = {};
  for (let i = 0; i < 63; i += 1) agents[`agent-${i}`] = { daily: 0, records: [] };
  agents['office-manager'] = { daily: 0, records: Array.from({ length: 16 }, unmeasuredRecord) };
  agents['mainbot'] = { daily: 0, records: Array.from({ length: 8 }, unmeasuredRecord) };
  agents['specialist-01'] = { daily: 0, records: Array.from({ length: 3 }, unmeasuredRecord) };

  const fleet = fleetCapVerdict({ agents }, {});   // no agent carries a cap field
  assert.equal(fleet.verdict, NO_CAP);
  assert.equal(fleet.agents, 66);
  assert.equal(fleet.with_cap, 0);
  assert.equal(fleet.exceeded, 0);
  assert.match(fleet.reason, /No agent in this hive sets a spending cap/);
  assert.match(fleet.reason, /cannot fire/);
  assert.equal(fleet.per_agent.length, 66);
});

test('a cap that exists but cannot be evaluated reports unknown, not within', () => {
  const agents = { 'office-manager': { daily: 0, records: [unmeasuredRecord()] } };
  const fleet = fleetCapVerdict({ agents }, { 'office-manager': { daily_usd: 5 } });
  assert.equal(fleet.verdict, UNKNOWN);
  assert.equal(fleet.with_cap, 1);
  assert.equal(fleet.unknown, 1);
  assert.match(fleet.reason, /unmeasured/);
  assert.equal(fleet.per_agent[0].daily.verdict, UNKNOWN);
});

test('an exceeded cap outranks an unknown one', () => {
  const agents = {
    broke: { records: [{ costUsd: 9 }, { costUsd: 2 }] },
    blind: { records: [unmeasuredRecord()] },
  };
  const fleet = fleetCapVerdict({ agents }, { broke: { daily_usd: 5 }, blind: { daily_usd: 5 } });
  assert.equal(fleet.verdict, EXCEEDED);
  assert.equal(fleet.exceeded, 1);
  assert.equal(fleet.unknown, 1);
});

test('an empty payload is no_cap, not a passing grade', () => {
  for (const input of [null, undefined, {}, { agents: null }]) {
    const fleet = fleetCapVerdict(input, {});
    assert.equal(fleet.verdict, NO_CAP);
    assert.equal(fleet.agents, 0);
  }
});
