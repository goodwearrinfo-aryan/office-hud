/**
 * What F18 The Desk is allowed to say.
 *
 * In a .ts module rather than inside DeskFloor.tsx so node's runner can load it
 * and so the rules can be asserted directly. See server/test/deskTruth.test.ts.
 *
 * The desk exists to answer three questions — what has this office been told,
 * what is it doing, what became of it — and the raw payloads make four comfortable
 * lies available. Each function below closes one.
 *
 *  - "0 commands" when the log was only partly read. Measured while building
 *    this: the audit answered `status: "ok"`, `count: 0`, `scanned: 375`, and a
 *    window that had read 524288 bytes of a 15755023-byte file with
 *    `truncated: true`. So the count was true and the absence was not. Reading
 *    `ok` as "nothing was ever asked" is the single worst thing this floor could
 *    do, because it is the claim an operator is most likely to believe.
 *  - A dispatched-but-unowned task row drawn as owned. `claimed_by` and
 *    `claimed_at` can each be absent independently.
 *  - A verdict tally drawn as a ratio with no denominator.
 *  - A dispatch state flattened into "available" when the reason it is blocked is
 *    the only useful part.
 */

export interface AuditWindow {
  source_bytes?: number;
  read_bytes?: number;
  limit_bytes?: number;
  truncated?: boolean;
  unparsed_lines?: number;
}

export interface AuditLike {
  ok?: boolean;
  status?: string | null;
  error?: string | null;
  count?: number;
  limit?: number;
  scanned?: number;
  source?: string | null;
  reachable_window?: boolean;
  window?: AuditWindow | null;
  checkedAt?: string | null;
}

export type HistoryStatus =
  | 'has_events'
  | 'empty_in_window'
  | 'window_truncated'
  | 'unreadable'
  | 'unparsed'
  | 'no_answer';

