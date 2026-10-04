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
