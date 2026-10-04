'use strict';
// The cost surface used to render `$0.00` for the whole fleet in large amber type,
// and every one of those 58 agents was reporting `daily: 0`.
//
// The zero was manufactured. Measured on the live mini, all 27 recorded calls carry
//
//     promptTokens: null, completionTokens: null, costUsd: null
//
// and hive/lib/llm/cost.js multiplies those nulls by a fallback price, where
// `null * 0.0004` is 0 in JavaScript rather than NaN. "The provider told us
// nothing" became "this call was free", the running total stayed at zero, and
// `checkCostLimit` — the module's own budget gate — returns `0 >= limit` === false
// for every agent. A limit check that can never fire looks armed.
//
// So the rule these tests pin: a zero may be shown as a measurement only when every
// record carried a usable cost. Each case is one way the old panel lied.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasUsableCost, agentCostVerdict, fleetCostVerdict, costLabel, mayShowZero,
} = require('../costTruth.js');

/** Exactly what the mini has on disk right now, for office-manager. */
const theRealRecord = (over = {}) => ({
  agentId: 'office-manager', model: 'free-harness-auto', provider: 'FreeHarness',
  promptTokens: null, completionTokens: null, costUsd: null, timestamp: '2026-10-03T00:19:14.000Z',
  taskId: 'todo-6a39e648', ...over,
});

const realAgent = () => ({
  daily: 0,
  monthly: null,
  records: Array.from({ length: 16 }, () => theRealRecord()),
});

test('the real payload is unmeasured, not free', () => {
  const v = agentCostVerdict(realAgent());
  assert.equal(v.verdict, 'unmeasured');
  assert.equal(v.records, 16);
  assert.equal(v.priced, 0);
  assert.equal(v.unpriced, 16);
  assert.equal(v.mayShowZero, false, 'a $0.00 here is a silence, not a measurement');
  assert.equal(mayShowZero(fleetCostVerdict({ agents: { 'office-manager': realAgent() } })), false);
});

test('the panel sentence never states a dollar figure when nothing was measured', () => {
  const fleet = fleetCostVerdict({ agents: { 'office-manager': realAgent() } });
  const label = costLabel(fleet);
  assert.match(label, /^NOT MEASURED/);
  assert.doesNotMatch(label, /\$0\.00/);
  assert.doesNotMatch(label, /\$0 /);
});

test('a measured zero may be shown, because that one is real', () => {
  const v = agentCostVerdict({ daily: 0, records: [theRealRecord({ costUsd: 0, promptTokens: 100, completionTokens: 50 })] });
  assert.equal(v.verdict, 'measured');
  assert.equal(v.mayShowZero, true);
  assert.match(costLabel({ verdict: 'measured', measuredSpend: 0, records: 1, priced: 1, unpriced: 0 }), /\$0\.00 measured/);
});

test('a partial measurement is a floor, and says so', () => {
  const v = fleetCostVerdict({
    agents: {
      mainbot: { records: [theRealRecord({ costUsd: 0.5, promptTokens: 10, completionTokens: 5 }), theRealRecord()] },
    },
  });
  assert.equal(v.verdict, 'partial');
  assert.equal(v.priced, 1);
  assert.equal(v.unpriced, 1);
  assert.equal(v.mayShowZero, false);
  const label = costLabel(v);
  assert.match(label, /floor, not a total/);
  assert.match(label, /\$0\.50 measured from 1 of 2 calls/);
});

test('no records is a different claim from zero cost', () => {
  const empty = fleetCostVerdict({ agents: { 'office-manager': { daily: 0, records: [] } } });
  assert.equal(empty.verdict, 'no_records');
  assert.equal(empty.mayShowZero, true);
  assert.match(costLabel(empty), /nothing to total/);
});

test('a null daily is not read as a number', () => {
  const v = agentCostVerdict({ daily: null, records: [] });
  assert.equal(v.reportedDaily, null);
  assert.equal(v.mayShowZero, true, 'absence of a total is not a failure to measure');
});