function bytes(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${Math.round(n)} B`;
  const mb = n / (1024 * 1024);
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  return `${Math.round(mb)} MB`;
}

/**
 * Whether this audit can support the claim "nothing was ever asked".
 *
 * It almost never can, and that is the point. `empty_in_window` is separated from
 * `window_truncated` on purpose: the first is a real absence inside what was read,
 * the second is an absence that cannot be extrapolated.
 */
export function historyStatus(audit: AuditLike | null | undefined): HistoryStatus {
  if (!audit || typeof audit !== 'object') return 'no_answer';
  // The server already distinguishes these three; trust its verdict over our own
  // inference, because it knows why the read failed and we do not.
  if (audit.status === 'unreadable') return 'unreadable';
  if (audit.status === 'unparsed') return 'unparsed';
  if (audit.ok === false) return 'unreadable';
  const count = typeof audit.count === 'number' ? audit.count : null;
  if (count !== null && count > 0) return 'has_events';
  // Everything below is a claim about an ABSENCE, and an absence needs positive
  // evidence that the read finished. A payload carrying no window at all — not a
  // missing hive, not a version skew, just `{}` — says nothing about what is in the
  // log, and reading it as empty is how a floor invents a clean history.
  const window = audit.window;
  if (!window || typeof window !== 'object') return 'no_answer';
  if (window.truncated === true) return 'window_truncated';
  if (count === null) return 'no_answer';
  return 'empty_in_window';
}

/**
 * The sentence a human reads, in every case. There is deliberately no branch that
 * produces a bare "no commands".
 */
export function historyLabel(audit: AuditLike | null | undefined): string {
  const status = historyStatus(audit);
  const scanned = typeof audit?.scanned === 'number' ? audit.scanned : null;
  const scannedText = scanned == null ? '' : ` ${scanned} events scanned`;

  switch (status) {
    case 'has_events':
      return `${audit?.count} command${audit?.count === 1 ? '' : 's'} in the audit trail.`;
    case 'empty_in_window': {
      const read = audit?.window?.read_bytes;
      return `No commands in the part of ${audit?.source ?? 'the log'} that was read (${bytes(read)}${scannedText}). That is what was searched, not the whole file.`;
    }
    case 'window_truncated':
      return `No commands in the ${bytes(audit?.window?.read_bytes)} tail that was read${scannedText}, of a ${bytes(audit?.window?.source_bytes)} log. Earlier commands may exist outside the window.`;
    case 'unreadable':
      return `The audit log could not be read: ${audit?.error ?? 'no detail given'}. This is not an absence of commands.`;
    case 'unparsed':
      return `The audit log has bytes that are not events (${audit?.window?.unparsed_lines ?? 'some'} unparsed lines). Absence of commands cannot be claimed from this.`;
    case 'no_answer':
    default:
      return 'The office has not reported on its command history.';
  }
}

/** Whether this floor may claim an absence. Only one status supports it. */
export function canClaimAbsence(audit: AuditLike | null | undefined): boolean {
  return historyStatus(audit) === 'empty_in_window';
}

export interface TaskBoardRow {
  task_id?: string | null;
  title?: string | null;
  status?: string | null;
  claimed_by?: string | null;
  claimed_at?: string | null;
  assigned_agent?: string | null;
  started_at?: string | null;
  created_at?: string | null;
}

const ageOf = (row: TaskBoardRow): string | null => {
  const stamp = row.claimed_at || row.started_at || row.created_at;
  if (typeof stamp !== 'string' || Number.isNaN(Date.parse(stamp))) return null;
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(stamp)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

/**
 * Who owns this row, or that nobody can say.
 *
 * `claimed_by` and `claimed_at` are independent fields and either can be missing
 * while the other is present. Drawing a row with a claim time but no claimant as
 * "running" invents an owner; drawing it as idle invents an absence of work. Both
 * fields are required for a claim, and the age needs a parseable timestamp.
 */
export function claimLabel(row: TaskBoardRow | null | undefined): {
  text: string;
  tone: 'claimed' | 'assigned' | 'unverified' | 'queued';
} {
  if (!row) return { text: 'NOT REPORTED', tone: 'unverified' };
  const claimedBy = typeof row.claimed_by === 'string' && row.claimed_by.trim() ? row.claimed_by.trim() : null;
  const age = ageOf(row);
  if (claimedBy && age) return { text: `${claimedBy} · ${age}`, tone: 'claimed' };
  if (claimedBy) return { text: `${claimedBy} · age unknown`, tone: 'claimed' };
  const assigned = typeof row.assigned_agent === 'string' && row.assigned_agent.trim() ? row.assigned_agent.trim() : null;
  if (assigned) return { text: `${assigned} · not claimed`, tone: 'assigned' };
  if (age) return { text: `no owner reported · ${age}`, tone: 'unverified' };
  return { text: 'no owner reported', tone: 'queued' };
}

export interface VerifyLike {
  verdict_tally?: Record<string, number> | null;
  first_strike?: unknown;
  off_topic?: unknown;
  quarantined?: unknown;
  requeued?: unknown;
}

/**
 * Verdict counts with their total, because a rate without one is a decoration.
 *
 * The mini currently answers 631 OK and nothing else, which reads as "perfect" in
 * a chart and as "631 of 631 checked" in fact. The second reading is the honest
 * one and it requires the denominator to be on screen.
 */
export function verifyTally(verify: VerifyLike | null | undefined): {
  rows: { verdict: string; count: number }[];
  total: number;
  label: string;
} {
  const tally = verify?.verdict_tally;
  if (!tally || typeof tally !== 'object') {
    return { rows: [], total: 0, label: 'No verdict tally reported.' };
  }
  const rows = Object.entries(tally)
    .map(([verdict, count]) => ({ verdict, count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count || a.verdict.localeCompare(b.verdict));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) {
    return { rows, total: 0, label: 'Verdict tally present but empty — no verdict has been recorded.' };
  }
  const counts = rows.map(row => `${row.count} ${row.verdict}`).join(', ');
  return { rows, total, label: `${counts} of ${total} verdicts.` };
}

export interface PreviewLike {
  ok?: boolean;
  reason?: string | null;
  queue_available?: boolean;
  blocked_by?: string | null;
  blocked_reason?: string | null;
  dispatch?: { available?: boolean; host?: string; requirement?: string } | null;
}

/**
 * Whether this machine can dispatch, and the reason when it cannot.
 *
 * The reason is never dropped. A single "READ ONLY" badge tells an operator they
 * are blocked; the server's sentence tells them whether the block is topology,
 * a missing queue, or their own malformed command, and those have different fixes.
 */
export function dispatchSummary(preview: PreviewLike | null | undefined): {
  available: boolean;
  label: string;
  reason: string | null;
  host: string | null;
} {
  if (!preview) {
    return { available: false, label: 'DISPATCH NOT ASSESSED', reason: 'The office has not judged a command yet.', host: null };
  }
  const host = preview.dispatch?.host ?? null;
  if (preview.ok === false) {
    return { available: false, label: 'DISPATCH BLOCKED', reason: preview.reason ?? 'The command was refused.', host };
  }
  if (preview.queue_available === false) {
    return { available: false, label: 'QUEUE UNAVAILABLE', reason: preview.blocked_reason ?? 'The task queue is unavailable on this host.', host };
  }
  if (preview.dispatch?.available !== true) {
    return { available: false, label: 'DISPATCH READ-ONLY', reason: preview.blocked_reason ?? preview.dispatch?.requirement ?? null, host };
  }
  return { available: true, label: 'DISPATCH AVAILABLE', reason: null, host };
}
export interface RateLimitLike {
  ok?: boolean;
  status?: 'observed' | 'unobserved' | 'unavailable' | string | null;
  reason?: string | null;
  headroom?: number | null;
  reset_in_ms?: number | null;
  requested?: { key?: string | null; rpm?: number | null } | null;
  checked_at?: string | null;
}

/**
 * The one sentence the desk says about rate-limit headroom.
 *
 * The floor this replaces would have drawn a green bar. There is no bar here, and
 * that is the finding rather than an omission: the limiter keeps its buckets in a
 * private map and reports a full bucket for any key it has never seen, so a bar
 * would have been drawn from the default that was just filled in.
 *
 * An unobserved scope gets its own wording, kept distinct from an exhausted one.
 * "No record" and "no capacity" are different facts and an operator pressing Route it
 * acts on the difference.
 */
export function headroomLine(report: RateLimitLike | null | undefined): string {
  if (!report || typeof report !== 'object') return 'Rate-limit headroom has not been reported.';
  if (report.status === 'observed' && typeof report.headroom === 'number') {
    const reset = report.reset_in_ms == null ? '' : `, resets in ${Math.ceil(report.reset_in_ms / 1000)}s`;
    return `${report.headroom} of ${report.requested?.rpm ?? '?'} requests available${reset}.`;
  }
  if (report.status === 'unavailable') return report.reason || 'The rate limiter could not be loaded, so no headroom is claimed.';
  if (report.status === 'unobserved') return report.reason || 'No rate-limit record exists for this scope.';
  return report.reason || 'Rate-limit headroom is in a state this floor does not recognise, so nothing is claimed.';
}

/**
 * Whether a floor may draw a capacity indicator at all.
 *
 * Only a proven reading. This is the restraint borrowed from pixel-agents (MIT), whose
 * lane indicators appear on real signals rather than on defaults — and whose own
 * roadmap still lists rate-limit health bars as unbuilt, so nothing was copied but the
 * discipline.
 */
export function mayDrawCapacity(report: RateLimitLike | null | undefined): boolean {
  return report?.status === 'observed' && typeof report.headroom === 'number';
}
