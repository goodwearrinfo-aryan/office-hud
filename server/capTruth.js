'use strict';
/**
 * What the HUD may say about a spending cap.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Traced end to end on the live mini after the cost truth fix, because "the office
 * has no cost cap" turned out to be four separate facts stacked on top of each other,
 * none of them visible from the HUD.
 *
 * There IS a cap on the request path. hive/lib/llm/client.ts calls it on every LLM
 * call, and deadlineParity.js exists specifically to assert the method is still
 * present, so it is not decorative by accident:
 *
 *     private async checkCostLimits(agentId, estimatedTokens) {
 *       const config = this.agentConfigs.get(agentId);
 *       if (!config) return;
 *       const costs = this.costTracker.get(agentId) || { daily: 0, monthly: 0 };
 *       if (config.costLimitUsdPerDay && costs.daily + 0.01 > config.costLimitUsdPerDay) {
 *         throw new Error(`Daily cost limit exceeded for agent ${agentId}`);
 *       }
 *       ...
 *     }
 *
 * Measured facts, in order:
 *
 *  1. The limits come from the agent registry: client.js reads
 *     `a.cost_limit_usd_per_day` and `a.cost_limit_usd_per_month`.
 *  2. **Zero of the 66 agents in registry.json carry either field.**
 *  3. So `config.costLimitUsdPerDay` is `undefined`, and `undefined && ...` never
 *     enters the comparison. The check runs on every request and can never fire.
 *  4. It compares against `this.costTracker`, a Map private to the client instance --
 *     a different account from hive/lib/llm/cost.js's `costCache`, and a third again
 *     from `calculateCostFromUsage`. Three cost paths, no shared ledger.
 *  5. `estimatedCost` is computed on every call and never read.
 *  6. The exported `checkCostLimit(agentId, limitUsd, period)` in cost.js has no
 *     caller anywhere in the hive.
 *  7. The summary payload carries no cap field, so the floor could not report this
 *     even if it wanted to: there was nothing to render.
 *
 * So the cap is not broken. It is unset, silently, and invisible. This module gives
 * the HUD the vocabulary to say that -- which is the part the HUD owns. Setting a
 * number on an agent record is the trading system's to do, and this file deliberately
 * does not pretend otherwise.
 *
 * THE RULE THAT MATTERS
 * ---------------------
 * An unmeasured spend can never be `within`. If the records carry no cost, then
 * "under the cap" is not a fact -- it is the absence of one, and a cap that reports
 * absence as compliance is the same failure as a cap that cannot fire, wearing a
 * better mask.
 */

const NO_CAP = 'no_cap';
const WITHIN = 'within';
const EXCEEDED = 'exceeded';
const UNKNOWN = 'unknown';

/**
 * Judge one agent against one period's cap.
 *
 * `measurementVerdict` is the cost verdict from costTruth.js -- 'measured',
 * 'partial', 'unmeasured' or 'no_records'. It is required, because a cap over an
 * unmeasured quantity is not a conservative cap.
 */
function capVerdict({ limitUsd, period, measurementVerdict, measuredSpend } = {}) {
  const periodName = period === 'monthly' ? 'monthly' : 'daily';

  if (limitUsd === undefined || limitUsd === null || limitUsd === '') {
    return {
      verdict: NO_CAP,
      period: periodName,
      limit_usd: null,
      spend_usd: null,
      measurement: measurementVerdict ?? null,
      // Deliberately its own sentence. "No cap" is not "within", and rendering it as
      // green would be the exact substitution this whole file exists to prevent.
      reason: `No ${periodName} spending cap is set for this agent, so nothing can be compared against one. The cap check still runs on every request and cannot fire.`,
      may_show_within: false,
    };
  }

  const limit = Number(limitUsd);
  if (!Number.isFinite(limit) || limit < 0) {
    return {
      verdict: UNKNOWN,
      period: periodName,
      limit_usd: null,
      spend_usd: null,
      measurement: measurementVerdict ?? null,
      reason: `The configured ${periodName} cap is not a usable number, so the cap state cannot be evaluated.`,
      may_show_within: false,
    };
  }

  const spend = typeof measuredSpend === 'number' && Number.isFinite(measuredSpend) ? measuredSpend : null;
  const base = {
    period: periodName,
    limit_usd: limit,
    spend_usd: spend,
    measurement: measurementVerdict ?? null,
    may_show_within: false,
  };

  if (measurementVerdict !== 'measured' || spend === null) {
    return {
      ...base,
      verdict: UNKNOWN,
      reason: measurementVerdict === 'partial'
        ? `A ${periodName} cap of $${limit.toFixed(2)} is set, but only part of the spend is priced, so whether it is within the cap is unknown.`
        : `A ${periodName} cap of $${limit.toFixed(2)} is set, but no call has reported a usable cost, so whether it is within the cap is unknown rather than within.`,
    };
  }

  const exceeded = spend >= limit;
  return {
    ...base,
    verdict: exceeded ? EXCEEDED : WITHIN,
    reason: exceeded
      ? `$${spend.toFixed(2)} measured against a ${periodName} cap of $${limit.toFixed(2)}.`
      : `$${spend.toFixed(2)} measured against a ${periodName} cap of $${limit.toFixed(2)}.`,
    may_show_within: !exceeded,
  };
}