test('the fleet verdict counts every agent, including the ones that never spent', () => {
  // The live payload carries 58 agents and 3 with records. All 58 read daily=0, which
  // is why "58 agents at $0.00" looked like a fleet that costs nothing.
  // 58 agents, 27 records across 3 of them, exactly as measured on the mini.
  const agents = {};
  for (let i = 0; i < 55; i += 1) agents[`idle-${i}`] = { daily: 0, records: [] };
  agents['office-manager'] = { daily: 0, monthly: null, records: Array.from({ length: 16 }, () => theRealRecord()) };
  agents['mainbot'] = { daily: 0, monthly: null, records: Array.from({ length: 8 }, () => theRealRecord({ agentId: 'mainbot' })) };
  agents['specialist-01'] = { daily: 0, monthly: null, records: Array.from({ length: 3 }, () => theRealRecord({ agentId: 'specialist-01' })) };
  const fleet = fleetCostVerdict({ agents });
  assert.equal(fleet.agents, 58);
  assert.equal(fleet.records, 27);
  assert.equal(fleet.priced, 0);
  assert.equal(fleet.unpriced, 27);
  assert.equal(fleet.verdict, 'unmeasured');
  assert.equal(fleet.mayShowZero, false);
});

test('an empty payload is not a zero-cost payload', () => {
  for (const input of [null, undefined, {}, { agents: null }]) {
    const v = fleetCostVerdict(input);
    assert.equal(v.verdict, 'no_records');
    assert.equal(v.records, 0);
  }
});

test('a record is usable only with a finite number', () => {
  assert.equal(hasUsableCost({ costUsd: 0 }), true, 'zero is a real cost');
  assert.equal(hasUsableCost({ costUsd: 0.0001 }), true);
  for (const bad of [{ costUsd: null }, { costUsd: undefined }, {}, { costUsd: NaN }, { costUsd: '0.5' }, null, undefined]) {
    assert.equal(hasUsableCost(bad), false, `${JSON.stringify(bad)} is not a usable cost`);
  }
});

test('the reported total is never trusted over the records', () => {
  // `daily` accumulated the nulls as zeros. If it disagreed with the records, the
  // records win, because they are the only field that carries evidence.
  const v = agentCostVerdict({ daily: 999, records: [theRealRecord({ costUsd: 0.25, promptTokens: 1, completionTokens: 1 })] });
  assert.equal(v.verdict, 'measured');
  assert.equal(v.measuredSpend, 0.25);
  assert.equal(v.reportedDaily, 999);
});
test('the costs resource ships the verdict, so no browser has to re-derive it', () => {
  // Structural. The verdict is computed from the records on the server precisely so the
  // panel cannot sort by `usd` and render a ranking nobody measured.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const start = src.indexOf("costs: build('costs'");
  assert.ok(start > 0, 'costs resource present');
  const body = src.slice(start, src.indexOf('}),', start));
  assert.match(body, /fleetCostVerdict\(/);
  assert.match(body, /cost_label: costLabel\(/);
  assert.match(body, /may_show_zero: mayShowZero\(/);
});

test('the panel cannot render a dollar figure it was told not to', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'components', 'ExecutiveHQ.tsx'), 'utf8');
  // The tile is behind may_show_zero, and the unmeasured branch states the reason
  // instead of a number. Both halves matter: the guard, and the sentence.
  assert.match(src, /showCostFigure\s*\?/, 'the figure is behind the guard');
  assert.match(src, /NOT MEASURED/);
  assert.match(src, /costs\?\.cost_label/);
  // And the ranking must not be built from `usd` when nothing is measured, because
  // every agent's usd is 0 on this hive and the sort would be arbitrary.
  assert.match(src, /showCostFigure\s*\n?\s*\?\s*\[\.\.\.agents\]/, 'ranking is gated too');
});
