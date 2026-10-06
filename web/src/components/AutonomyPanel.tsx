import { useState } from 'react';
import { useResource, type AutonomyState, type AutonomyPolicy } from '../api';

const numberFmt = new Intl.NumberFormat();

function clockTime(ms: number | null | undefined): string {
  if (!ms) return '--';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

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
 * Autonomy panel.
 *
 * The HUD can notice that the agent pool cannot keep up and ask JEV for more
 * agents, but it is off by default and everything it does is a proposal until
 * someone accepts it. This panel is the whole surface of that: the arithmetic,
 * the gates, and the decision.
 */
export default function AutonomyPanel() {
  const { data, refresh } = useResource<AutonomyState>('autonomy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const policy = data?.policy;
  const assessment = data?.assessment;
  const pending = (data?.proposals ?? []).filter((proposal) => proposal.status === 'pending');

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.error?.message || detail?.error || `HTTP ${response.status}`);
      }
      refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!policy) {
    return (
      <section className="autonomy" aria-label="Autonomy">
        <h2 className="autonomy__title">AUTONOMY</h2>
        <p className="autonomy__hint">Not running.</p>
      </section>
    );
  }

  return (
    <section className="autonomy" aria-label="Autonomy">
      <div className="autonomy__head">
        <h2 className="autonomy__title">AUTONOMY</h2>
        <span className={`autonomy__state ${policy.enabled ? 'is-on' : 'is-off'}`}>
          {policy.enabled ? 'ARMED' : 'OFF'}
        </span>
      </div>

      <p className="autonomy__blurb">
        When the agent pool cannot keep up, the HUD can ask JEV to bring more agents to the floor.
        It only ever <em>proposes</em>; nothing is deployed without a decision below.
      </p>

      {!policy.enabled && (
        <div className="autonomy__gate">
          <label className="autonomy__toggle">
            <input
              type="checkbox"
              checked={policy.enabled}
              disabled={busy}
              onChange={(event) => { void post('/api/autonomy/policy', { enabled: event.target.checked }); }}
            />
            <span>Let the HUD assess capacity and raise scale-up proposals</span>
          </label>
          <p className="autonomy__hint">
            Still asks first. Arming the monitor does not authorise anything on its own.
          </p>
        </div>
      )}

      {assessment && (
        <dl className="autonomy__stats">
          <div><dt>queued</dt><dd>{numberFmt.format(assessment.queued)}</dd></div>
          <div><dt>in progress</dt><dd>{numberFmt.format(assessment.inProgress)}</dd></div>
          <div><dt>drain rate</dt><dd>{assessment.drainRatePerHour}/h</dd></div>
          <div>
            <dt>time to drain</dt>
            <dd>{assessment.timeToDrainHours === null ? '∞' : `${assessment.timeToDrainHours}h`}</dd>
          </div>
          <div><dt>busy / idle</dt><dd>{assessment.agentsBusy} / {assessment.agentsIdle}</dd></div>
          <div><dt>would add</dt><dd>{assessment.agentsNeeded || '--'}</dd></div>
        </dl>
      )}
      {assessment && <p className="autonomy__reason">{assessment.reason}</p>}

      {pending.map((proposal) => (
        <div key={proposal.id} className="autonomy__proposal">
          <div className="autonomy__proposal-head">
            <span className="autonomy__badge">ASK</span>
            <span className="autonomy__proposal-title">
              bring {proposal.requestedAgents} agent{proposal.requestedAgents === 1 ? '' : 's'}
              {proposal.target ? ` to ${proposal.target}` : ''}
            </span>
            <span className="autonomy__expires">expires {clockTime(proposal.expiresAt)}</span>
          </div>
          <p className="autonomy__prompt">{proposal.prompt}</p>
          <div className="autonomy__actions">
            <button
              type="button"
              className="autonomy__accept"
              disabled={busy}
              onClick={() => { void post(`/api/autonomy/proposals/${encodeURIComponent(proposal.id)}/accept`); }}
            >
              ask JEV to scale
            </button>
            <button
              type="button"
              className="autonomy__dismiss"
              disabled={busy}
              onClick={() => { void post(`/api/autonomy/proposals/${encodeURIComponent(proposal.id)}/dismiss`, { reason: 'operator dismissed' }); }}
            >
              dismiss
            </button>
          </div>
          <p className="autonomy__hint">
            Accepting enqueues one JEV command. JEV and the office manager decide what actually starts.
          </p>
        </div>
      ))}

      {pending.length === 0 && data && (
        <p className="autonomy__hint">
          {policy.enabled ? 'No scale-up needed right now.' : 'Autonomy is off, so nothing is being assessed for scaling.'}
        </p>
      )}

      {error && <p className="autonomy__error">{error}</p>}

      <details className="autonomy__details" open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
        <summary>gates and history</summary>
        <PolicyEditor policy={policy} spendToday={data?.spendToday ?? 0} busy={busy} onSave={(patch) => post('/api/autonomy/policy', patch)} />
        <ul className="autonomy__audit">
          {(data?.audit ?? []).slice(0, 8).map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <time>{clockTime(entry.at)}</time>
              <span className={`autonomy__audit-action is-${entry.action}`}>{entry.action.replace(/_/g, ' ')}</span>
              <span className="truncate">{entry.detail}</span>
            </li>
          ))}
          {(data?.audit ?? []).length === 0 && <li className="autonomy__hint">Nothing yet.</li>}
        </ul>
        <p className="autonomy__hint">last routed {ago(data?.lastRoutedAt)} · ${(data?.spendToday ?? 0).toFixed(2)} spent today</p>
      </details>
    </section>
  );
}

function PolicyEditor({
  policy,
  spendToday,
  busy,
  onSave,
}: {
  policy: AutonomyPolicy;
  spendToday: number;
  busy: boolean;
  onSave: (patch: Partial<AutonomyPolicy>) => Promise<boolean>;
}) {
  const [max, setMax] = useState(policy.maxAdditionalAgents);
  const [cooldown, setCooldown] = useState(policy.cooldownMinutes);
  const [budget, setBudget] = useState(policy.dailyBudgetUsd);

  return (
    <div className="autonomy__policy">
      <p className="autonomy__hint">
        Limits are enforced server-side on every route to JEV, not just in this form.
      </p>
      <label>
        max agents per ask
        <input type="number" min={1} max={8} value={max} disabled={busy}
          onChange={(e) => setMax(Number(e.target.value))} />
      </label>
      <label>
        cooldown (min)
        <input type="number" min={0} max={1440} value={cooldown} disabled={busy}
          onChange={(e) => setCooldown(Number(e.target.value))} />
      </label>
      <label>
        daily budget (USD)
        <input type="number" min={0} step="0.5" value={budget} disabled={busy}
          onChange={(e) => setBudget(Number(e.target.value))} />
      </label>
      <label className="autonomy__toggle">
        <input type="checkbox" checked={policy.requireConfirmation} disabled={busy}
          onChange={(e) => { void onSave({ requireConfirmation: e.target.checked }); }} />
        <span>ask me before routing to JEV</span>
      </label>
      <button
        type="button"
        className="autonomy__save"
        disabled={busy}
        onClick={() => { void onSave({ maxAdditionalAgents: max, cooldownMinutes: cooldown, dailyBudgetUsd: budget }); }}
      >
        save limits
      </button>
      {spendToday >= policy.dailyBudgetUsd && (
        <p className="autonomy__error">
          Today's spend (${spendToday.toFixed(2)}) has reached the ceiling, so nothing will be routed.
        </p>
      )}
    </div>
  );
}
