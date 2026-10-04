/**
 * The shape of the server's cost verdict, as it arrives on /api/llm/costs.
 *
 * Declared here rather than in the component because the verdict is computed on the
 * server from the records (server/costTruth.js) and the browser is not asked to
 * re-derive it. That is the same rule the command path follows: ask the office what
 * it knows rather than guessing from a payload that invites the guess.
 */
export interface CostVerdictAgent {
  id: string;
  verdict: 'measured' | 'partial' | 'unmeasured' | 'no_records';
  records: number;
  priced: number;
  unpriced: number;
  measuredSpend: number;
  reportedDaily: number | null;
  mayShowZero: boolean;
}

export interface CostVerdict {
  verdict: 'measured' | 'partial' | 'unmeasured' | 'no_records';
  agents: number;
  records: number;
  priced: number;
  unpriced: number;
  measuredSpend: number;
  mayShowZero: boolean;
  perAgent: CostVerdictAgent[];
}

/**
 * The fleet's spending-cap state, computed server-side from the agent records.
 *
 * Deliberately not a boolean. `no_cap` and `within` are different facts, and this
 * codebase has already shipped one case of a safety property that reported absence as
 * compliance: `checkCostLimit` returns `false` when an agent has no cost record, so
 * "under the cap" and "we do not know what it spent" were the same answer.
 */
export interface CapAgentVerdict {
  verdict: 'no_cap' | 'within' | 'exceeded' | 'unknown';
  period: 'daily' | 'monthly';
  limit_usd: number | null;
  spend_usd: number | null;
  measurement: string | null;
  reason: string;
  may_show_within: boolean;
}

export interface CapFleetVerdict {
  verdict: 'no_cap' | 'within' | 'exceeded' | 'unknown';
  reason: string;
  agents: number;
  with_cap: number;
  exceeded: number;
  unknown: number;
  per_agent: { id: string; daily: CapAgentVerdict; monthly: CapAgentVerdict }[];
}
