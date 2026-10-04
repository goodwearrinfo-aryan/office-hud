'use strict';
/**
 * What the HUD may claim about money.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The comparison against OpenOffice (MIT), which advertises "real-time usage per
 * agent and team", sent me looking for a per-agent cost breakdown we already record.
 * We do record one. It reads zero, and the zero is not a measurement.
 *
 * Measured on the live mini: 58 agents in the costs payload, every one reporting
 * `daily: 0`. Three of them hold 27 real records, and every record is:
 *
 *     { promptTokens: null, completionTokens: null, costUsd: null }
 *
 * hive/lib/llm/cost.js then does:
 *
 *     const pricing = PRICING[provider]?.[model] || { input: 0.0004, output: 0.0004 };
 *     return (usage.promptTokens * pricing.input + usage.completionTokens * pricing.output) / 1000;
 *
 * In JavaScript `null * 0.0004` is **0**, not NaN and not an error. So "the provider
 * told us nothing" became "this call cost nothing", 27 times, and the running total
 * stayed at zero for the whole fleet.
 *
 * Why that is worse than a missing number:
 *
 *  - `${totalCost.toFixed(2)}` renders `$0.00` in large amber type on F5, which reads
 *    as the office being free. It is not free; it is unmeasured.
 *  - `checkCostLimit(agentId, limitUsd, period)` in the same module returns `0 >= limit`
 *    === false for every agent. Any budget gate built on this data is silently disarmed
 *    while looking armed.
 *
 * So the rule is narrow: a zero total may be drawn as $0.00 only when every record
 * carried a usable cost. Otherwise the number is not displayed at all and the reason
 * is displayed instead.
 *
 * This module reads the hive's own records. It does not correct them -- the nulls are
 * written upstream by the provider that reports no usage, and that is the trading
 * system's to fix, not the HUD's.
 */

/**
 * Does this record carry a usable cost?
 *
 * null and undefined both fail, and so does NaN -- a JSON round trip turns NaN into
 * null, which is exactly how these records arrive.
 */
function hasUsableCost(record) {
  if (!record || typeof record !== 'object') return false;
  const cost = record.costUsd;
  return typeof cost === 'number' && Number.isFinite(cost);
}

/** Tally one agent's records into what can and cannot be claimed. */
function agentCostVerdict(agentCosts) {
  const records = Array.isArray(agentCosts?.records) ? agentCosts.records : [];
  const priced = records.filter(hasUsableCost);
  const unpriced = records.length - priced.length;

  // Recomputed from the records rather than trusted from `daily`, because `daily`
  // accumulated the nulls as zeros and is therefore not evidence of anything.
  const measuredSpend = priced.reduce((sum, record) => sum + record.costUsd, 0);
  const reportedDaily = typeof agentCosts?.daily === 'number' && Number.isFinite(agentCosts.daily)
    ? agentCosts.daily
    : null;

  let verdict;
  if (records.length === 0) {
    verdict = 'no_records';
  } else if (unpriced === 0) {
    verdict = 'measured';
  } else if (priced.length === 0) {
    verdict = 'unmeasured';
  } else {
    verdict = 'partial';
  }

  return {
    verdict,
    records: records.length,
    priced: priced.length,
    unpriced,
    measuredSpend,
    reportedDaily,
    /** True only when a $0.00 on screen is a measurement rather than a silence. */
    mayShowZero: records.length === 0 || unpriced === 0,
  };
}

/**
 * The fleet-wide cost verdict, from the same payload /api/llm/costs serves.
 *
 * `verdict` is 'measured' only when there is at least one priced record AND no
 * unpriced ones. A fleet with no records at all is 'no_records', which is a
 * different claim from a fleet that cost nothing.
 */
function fleetCostVerdict(payload) {
  const agents = payload && typeof payload.agents === 'object' && payload.agents ? payload.agents : {};
  const entries = Object.entries(agents);
  const perAgent = entries.map(([id, costs]) => ({ id, ...agentCostVerdict(costs) }));

  const records = perAgent.reduce((sum, a) => sum + a.records, 0);
  const priced = perAgent.reduce((sum, a) => sum + a.priced, 0);
  const unpriced = perAgent.reduce((sum, a) => sum + a.unpriced, 0);

  let verdict;
  if (records === 0) {
    verdict = 'no_records';
  } else if (unpriced === 0 && priced > 0) {
    verdict = 'measured';
  } else if (priced === 0) {
    verdict = 'unmeasured';
  } else {
    verdict = 'partial';
  }

  return {
    verdict,
    agents: entries.length,
    records,
    priced,
    unpriced,
    measuredSpend: perAgent.reduce((sum, a) => sum + a.measuredSpend, 0),
    mayShowZero: records === 0 || unpriced === 0,
    perAgent,
  };
}

/**
 * The one sentence for the panel.
 *
 * There is no branch that returns a dollar figure. The number belongs to the records
 * once they carry one; until then the panel says what it does not know.
 */
function costLabel(verdict) {
  if (!verdict) return 'Cost has not been reported.';
  switch (verdict.verdict) {
    case 'measured':
      return `$${verdict.measuredSpend.toFixed(2)} measured across ${verdict.records} priced call${verdict.records === 1 ? '' : 's'}.`;
    case 'partial':
      return `$${verdict.measuredSpend.toFixed(2)} measured from ${verdict.priced} of ${verdict.records} calls. The other ${verdict.unpriced} reported no usage, so this is a floor, not a total.`;
    case 'unmeasured':
      return `NOT MEASURED — all ${verdict.records} recorded calls reported no token usage, so the total is unknown rather than zero.`;
    case 'no_records':
    default:
      return 'No cost records have been written, so there is nothing to total.';
  }
}

/** True when a $0.00 may be drawn as a measurement. */
function mayShowZero(verdict) {
  return !!verdict && (verdict.verdict === 'no_records' || verdict.verdict === 'measured');
}

module.exports = { hasUsableCost, agentCostVerdict, fleetCostVerdict, costLabel, mayShowZero };