/**
 * The fleet-wide answer, from the cost payload plus whatever cap fields the agents
 * actually carry.
 *
 * `capFields` is read, never assumed. When no agent carries one -- which is the
 * measured state of this hive -- the verdict is `no_cap` for every agent, and the
 * fleet verdict says so in one sentence an operator can act on.
 */
function fleetCapVerdict(payload, capByAgent = {}) {
  const agents = payload && typeof payload.agents === 'object' && payload.agents ? payload.agents : {};
  const ids = new Set([...Object.keys(agents), ...Object.keys(capByAgent)]);
  const perAgent = [...ids].map((id) => {
    const costs = agents[id];
    const measurementVerdict = costs
      ? measureOf(costs)
      : 'no_records';
    const cap = capByAgent[id] || {};
    return {
      id,
      daily: capVerdict({ limitUsd: cap.daily_usd, period: 'daily', measurementVerdict, measuredSpend: spendOf(costs) }),
      monthly: capVerdict({ limitUsd: cap.monthly_usd, period: 'monthly', measurementVerdict, measuredSpend: spendOf(costs) }),
    };
  });

  const withCap = perAgent.filter(a => a.daily.verdict !== NO_CAP || a.monthly.verdict !== NO_CAP);
  const exceeded = perAgent.filter(a => a.daily.verdict === EXCEEDED || a.monthly.verdict === EXCEEDED);
  const unknown = perAgent.filter(a => a.daily.verdict === UNKNOWN || a.monthly.verdict === UNKNOWN);

  let verdict = NO_CAP;
  let reason = `No agent in this hive sets a spending cap (checked ${perAgent.length}), so the cap check runs on every LLM request and cannot fire for any of them.`;
  if (withCap.length === 0) {
    verdict = NO_CAP;
  } else if (exceeded.length > 0) {
    verdict = EXCEEDED;
    reason = `${exceeded.length} of ${withCap.length} capped agent${withCap.length === 1 ? '' : 's'} exceed a cap.`;
  } else if (unknown.length > 0) {
    verdict = UNKNOWN;
    reason = `${withCap.length} agent${withCap.length === 1 ? ' has' : 's have'} a cap set, but the spend is unmeasured, so none can be called within it.`;
  } else {
    verdict = WITHIN;
    reason = `All ${withCap.length} capped agents are within their caps.`;
  }

  return {
    verdict,
    reason,
    agents: perAgent.length,
    with_cap: withCap.length,
    exceeded: exceeded.length,
    unknown: unknown.length,
    per_agent: perAgent,
  };
}

function measureOf(costs) {
  const records = Array.isArray(costs?.records) ? costs.records : [];
  const priced = records.filter(r => typeof r?.costUsd === 'number' && Number.isFinite(r.costUsd));
  if (records.length === 0) return 'no_records';
  if (priced.length === records.length) return 'measured';
  if (priced.length === 0) return 'unmeasured';
  return 'partial';
}

function spendOf(costs) {
  const records = Array.isArray(costs?.records) ? costs.records : [];
  return records
    .filter(r => typeof r?.costUsd === 'number' && Number.isFinite(r.costUsd))
    .reduce((sum, r) => sum + r.costUsd, 0);
}

module.exports = { capVerdict, fleetCapVerdict, NO_CAP, WITHIN, EXCEEDED, UNKNOWN };