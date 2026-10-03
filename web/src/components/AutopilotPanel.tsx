import { useState } from 'react';
import { useLive } from '../api';

/**
 * Types are declared here rather than in ../api on purpose. ../api is a shared
 * file that other sessions edit, and a panel that only reads from it needs to
 * add nothing to it.
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
  evidence?: {
    tests?: number;
    pass?: number;
    fail?: number;
    failures?: string[];
    baselineSeeded?: boolean;
  };
}

interface AutopilotSnapshot {
  enabled: boolean;
  policy: AutopilotPolicy;
  proposals: AutopilotProposal[];
  audit: { at: number; action: string; reason?: string; branch?: string }[];
  ref?: string;
  sharedTreeDirty?: number | null;
  staleWorktrees?: number;
  baseline?: string[] | null;
  baselineEstablishedAt?: number | null;
  lastVerification?: {
    at: number;
    tests: number;
    pass: number;
    fail: number;
    baselineSeeded?: boolean;
  } | null;
  lastRegression?: {
    at: number;
    newFailures: string[];
    totals: { tests: number; pass: number; fail: number };
  } | null;
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

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

/**
 * Autopilot panel.
 *
 * Generation one of the autopilot is verification-only: on each tick it runs the
 * suite in a throwaway worktree and files the result. It proposes no code edits.
 * That is why this panel leads with the last verification and the failure
 * baseline rather than with a list of changes — for now the honest summary of
 * what the loop is doing is "it ran the tests and this is what happened".
 *
 * Landing is the operator's decision and the only way a proposal changes state.
 */
export default function AutopilotPanel() {
  const { data, loading, error, refresh } = useLive<AutopilotSnapshot>('/api/autopilot/snapshot');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function send(path: string, method: 'POST', body?: unknown) {
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(path, {
        method,
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
      <section className="autopilot" aria-label="Autopilot">
        <h2 className="autopilot__title">AUTOPILOT</h2>
        <p className="autopilot__hint">Reading…</p>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="autopilot" aria-label="Autopilot">
        <h2 className="autopilot__title">AUTOPILOT</h2>
        <p className="autopilot__hint">Unavailable: {error}</p>
      </section>
    );
  }

  if (!data) return null;

  const { policy, lastVerification: verify, lastRegression: regression } = data;
  const open = (data.proposals ?? []).filter((p) => p.state === 'open');
  const settled = (data.proposals ?? []).filter((p) => p.state !== 'open');

  return (
    <section className="autopilot" aria-label="Autopilot">
      <div className="autopilot__head">
        <h2 className="autopilot__title">AUTOPILOT</h2>
        <span className={`autopilot__state ${policy.enabled ? 'is-on' : 'is-off'}`}>
          {policy.enabled ? 'ARMED' : 'OFF'}
        </span>
      </div>

      <p className="autopilot__blurb">
        Verifies <code>{data.ref ?? 'origin/main'}</code> in a throwaway worktree and files the result.
        It proposes; it never merges, pushes, or writes to your checkout.
      </p>

      {!policy.enabled && (
        <div className="autopilot__gate">
          <label className="autopilot__toggle">
            <input
              type="checkbox"
              checked={policy.enabled}
              disabled={busy}
              onChange={(event) => { void send('/api/autopilot/policy', 'POST', { enabled: event.target.checked }); }}
            />
            <span>Let the autopilot run its verification tick</span>
          </label>
          <p className="autopilot__hint">
            Arming it starts a test run on a timer. It still cannot land anything.
          </p>
        </div>
      )}

      {regression && (
        <div className="autopilot__regression">
          <span className="autopilot__badge is-bad">REGRESSION</span>
          <p>
            {regression.newFailures.length} new failure(s) {regression.newFailures.length === 1 ? '' : 's'} since{' '}
            {ago(regression.at)}. Baseline was not widened.
          </p>
          <ul className="autopilot__failures">
            {regression.newFailures.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </div>
      )}

      {verify && (
        <dl className="autopilot__stats">
          <div><dt>last run</dt><dd>{ago(verify.at)}</dd></div>
          <div><dt>pass</dt><dd>{numberFmt.format(verify.pass)} / {numberFmt.format(verify.tests)}</dd></div>
          <div><dt>known failures</dt><dd>{numberFmt.format(verify.fail)}</dd></div>
          <div><dt>baseline</dt><dd>{data.baselineEstablishedAt ? ago(data.baselineEstablishedAt) : 'not set'}</dd></div>
        </dl>
      )}

      {verify?.baselineSeeded && (
        <p className="autopilot__hint">
          Baseline seeded from this run. It only ever tightens — a new failure is reported, never absorbed.
        </p>
      )}

      <div className="autopilot__actions">
        <button type="button" disabled={busy} onClick={() => { void send('/api/autopilot/tick', 'POST'); }}>
          Run a tick now
        </button>
        <button type="button" disabled={busy} onClick={() => { void refresh(); }}>Refresh</button>
      </div>

      {actionError && <p className="autopilot__error">{actionError}</p>}

      <h3 className="autopilot__subtitle">Open proposals ({open.length}/{policy.maxOpenProposals})</h3>
      {open.length === 0 && <p className="autopilot__hint">Nothing waiting on a decision.</p>}
      {open.map((proposal) => (
        <div key={proposal.id} className="autopilot__proposal">
          <div className="autopilot__proposal-head">
            <span className="autopilot__badge">VERIFY</span>
            <code className="autopilot__branch">{proposal.branch}</code>
          </div>
          <p className="autopilot__summary">{proposal.summary}</p>
          {proposal.evidence && (
            <p className="autopilot__hint">
              {numberFmt.format(proposal.evidence.pass ?? 0)}/{numberFmt.format(proposal.evidence.tests ?? 0)} pass
              · {proposal.evidence.fail} known failure(s)
            </p>
          )}
          <div className="autopilot__actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => { void send(`/api/autopilot/proposals/${proposal.id}/land`, 'POST', { note: 'landed from HUD' }); }}
            >
              Mark landed
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { void send(`/api/autopilot/proposals/${proposal.id}/dismiss`, 'POST', { reason: 'dismissed from HUD' }); }}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}

      {settled.length > 0 && (
        <>
          <h3 className="autopilot__subtitle">Settled ({settled.length})</h3>
          <ul className="autopilot__settled">
            {settled.slice(-8).map((p) => (
              <li key={p.id}>
                <span className={`autopilot__badge is-${p.state}`}>{p.state.toUpperCase()}</span>
                <code>{p.branch}</code>
                {p.note ? <em> — {p.note}</em> : null}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="autopilot__footnote">
        Your checkout has {data.sharedTreeDirty === null || data.sharedTreeDirty === undefined
          ? 'an unknown number of'
          : numberFmt.format(data.sharedTreeDirty)} uncommitted change(s). The autopilot reasons in its own
        worktree, so that does not block it — but it does mean anything it reports is against{' '}
        {data.ref ?? 'origin/main'}, not your working tree.
      </p>
      <p className="autopilot__footnote">
        Failure baseline: {pct(verify && verify.tests ? (verify.fail / verify.tests) : null)} of the suite is
        currently known-broken. Stale worktrees: {numberFmt.format(data.staleWorktrees ?? 0)}.
      </p>
    </section>
  );
}