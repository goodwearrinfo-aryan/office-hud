import { useLive } from '../api';

type Arm = {
  id: string;
  label?: string;
  error?: string | null;
  registration?: string;
  timeframe?: string;
  trades: number;
  return_pct: number | null;
  profit_factor: number | null;
  max_dd_pct: number | null;
  positive_oos_fraction: number | null;
  ci95_low_pct: number | null;
  ci95_high_pct: number | null;
  floor_required: number;
  floor_met: boolean;
  trades_to_floor: number;
  progress_pct: number;
};

type Artifact = { name: string; status?: string; age_seconds: number | null; stale_after_seconds: number | null; updated?: string | null };

type ValidationEvidence = {
  generated_at: string | null;
  window: { bars?: number; first_forward_bar_utc?: string; last_forward_bar_utc?: string; bars_added_this_run?: number };
  preregistration: { sha256?: string; registered_at?: string | null; arm_count?: number };
  inference_floor: number;
  arms: Arm[];
  arms_below_floor: number;
  registrations: { registration_id: string; interval: string; arms: string[]; registered_at?: string; sha256?: string }[];
  promotion: {
    state: string;
    previous_state: string | null;
    changed: boolean;
    entry_allowed: boolean;
    scope: string;
    live_orders_allowed: boolean;
    decided_at: string | null;
    evidence_age_seconds: number | null;
    stale_after_seconds: number | null;
    reasons: string[];
  };
  in_sample_artifacts: Artifact[];
};

const num = (v: number | null | undefined, digits = 2, suffix = '') =>
  v === null || v === undefined || Number.isNaN(v) ? '--' : `${v.toFixed(digits)}${suffix}`;

