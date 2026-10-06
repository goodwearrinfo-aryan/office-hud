import { useState } from 'react';
import { useLive } from '../api';

/**
 * Types are declared here rather than in ../api on purpose. ../api is a shared
 * file that other sessions edit, and a panel that only reads from it needs to
 * add nothing to it.
 *
 * Styling uses the same vocabulary as the rest of F9 (Tailwind utilities over the
 * hud palette, plus `panel` and `badge`), so this drops into OpsFloor without
 * needing a single new CSS rule.
 */

interface AutopilotPolicy {
  enabled: boolean;
  maxOpenProposals: number;
  cooldownMinutes: number;
  proposalTtlHours: number;
  requireCleanWorktree: boolean;
}

interface AutopilotProposal {
  id: string;
  state: 'open' | 'landed' | 'dismissed';
  summary: string;
  branch: string;
  createdAt: number;
  note?: string;
  evidence?: { tests?: number; pass?: number; fail?: number; baselineSeeded?: boolean };
}

interface AutopilotSnapshot {
  enabled: boolean;
  policy: AutopilotPolicy;
  proposals: AutopilotProposal[];
  audit: { at: number; action: string; reason?: string }[];
  ref?: string;
  sharedTreeDirty?: number | null;
  staleWorktrees?: number;
  baseline?: string[] | null;
  baselineEstablishedAt?: number | null;
  lastVerification?: {
    at: number; tests: number; pass: number; fail: number; baselineSeeded?: boolean;
  } | null;
  lastRegression?: { at: number; newFailures: string[] } | null;
}

const numberFmt = new Intl.NumberFormat();