const age = (s: number | null | undefined) => {
  if (s === null || s === undefined) return '--';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

function Metric({ label, value, tone = 'text-hud-text' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="panel-surface px-3 py-2">
      <div className="text-[10px] font-mono text-hud-dim">{label}</div>
      <div className={`mt-1 font-mono text-sm ${tone}`}>{value}</div>
    </div>
  );
}

function stateTone(state: string) {
  if (state === 'promote') return 'text-hud-green';
  if (state === 'demote') return 'text-hud-red';
  return 'text-hud-amber';
}

export default function ValidationFloor() {
  const { data, error } = useLive<ValidationEvidence>('/api/validationEvidence');

  if (error) {
    return <div className="p-4 font-mono text-sm text-hud-red">validation evidence unavailable: {String(error)}</div>;
  }
  if (!data) {
    return <div className="p-4 font-mono text-sm text-hud-dim">loading validation evidence…</div>;
  }

  const promo = data.promotion;
  const bars = data.window?.bars ?? 0;

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-mono text-hud-text">Forward out-of-sample · pre-registered</h2>
          <p className="text-[10px] font-mono text-hud-dim mt-0.5">
            Params fixed before any post-boundary bar was read. No arm may be added, re-parameterised or dropped afterwards.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`badge ${promo.state === 'promote' ? 'badge-success' : promo.state === 'demote' ? 'badge-danger' : 'badge-warning'}`}>
            {promo.state.toUpperCase()}
          </span>
          <span className="badge badge-neutral">no parameter search</span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <Metric label="Inference floor" value={`${data.inference_floor} trades`} tone={data.arms_below_floor > 0 ? 'text-hud-amber' : 'text-hud-green'} />
        <Metric label="Arms below floor" value={`${data.arms_below_floor} / ${data.arms.length}`} tone={data.arms_below_floor > 0 ? 'text-hud-amber' : 'text-hud-green'} />
        <Metric label="Forward bars" value={String(bars)} />
        <Metric label="Paper entries" value={promo.entry_allowed ? 'ALLOWED' : 'BLOCKED'} tone={promo.entry_allowed ? 'text-hud-green' : 'text-hud-amber'} />
        <Metric label="Live orders" value={promo.live_orders_allowed ? 'ALLOWED' : 'blocked'} tone={promo.live_orders_allowed ? 'text-hud-red' : 'text-hud-dim'} />
        <Metric label="Evidence age" value={`${age(promo.evidence_age_seconds)} / ${age(promo.stale_after_seconds)}`} tone={promo.evidence_age_seconds !== null && promo.stale_after_seconds !== null && promo.evidence_age_seconds > promo.stale_after_seconds ? 'text-hud-red' : 'text-hud-text'} />
      </div>

      <div className="panel-surface p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-hud-dim uppercase">Automated paper promotion</span>
          <span className={`font-mono text-xs ${stateTone(promo.state)}`}>
            {promo.state.toUpperCase()}{promo.changed && promo.previous_state ? ` (was ${promo.previous_state})` : ''}
          </span>
        </div>
        <div className="text-[10px] font-mono text-hud-dim">
          scope {promo.scope} · decided {promo.decided_at ?? '--'} · prereg {data.preregistration.registered_at ?? '--'}
          {data.preregistration.sha256 ? ` · sha ${data.preregistration.sha256.slice(0, 12)}` : ''}
        </div>
        {promo.reasons.length > 0 && (
          <ul className="space-y-1">
            {promo.reasons.map((reason, i) => (
              <li key={i} className="text-[10px] font-mono text-hud-dim">· {reason}</li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="text-[10px] font-mono text-hud-dim uppercase mb-2">Arms · all reported, none selected</div>
        <div className="space-y-2">
          {data.arms.map((arm) => (
            <div key={arm.id} className="panel-surface p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-xs text-hud-text">
                    {arm.id}
                    {arm.timeframe && <span className="ml-2 text-[10px] text-hud-dim">{arm.timeframe}</span>}
                  </div>
                  <div className="text-[10px] font-mono text-hud-dim truncate">{arm.label}</div>
                </div>
                <div className={`font-mono text-[10px] ${arm.floor_met ? 'text-hud-green' : 'text-hud-amber'}`}>
                  {arm.floor_met ? 'FLOOR MET' : `BELOW FLOOR · ${arm.trades_to_floor} to go`}
                </div>
              </div>

              {!arm.error && (
                <>
                  <div className="mt-2 h-1.5 w-full bg-hud-edge rounded overflow-hidden">
                    <div
                      className={`h-full ${arm.floor_met ? 'bg-hud-green' : 'bg-hud-amber'}`}
                      style={{ width: `${arm.progress_pct}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[10px] font-mono text-hud-dim">
                    {arm.trades} / {arm.floor_required} trades to the inference floor ({arm.progress_pct}%)
                  </div>
                  <div className="mt-2 grid grid-cols-3 md:grid-cols-6 gap-2 font-mono text-[10px]">
                    <div><span className="text-hud-dim">ret </span><span className="text-hud-text">{num(arm.return_pct, 2, '%')}</span></div>
                    <div><span className="text-hud-dim">pf </span><span className="text-hud-text">{num(arm.profit_factor, 3)}</span></div>
                    <div><span className="text-hud-dim">dd </span><span className="text-hud-text">{num(arm.max_dd_pct, 2, '%')}</span></div>
                    <div><span className="text-hud-dim">ci95 </span><span className="text-hud-text">{num(arm.ci95_low_pct, 3, '%')}</span></div>
                    <div><span className="text-hud-dim">oos+ </span><span className="text-hud-text">{num(arm.positive_oos_fraction, 2)}</span></div>
                    <div><span className="text-hud-dim">floor </span><span className={arm.floor_met ? 'text-hud-green' : 'text-hud-amber'}>{arm.floor_met ? 'yes' : 'no'}</span></div>
                  </div>
                </>
              )}
              {arm.error && <div className="mt-2 font-mono text-[10px] text-hud-red">error: {arm.error}</div>}
            </div>
          ))}
          {data.arms.length === 0 && <div className="font-mono text-xs text-hud-dim">no arms reported</div>}
        </div>
      </div>

      {data.registrations.length > 0 && (
        <div>
          <div className="text-[10px] font-mono text-hud-dim uppercase mb-2">Registrations · {data.registrations.length}</div>
          <div className="space-y-1">
            {data.registrations.map((reg) => (
              <div key={reg.registration_id} className="panel-surface px-3 py-2 flex items-center justify-between font-mono text-[10px]">
                <span className="text-hud-text">{reg.registration_id}</span>
                <span className="flex items-center gap-3 text-hud-dim">
                  <span>{reg.interval}</span>
                  <span>{reg.arms.join(', ')}</span>
                  <span>registered {reg.registered_at ?? '--'}</span>
                  {reg.sha256 && <span>sha {reg.sha256.slice(0, 12)}</span>}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] font-mono text-hud-dim">
            Arms are grouped by the registration that declared them. An arm absent from every registration can never be
            promoted, and each registration forbids parameter search after the fact.
          </p>
        </div>
      )}

      <div>
        <div className="text-[10px] font-mono text-hud-dim uppercase mb-2">In-sample artifacts · historical record</div>
        <div className="space-y-1">
          {data.in_sample_artifacts.map((a) => (
            <div key={a.name} className="panel-surface px-3 py-2 flex items-center justify-between font-mono text-[10px]">
              <span className="text-hud-text">{a.name}</span>
              <span className="flex items-center gap-3">
                <span className="text-hud-dim">updated {a.updated ?? '--'}</span>
                <span className="text-hud-dim">age {age(a.age_seconds)} / stale after {age(a.stale_after_seconds)}</span>
                <span className={a.status === 'stale' ? 'text-hud-amber' : 'text-hud-green'}>{a.status ?? '--'}</span>
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] font-mono text-hud-dim">
          The generator that produced these was deleted and is not recoverable from any backup, git history, plist, log or shell history.
          The files are the only surviving record of the in-sample result and are version controlled for that reason.
        </p>
      </div>
    </div>
  );
}