function ago(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const minutes = Math.floor(Math.max(0, Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Autopilot panel.
 *
 * Generation one of the autopilot is verification-only: on each tick it runs the
 * suite in a throwaway worktree and files the result. It proposes no code edits.
 * That is why this leads with the last verification and the failure baseline
 * rather than a list of changes -- for now the honest summary of what the loop is
 * doing is "it ran the tests and this is what happened".
 *
 * Landing is the operator's decision and the only way a proposal changes state.
 */
export default function AutopilotPanel() {
  const { data, loading, error, refresh } = useLive<AutopilotSnapshot>('/api/autopilot/snapshot');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function send(path: string, body?: unknown) {
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json?.error?.message || `HTTP ${response.status}`);
      await refresh();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">AUTOPILOT</h3>
        <p className="text-hud-dim text-sm">Reading…</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">AUTOPILOT</h3>
        <p className="text-hud-red text-sm">Unavailable: {error}</p>
      </div>
    );
  }

  if (!data) return null;

  const { policy, lastVerification: verify, lastRegression: regression } = data;
  const open = (data.proposals ?? []).filter((p) => p.state === 'open');
  const settled = (data.proposals ?? []).filter((p) => p.state !== 'open');

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono text-hud-amber text-sm">AUTOPILOT</h3>
        <span className={`badge ${policy.enabled ? 'badge-success' : 'badge-neutral'}`}>
          {policy.enabled ? 'ARMED' : 'OFF'}
        </span>
      </div>

      <p className="text-hud-dim text-xs mb-3">
        Verifies <span className="text-hud-cyan">{data.ref ?? 'origin/main'}</span> in a throwaway
        worktree and files the result. It proposes; it never merges, pushes, or writes to your
        checkout.
      </p>

      {!policy.enabled && (
        <div className="panel p-3 mb-3">
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={policy.enabled}
              disabled={busy}
              onChange={(event) => { void send('/api/autopilot/policy', { enabled: event.target.checked }); }}
            />
            <span>Let the autopilot run its verification tick</span>
          </label>
          <p className="text-hud-dim text-xs mt-2">
            Arming it starts a test run on a timer. It still cannot land anything.
          </p>
        </div>
      )}

      {regression && (
        <div className="panel p-3 mb-3 border-l-2 border-hud-red">
          <span className="badge badge-danger">REGRESSION</span>
          <p className="text-sm mt-2">
            {regression.newFailures.length} new failure(s) since {ago(regression.at)}. The baseline
            was not widened.
          </p>
          <ul className="text-hud-dim text-xs mt-1 space-y-0.5">
            {regression.newFailures.map((f) => <li key={f}>· {f}</li>)}
          </ul>
        </div>
      )}

      {verify && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="panel p-3">
            <div className="text-hud-dim text-xs">last run</div>
            <div className="text-sm">{ago(verify.at)}</div>
          </div>
          <div className="panel p-3">
            <div className="text-hud-dim text-xs">pass</div>
            <div className="text-sm">
              {numberFmt.format(verify.pass)} / {numberFmt.format(verify.tests)}
            </div>
          </div>
          <div className="panel p-3">
            <div className="text-hud-dim text-xs">known failures</div>
            <div className="text-sm">{numberFmt.format(verify.fail)}</div>
          </div>
          <div className="panel p-3">
            <div className="text-hud-dim text-xs">baseline</div>
            <div className="text-sm">
              {data.baselineEstablishedAt ? ago(data.baselineEstablishedAt) : 'not set'}
            </div>
          </div>
        </div>
      )}

      {verify?.baselineSeeded && (
        <p className="text-hud-dim text-xs mb-3">
          Baseline seeded from this run. It only ever tightens -- a new failure is reported, never
          absorbed.
        </p>
      )}

      <div className="flex gap-2 mb-3">
        <button
          type="button"
          className="badge badge-info cursor-pointer disabled:opacity-50"
          disabled={busy}
          onClick={() => { void send('/api/autopilot/tick'); }}
        >
          RUN A TICK NOW
        </button>
        <button
          type="button"
          className="badge badge-neutral cursor-pointer"
          onClick={() => { void refresh(); }}
        >
          REFRESH
        </button>
      </div>

      {actionError && <p className="text-hud-red text-xs mb-3">{actionError}</p>}

      <div className="text-hud-dim text-xs mb-2">
        OPEN PROPOSALS ({open.length}/{policy.maxOpenProposals})
      </div>
      {open.length === 0 && <p className="text-hud-dim text-xs">Nothing waiting on a decision.</p>}
      {open.map((proposal) => (
        <div key={proposal.id} className="panel p-3 mb-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="badge badge-info">VERIFY</span>
            <span className="font-mono text-hud-cyan text-xs">{proposal.branch}</span>
          </div>
          <p className="text-sm">{proposal.summary}</p>
          {proposal.evidence && (
            <p className="text-hud-dim text-xs mt-1">
              {numberFmt.format(proposal.evidence.pass ?? 0)}/{numberFmt.format(proposal.evidence.tests ?? 0)} pass
              {' · '}
              {proposal.evidence.fail} known failure(s)
            </p>
          )}
          <div className="flex gap-2 mt-2">
            <button
              type="button"
              className="badge badge-success cursor-pointer disabled:opacity-50"
              disabled={busy}
              onClick={() => { void send(`/api/autopilot/proposals/${proposal.id}/land`, { note: 'landed from HUD' }); }}
            >
              MARK LANDED
            </button>
            <button
              type="button"
              className="badge badge-neutral cursor-pointer disabled:opacity-50"
              disabled={busy}
              onClick={() => { void send(`/api/autopilot/proposals/${proposal.id}/dismiss`, { reason: 'dismissed from HUD' }); }}
            >
              DISMISS
            </button>
          </div>
        </div>
      ))}

      {settled.length > 0 && (
        <>
          <div className="text-hud-dim text-xs mt-3 mb-2">SETTLED ({settled.length})</div>
          <div className="space-y-1">
            {settled.slice(-6).map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-xs">
                <span className={`badge ${p.state === 'landed' ? 'badge-success' : 'badge-neutral'}`}>
                  {p.state.toUpperCase()}
                </span>
                <span className="font-mono text-hud-cyan">{p.branch}</span>
                {p.note ? <span className="text-hud-dim">-- {p.note}</span> : null}
              </div>
            ))}
          </div>
        </>
      )}

      <p className="text-hud-dim text-xs mt-3">
        Your checkout has{' '}
        {data.sharedTreeDirty === null || data.sharedTreeDirty === undefined
          ? 'an unknown number of'
          : numberFmt.format(data.sharedTreeDirty)}{' '}
        uncommitted change(s). The autopilot reasons in its own worktree, so that does not block it --
        but anything it reports is against {data.ref ?? 'origin/main'}, not your working tree.
        Stale worktrees: {numberFmt.format(data.staleWorktrees ?? 0)}.
      </p>
    </div>
  );
}