import { useLive } from '../api';

// F20 OpenAlice Command — the merged OpenAlice trading surface.
//
// Every OpenAlice feed (legs, pipeline, tournament, benchmark, research,
// forward validation, regime outcomes, ETH paper, freetrader) was previously
// only reachable by opening the separate :3002 static dashboards. This floor is
// the single pane of glass: one component, every feed, with honest freshness on
// each one so an operator can never mistake a frozen file for a live signal.

type FeedState = 'missing' | 'live' | 'stale' | 'stalled' | 'unknown_age';

interface Feed {
  name: string;
  exists: boolean;
  data: unknown;
  content_ts: string | null;
  age_sec: number | null;
  state: FeedState;
}

interface Leg {
  id?: string;
  leg?: string;
  symbol?: string;
  pos?: string;
  entry?: number | null;
  stop?: number | null;
  target?: number | null;
  qty?: number | null;
  risk_usd?: number | null;
  upnl?: number | null;
  nlv?: number | null;
  wins?: number;
  losses?: number;
  breakevens?: number;
  winpct?: number | null;
  rr?: number | null;
  backtest?: string | number | null;
  mood?: string;
  mood_source?: string;
  shot_score?: number | null;
  partial_taken?: boolean;
}

interface Strategy {
  name?: string;
  type?: string;
  family?: string;
  pos?: string;
  position?: number;
  signal?: boolean;
  return_pct?: number | null;
  pnl_pct?: number | null;
  pnl?: number | null;
  equity?: number | null;
  wins?: number;
  n?: number;
}

interface Family {
  name?: string;
  kind?: string;
  status?: string;
  balance?: number | null;
  paper_trades?: number | null;
  position_open?: boolean;
  signals?: number | null;
  sandbox?: string | null;
}

interface OpenAlicePayload {
  ts?: string;
  feed_root?: string;
  feeds?: Record<string, Feed>;
  heartbeat?: {
    status?: string;
    current_task?: string;
    current_phase?: string;
    last_successful_action?: string;
    last_verification?: string;
    next_action?: string;
    blocking_error?: string;
    process_status?: Record<string, unknown>;
  } | null;
  legs?: {
    mode?: string;
    execution_enabled?: boolean;
    is_demo?: boolean;
    breakeven?: number | null;
    btc?: number | null;
    total?: number;
    active?: number;
    legs?: Leg[];
  } | null;
  pipeline?: {
    btc?: number | null;
    bot_legs?: { ok?: boolean; total_n?: number; total_pnl?: number; legs?: unknown[] };
    jobs?: { running?: number; total?: number; jobs?: Array<{ label?: string; running?: boolean; pid?: number | null; exit?: string }> };
    agents?: { count?: number; names?: string[] };
    candle?: unknown[];
    honesty?: { ok?: boolean; flags?: unknown[] };
  } | null;
  tournament?: {
    leader?: string | null;
    cycles?: number | null;
    btc?: number | null;
    eth?: number | null;
    funding_btc?: number | null;
    funding_eth?: number | null;
    pairs_z?: number | null;
    basis?: number | null;
    strategies?: Strategy[];
  } | null;
  algo20?: {
    book_total?: number | null;
    book_dd_pct?: number | null;
    btc_price?: number | null;
    n_algos?: number | null;
    profitable?: number | null;
    ts?: string;
  } | null;
  algo_strategies?: Strategy[];
  paper_benchmark?: {
    mode?: string;
    live_orders_allowed?: boolean;
    generated_at?: string | null;
    dashboard?: Record<string, unknown>;
    families?: Family[];
  } | null;
  combined_portfolio?: {
    ok?: boolean;
    ts?: string;
    price?: number;
    combined?: { equity?: number; net?: number | null; return_pct?: number | null };
    components?: Record<string, { weight?: number; equity?: number | null; net?: number | null; status?: string; side?: number | string | null; flips?: number | null }>;
    audit_reference?: { sharpe?: number | null; best_solo_sharpe?: number | null; max_dd_pct?: number | null; return_pct?: number | null; note?: string };
    feed_degraded?: boolean;
    feed_warnings?: string[];
  } | null;
  research_pipeline?: {
    counts?: Record<string, number>;
    modes?: Record<string, number>;
    statuses?: Record<string, number>;
    paper_only?: boolean;
    live_orders_allowed?: boolean;
  } | null;
  regime_outcomes?: {
    evidence_ready?: boolean;
    signals_complete?: number;
    by_horizon?: Record<string, { samples?: number; mean?: number; verdict?: string; bootstrap?: { ci95_low?: number; ci95_high?: number } }>;
    generated_at?: string;
  } | null;
  forward_validation?: {
    kind?: string;
    all_arms_reported?: boolean;
    arms?: Array<{ id?: string; label?: string; trades?: number; return_pct?: number; profit_factor?: number; max_dd_pct?: number; positive_oos_fraction?: number; gates?: { promote?: boolean }; error?: string }>;
    gates?: { inference_floor_trades?: number };
    window?: { bars?: number; bars_added_this_run?: number; first_forward_bar_utc?: string; last_forward_bar_utc?: string };
    selection_rule?: string;
  } | null;
  honesty?: { ok?: boolean; flags?: unknown[]; ts?: string } | null;
  eth_paper?: {
    status?: string;
    mode?: string;
    equity?: number | null;
    cash?: number | null;
    realized_pnl?: number | null;
    unrealized_pnl?: number | null;
    total_return_pct?: number | null;
    fees_paid?: number | null;
    slippage_paid?: number | null;
    position?: { side?: string; size?: number; entry_price?: number; mark?: number; stop_loss?: number; take_profit?: number } | null;
    stats?: { trades?: number; closed?: number; fills?: number; win_rate?: number | null };
  } | null;
  // The freetrader writer has used both spellings of these fields over time, and
// the standalone dashboard reads all of them, so the merged view does too.
  freetrader?: {
    latest_decision?: { action?: string; signal?: string; confidence?: number; symbol?: string; coin?: string; price?: number; reason?: string; rationale?: string } | null;
    status?: string;
    mode?: string;
  } | null;
  screener?: unknown;
}

const FEED_LABELS: Record<string, string> = {
  legs: 'Legs',
  pipeline: 'Pipeline',
  heartbeat: 'Heartbeat',
  tournament: 'Tournament',
  paper_benchmark: 'Benchmark',
  combined_portfolio: 'Portfolio',
  research_pipeline: 'Research',
  regime_outcomes: 'Regime',
  forward_validation: 'Forward OOS',
  honesty: 'Honesty',
  algo20: 'Algo20',
  eth_paper: 'ETH paper',
  freetrader: 'Freetrader',
  screener: 'Screener',
};

function num(value: unknown, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function tone(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 'text-hud-dim';
  return value > 0 ? 'text-hud-green' : 'text-hud-red';
}

function pct(value: unknown, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)}%` : '—';
}

function ageLabel(sec: number | null | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '—';
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

const STATE_TONE: Record<FeedState, string> = {
  live: 'text-hud-green',
  stale: 'text-hud-amber',
  stalled: 'text-hud-red',
  missing: 'text-hud-red',
  unknown_age: 'text-hud-amber',
};

function FeedChip({ id, feed }: { id: string; feed: Feed }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-hud-edge px-2 py-1 font-mono text-[10px]" title={feed.content_ts || feed.name}>
      <span className={STATE_TONE[feed.state]}>{FEED_LABELS[id] || id}</span>
      <span className="text-hud-dim">{ageLabel(feed.age_sec)}</span>
    </span>
  );
}

function Tile({ label, value, detail, valueClass }: { label: string; value: React.ReactNode; detail?: React.ReactNode; valueClass?: string }) {
  return (
    <div className="panel-surface px-3 py-2">
      <div className="text-[10px] font-mono text-hud-dim">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold ${valueClass || 'text-hud-text'}`}>{value}</div>
      {detail ? <div className="mt-0.5 font-mono text-[11px] text-hud-dim">{detail}</div> : null}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="panel-surface">
      <div className="flex items-center justify-between border-b border-hud-edge px-3 py-2">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-hud-amber">{title}</h3>
        {count != null ? <span className="font-mono text-[10px] text-hud-dim">{count}</span> : null}
      </div>
      {children}
    </div>
  );
}

export default function OpenAliceCommand() {
  // useLive exposes data/error/loading; a null data with no error is the
  // not-yet-arrived case, which the waiting tile below already covers.
  const { data, error } = useLive<OpenAlicePayload>('/api/openalice');

  if (error) {
    return (
      <div className="panel-surface p-4">
        <div className="font-mono text-hud-red">openalice feed unavailable: {error}</div>
        <div className="mt-2 font-mono text-[11px] text-hud-dim">
          The route reads the writer tree at ~/trading/openalice/ui/public. Check that the pubserver
          data root exists and that the trading writers are still running.
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="panel-surface px-3 py-2 font-mono text-hud-dim">waiting for the openalice feed…</div>;
  }

  const feeds = data.feeds || {};
  // `|| {}` alone erases the server's honest null, so every `? 'ON' : 'off'`
  // below renders a verified negative for a feed that never answered. Keep the
  // collapse for the member accesses, but remember whether data existed.
  const legsKnown = data.legs != null;
  const legs = data.legs || {};
  const legRows = Array.isArray(legs.legs) ? legs.legs : [];
  const activeRows = legRows.filter(leg => String(leg.pos || 'flat').toLowerCase() !== 'flat');
  const tournament = data.tournament || {};
  const strategies = Array.isArray(tournament.strategies) ? tournament.strategies : [];
  const algoRows = Array.isArray(data.algo_strategies) ? data.algo_strategies : [];
  const combined = data.combined_portfolio || {};
  const combinedTotals = combined.combined || {};
  const audit = combined.audit_reference || {};
  const benchmark = data.paper_benchmark || {};
  const families = Array.isArray(benchmark.families) ? benchmark.families : [];
  const pipelineKnown = data.pipeline != null;
  const pipeline = data.pipeline || {};
  const jobs = Array.isArray(pipeline.jobs?.jobs) ? pipeline.jobs!.jobs! : [];
  // The `|| {}` fallback widens Object.entries to unknown, so the value type is
// pinned here rather than being inferred through the union.
  const components = Object.entries<{ weight?: number; equity?: number | null; net?: number | null; status?: string; side?: number | string | null; flips?: number | null }>(combined.components || {});
  const forward = data.forward_validation || {};
  const forwardArms = Array.isArray(forward.arms) ? forward.arms : [];
  const floor = forward.gates?.inference_floor_trades ?? 30;
  const regime = data.regime_outcomes || {};
  const horizons = Object.entries<{ samples?: number; mean?: number; verdict?: string; bootstrap?: { ci95_low?: number; ci95_high?: number } }>(regime.by_horizon || {});
  const eth = data.eth_paper || {};
  const heartbeat = data.heartbeat || {};
  const processStatus = Object.entries(heartbeat.process_status || {});
  const honestyKnown = data.honesty != null;
  const honesty = data.honesty || {};
  const decision = data.freetrader?.latest_decision || null;
  const research = data.research_pipeline || {};
  const algoKnown = data.algo20 != null;
  const algo = data.algo20 || {};
  const liveFeeds = Object.values(feeds).filter(f => f?.state === 'live').length;
  const totalFeeds = Object.keys(feeds).length;

  return (
    <div className="space-y-3">
      {/* Freshness rail: the whole floor is only as trustworthy as these ages. */}
      <div className="panel-surface px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-hud-dim">
            Feed freshness {liveFeeds}/{totalFeeds} live
          </span>
          {Object.entries(feeds).map(([id, feed]) => <FeedChip key={id} id={id} feed={(feed || {}) as Feed} />)}
          
        </div>
        {combined.feed_degraded ? (
          <div className="mt-2 font-mono text-[10px] text-hud-red">
            portfolio feed degraded{Array.isArray(combined.feed_warnings) && combined.feed_warnings.length ? `: ${combined.feed_warnings.join(', ')}` : ''}
          </div>
        ) : null}
      </div>

      {/* Headline */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile
          label="TOURNAMENT LEADER"
          value={tournament.leader || '—'}
          detail={`${pct(strategies[0]?.return_pct)} · ${num(tournament.cycles, 0)} cycles`}
          valueClass={strategies[0]?.return_pct != null ? tone(strategies[0].return_pct) : undefined}
        />
        <Tile
          label="COMBINED NET"
          value={num(combinedTotals.net)}
          detail={combinedTotals.return_pct != null ? `${pct(combinedTotals.return_pct)} · equity ${num(combinedTotals.equity)}` : undefined}
          valueClass={tone(combinedTotals.net)}
        />
        <Tile
          label="OPEN LEGS"
          value={legsKnown ? `${legs.active ?? 0} / ${legs.total ?? 0}` : 'n/a'}
          detail={legsKnown
            ? `${String(legs.mode ?? 'unknown').toUpperCase()} · execution ${legs.execution_enabled == null ? 'unknown' : legs.execution_enabled ? 'ON' : 'off'}`
            : 'legs feed unavailable - execution state unknown'}
          valueClass={(legs.active ?? 0) > 0 ? 'text-hud-amber' : 'text-hud-dim'}
        />
        <Tile
          label="HEARTBEAT"
          value={String(heartbeat.status || 'unknown').toUpperCase()}
          detail={heartbeat.blocking_error ? `blocked: ${heartbeat.blocking_error}` : heartbeat.current_phase || undefined}
          valueClass={heartbeat.status === 'ok' ? 'text-hud-green' : heartbeat.status ? 'text-hud-amber' : 'text-hud-dim'}
        />
        <Tile
          label="ETH 1h PAPER"
          value={pct(eth.total_return_pct, 3)}
          detail={eth.stats ? `${eth.stats.closed ?? 0} closed · WR ${pct((eth.stats.win_rate ?? 0) * 100, 1)}` : undefined}
          valueClass={tone(eth.total_return_pct)}
        />
        <Tile
          label="MODE / ORDERS"
          value={String(benchmark.mode || '—').toUpperCase()}
          detail={benchmark.live_orders_allowed ? 'LIVE ORDERS ALLOWED' : research.live_orders_allowed ? 'paper blocked' : 'paper only'}
          valueClass={benchmark.live_orders_allowed ? 'text-hud-red' : 'text-hud-green'}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {/* Legs */}
        <Section title="Live legs" count={`${activeRows.length} open / ${legRows.length} tracked`}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-hud-edge">
                  {['SYMBOL', 'LEG', 'POS', 'ENTRY', 'STOP', 'TARGET', 'U-PNL', 'MOOD', 'SHOT', 'WIN%'].map(h => (
                    <th key={h} className="px-2 py-1.5 text-left font-mono text-[9px] text-hud-dim">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {legRows.length === 0 ? (
                  <tr><td colSpan={10} className="px-2 py-3 font-mono text-[11px] text-hud-dim">no leg records</td></tr>
                ) : legRows.map((leg, i) => {
                  const pos = String(leg.pos || 'flat').toUpperCase();
                  const posTone = pos === 'LONG' ? 'text-hud-green' : pos === 'SHORT' ? 'text-hud-red' : 'text-hud-dim';
                  const shot = typeof leg.shot_score === 'number' ? leg.shot_score : null;
                  return (
                    <tr key={leg.id || `${leg.symbol}-${i}`} className="border-b border-hud-edge/60 last:border-0">
                      <td className="px-2 py-1.5 font-mono text-[11px]">{leg.symbol || '—'}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-hud-dim">{leg.leg || '—'}</td>
                      <td className={`px-2 py-1.5 font-mono text-[11px] ${posTone}`}>{pos}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-hud-dim">{num(leg.entry, 1)}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-hud-dim">{num(leg.stop, 1)}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-hud-dim">{num(leg.target, 1)}</td>
                      <td className={`px-2 py-1.5 font-mono text-[11px] ${tone(leg.upnl)}`}>{num(leg.upnl)}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-hud-dim">{leg.mood || '—'}</td>
                      <td className={`px-2 py-1.5 font-mono text-[11px] ${shot == null ? 'text-hud-dim' : shot >= 70 ? 'text-hud-green' : shot >= 45 ? 'text-hud-amber' : 'text-hud-red'}`}>
                        {shot == null ? '—' : shot.toFixed(0)}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-hud-dim">{leg.winpct == null ? '—' : `${leg.winpct.toFixed(0)}%`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-hud-edge px-3 py-1.5 font-mono text-[10px] text-hud-dim">
            breakeven {pct(legs.breakeven, 1)} · BTC ref {num(legs.btc, 0)} · demo {legs.is_demo ? 'yes' : 'no'}
          </div>
        </Section>

        {/* Tournament */}
        <Section title="Tournament" count={`${strategies.length} strategies`}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-hud-edge px-3 py-2 md:grid-cols-4">
            {[
              ['BTC', num(tournament.btc, 0)],
              ['ETH', num(tournament.eth, 2)],
              ['BTC FUNDING', tournament.funding_btc == null ? '—' : `${(tournament.funding_btc * 100).toFixed(4)}%`],
              ['ETH FUNDING', tournament.funding_eth == null ? '—' : `${(tournament.funding_eth * 100).toFixed(4)}%`],
              ['BASIS', num(tournament.basis, 2)],
              ['PAIRS Z', num(tournament.pairs_z, 3)],
              ['CYCLES', num(tournament.cycles, 0)],
              ['LEADER', tournament.leader || '—'],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2 font-mono text-[10px]">
                <span className="text-hud-dim">{label}</span>
                <span className="text-hud-text">{value}</span>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-hud-edge">
                  {['#', 'STRATEGY', 'FAMILY', 'POS', 'RETURN', 'EQUITY', 'W/N'].map(h => (
                    <th key={h} className="px-2 py-1.5 text-left font-mono text-[9px] text-hud-dim">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {strategies.length === 0 ? (
                  <tr><td colSpan={7} className="px-2 py-3 font-mono text-[11px] text-hud-dim">no tournament strategies</td></tr>
                ) : strategies.map((s, i) => {
                  const pos = String(s.pos || 'flat').toUpperCase();
                  return (
                    <tr key={s.name || i} className="border-b border-hud-edge/60 last:border-0">
                      <td className="px-2 py-1.5 font-mono text-[10px] text-hud-dim">{i + 1}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px]">{s.name || '—'}</td>
                      <td className="px-2 py-1.5 font-mono text-[10px] text-hud-dim">{s.type || '—'}</td>
                      <td className={`px-2 py-1.5 font-mono text-[10px] ${pos === 'LONG' ? 'text-hud-green' : pos === 'SHORT' ? 'text-hud-red' : 'text-hud-dim'}`}>{pos}</td>
                      <td className={`px-2 py-1.5 font-mono text-[11px] ${tone(s.return_pct)}`}>{pct(s.return_pct)}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-hud-dim">{num(s.equity)}</td>
                      <td className="px-2 py-1.5 font-mono text-[10px] text-hud-dim">{s.wins ?? 0}/{s.n ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>

        {/* Combined portfolio */}
        <Section title="Combined portfolio" count={audit.sharpe != null ? `sharpe ${num(audit.sharpe)}` : 'sharpe suppressed'}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-hud-edge px-3 py-2 md:grid-cols-4">
            {[
              ['EQUITY', num(combinedTotals.equity)],
              ['NET', num(combinedTotals.net)],
              ['RETURN', pct(combinedTotals.return_pct)],
              ['MAX DD', pct(audit.max_dd_pct)],
              ['BEST SOLO', num(audit.best_solo_sharpe)],
              ['RESEARCH', pct(audit.return_pct)],
              ['PRICE', num(combined.price, 0)],
              ['BOOK', num(algo.book_total)],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2 font-mono text-[10px]">
                <span className="text-hud-dim">{label}</span>
                <span className="text-hud-text">{value}</span>
              </div>
            ))}
          </div>
          <div className="px-3 py-2">
            {components.length === 0 ? (
              <div className="font-mono text-[11px] text-hud-dim">no components reported</div>
            ) : components.map(([name, comp]) => {
              const weight = comp.weight ?? 0;
              return (
                <div key={name} className="border-b border-hud-edge/40 py-1 last:border-0">
                  <div className="flex items-baseline justify-between gap-2 font-mono text-[11px]">
                    <span>{name}</span>
                    <span className={tone(comp.net)}>{(weight * 100).toFixed(1)}% · {num(comp.net)}</span>
                  </div>
                  <div className="mt-0.5 h-0.5 rounded bg-hud-dim/30">
                    <div className="h-full rounded bg-hud-accent" style={{ width: `${Math.min(100, Math.max(1, Math.round(weight * 120)))}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Section>

        {/* Pipeline */}
        <Section title="Pipeline & jobs" count={pipelineKnown ? `${pipeline.jobs?.running ?? 0}/${pipeline.jobs?.total ?? 0} running` : 'n/a running'}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-hud-edge px-3 py-2 md:grid-cols-4">
            {[
              ['BOT LEGS', num(pipeline.bot_legs?.legs?.length ?? 0, 0)],
              ['BOOK P&L', num(pipeline.bot_legs?.total_pnl)],
              ['BOT N', num(pipeline.bot_legs?.total_n, 0)],
              ['AGENTS', pipelineKnown ? num(pipeline.agents?.count, 0) : 'n/a'],
              ['ALGOS', algoKnown ? num(algo.n_algos, 0) : 'n/a'],
              ['PROFITABLE', algoKnown ? num(algo.profitable, 0) : 'n/a'],
              ['BOOK DD', algoKnown ? pct(algo.book_dd_pct) : 'n/a'],
              ['HONESTY', honestyKnown ? (honesty.ok ? 'ok' : 'flags') : 'n/a'],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2 font-mono text-[10px]">
                <span className="text-hud-dim">{label}</span>
                <span className="text-hud-text">{value}</span>
              </div>
            ))}
          </div>
          <div className="max-h-44 overflow-y-auto">
            {jobs.length === 0 ? (
              <div className="px-3 py-2 font-mono text-[11px] text-hud-dim">no jobs reported</div>
            ) : jobs.map(job => (
              <div key={job.label} className="flex items-center justify-between gap-2 border-b border-hud-edge/40 px-3 py-1 font-mono text-[10px] last:border-0">
                <span className="truncate text-hud-text">{String(job.label || '').replace('com.aryan.', '')}</span>
                <span className={job.running ? 'text-hud-green' : 'text-hud-dim'}>
                  {job.running ? `running ${job.pid ?? ''}` : `stopped exit ${job.exit ?? '—'}`}
                </span>
              </div>
            ))}
          </div>
        </Section>

        {/* Algo20 */}
        <Section title="Algo20 strategies" count={`${algoRows.length} in race`}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-hud-edge">
                  {['#', 'STRATEGY', 'RETURN', 'P&L', 'EQUITY', 'POS', 'SIGNAL'].map(h => (
                    <th key={h} className="px-2 py-1.5 text-left font-mono text-[9px] text-hud-dim">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {algoRows.length === 0 ? (
                  <tr><td colSpan={7} className="px-2 py-3 font-mono text-[11px] text-hud-dim">no algo20 strategies</td></tr>
                ) : algoRows.map((s, i) => {
                  const ret = s.return_pct ?? s.pnl_pct;
                  return (
                    <tr key={s.name || i} className="border-b border-hud-edge/60 last:border-0">
                      <td className="px-2 py-1.5 font-mono text-[10px] text-hud-dim">{i + 1}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px]">{s.name || '—'}</td>
                      <td className={`px-2 py-1.5 font-mono text-[11px] ${tone(ret)}`}>{pct(ret)}</td>
                      <td className={`px-2 py-1.5 font-mono text-[11px] ${tone(s.pnl)}`}>{num(s.pnl)}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-hud-dim">{num(s.equity)}</td>
                      <td className="px-2 py-1.5 font-mono text-[10px] text-hud-dim">{s.position ? `L ${s.position}` : 'flat'}</td>
                      <td className={`px-2 py-1.5 font-mono text-[10px] ${s.signal ? 'text-hud-green' : 'text-hud-dim'}`}>{s.signal ? 'signal' : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>

        {/* Paper benchmark families */}
        <Section title="Benchmark families" count={`${families.length} families`}>
          <div className="max-h-64 overflow-y-auto">
            {families.length === 0 ? (
              <div className="px-3 py-2 font-mono text-[11px] text-hud-dim">no families reported</div>
            ) : families.map((f, i) => (
              <div key={f.name || i} className="flex items-center justify-between gap-2 border-b border-hud-edge/40 px-3 py-1 font-mono text-[10px] last:border-0">
                <span className="truncate text-hud-text">{f.name || '—'}</span>
                <span className="flex items-center gap-2">
                  <span className={tone(f.balance)}>{num(f.balance)}</span>
                  <span className="text-hud-dim">{f.paper_trades ?? 0}t</span>
                  <span className={f.position_open ? 'text-hud-amber' : 'text-hud-dim'}>{f.position_open ? 'open' : 'flat'}</span>
                  <span className={f.status === 'ok' || f.status === 'active' ? 'text-hud-green' : f.status ? 'text-hud-amber' : 'text-hud-dim'}>{f.status || '—'}</span>
                </span>
              </div>
            ))}
          </div>
        </Section>

        {/* Forward OOS */}
        <Section title="Forward out-of-sample" count={forward.selection_rule || 'pre-registered'}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-hud-edge px-3 py-2 md:grid-cols-4">
            {[
              ['INFERENCE FLOOR', `${floor} trades`],
              ['WINDOW BARS', num(forward.window?.bars, 0)],
              ['ADDED THIS RUN', num(forward.window?.bars_added_this_run, 0)],
              ['ALL ARMS', forward.all_arms_reported ? 'reported' : 'partial'],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2 font-mono text-[10px]">
                <span className="text-hud-dim">{label}</span>
                <span className="text-hud-text">{value}</span>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-hud-edge">
                  {['ARM', 'TRADES', 'RETURN', 'PF', 'MAX DD', 'POS OOS', 'GATE'].map(h => (
                    <th key={h} className="px-2 py-1.5 text-left font-mono text-[9px] text-hud-dim">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {forwardArms.length === 0 ? (
                  <tr><td colSpan={7} className="px-2 py-3 font-mono text-[11px] text-hud-dim">no registered arms</td></tr>
                ) : forwardArms.map((arm, i) => {
                  const met = (arm.trades ?? 0) >= floor;
                  return (
                    <tr key={arm.id || i} className="border-b border-hud-edge/60 last:border-0">
                      <td className="px-2 py-1.5 font-mono text-[11px]">{arm.id || '—'}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-hud-dim">{arm.trades ?? 0}</td>
                      <td className={`px-2 py-1.5 font-mono text-[11px] ${tone(arm.return_pct)}`}>{pct(arm.return_pct)}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-hud-dim">{num(arm.profit_factor)}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-hud-dim">{pct(arm.max_dd_pct)}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-hud-dim">{num(arm.positive_oos_fraction)}</td>
                      <td className={`px-2 py-1.5 font-mono text-[10px] ${arm.error ? 'text-hud-red' : met ? 'text-hud-green' : 'text-hud-amber'}`}>
                        {arm.error ? 'error' : met ? 'floor met' : 'below floor'}
                        {arm.gates?.promote ? ' · promote' : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>

        {/* Regime outcomes */}
        <Section title="Regime-trend outcomes" count={regime.evidence_ready ? 'evidence ready' : `${regime.signals_complete ?? 0} signals`}>
          <div className="px-3 py-2">
            <div className="mb-2 flex items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${regime.evidence_ready ? 'bg-hud-green/20 text-hud-green' : 'bg-hud-amber/20 text-hud-amber'}`}>
                {regime.evidence_ready ? 'EVIDENCE READY' : 'GATHERING'}
              </span>
              <span className="font-mono text-[10px] text-hud-dim">signals complete {regime.signals_complete ?? 0}</span>
            </div>
            {horizons.length === 0 ? (
              <div className="font-mono text-[11px] text-hud-dim">no horizons reported</div>
            ) : horizons.map(([horizon, stats]) => {
              const verdict = stats.verdict || 'insufficient_samples';
              const verdictTone = verdict === 'positive_ci_excludes_zero' ? 'text-hud-green' : verdict === 'insufficient_samples' ? 'text-hud-amber' : 'text-hud-red';
              return (
                <div key={horizon} className="flex items-center justify-between gap-2 border-b border-hud-edge/40 py-1 font-mono text-[10px] last:border-0">
                  <span className="text-hud-dim">{horizon}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-hud-text">n={stats.samples ?? 0}</span>
                    <span className={tone(stats.mean)}>{stats.mean != null ? `${(stats.mean * 100).toFixed(3)}%` : '—'}</span>
                    <span className={verdictTone}>{verdict.replace(/_/g, ' ')}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </Section>

        {/* Heartbeat */}
        <Section title="Heartbeat & process" count={String(heartbeat.status || 'unknown')}>
          <div className="px-3 py-2 font-mono text-[10px]">
            <div className="mb-1 text-hud-dim">task</div>
            <div className="mb-2 text-hud-text">{heartbeat.current_task || '—'}</div>
            <div className="mb-1 text-hud-dim">last successful action</div>
            <div className="mb-2 text-hud-text">{heartbeat.last_successful_action || '—'}</div>
            <div className="mb-1 text-hud-dim">next</div>
            <div className="mb-2 text-hud-text">{heartbeat.next_action || '—'}</div>
            {heartbeat.blocking_error ? (
              <div className="mb-2 rounded border border-hud-red/40 px-2 py-1 text-hud-red">blocking: {heartbeat.blocking_error}</div>
            ) : null}
            <div className="mb-1 text-hud-dim">process status</div>
            {processStatus.length === 0 ? (
              <div className="text-hud-dim">no process status reported</div>
            ) : processStatus.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 border-b border-hud-edge/40 py-0.5 last:border-0">
                <span className="truncate text-hud-dim">{k}</span>
                <span className={v === false || v === 'down' || v === 'failed' ? 'text-hud-red' : typeof v === 'boolean' || v === 'up' ? 'text-hud-green' : 'text-hud-text'}>
                  {typeof v === 'boolean' ? (v ? 'ok' : 'down') : String(v)}
                </span>
              </div>
            ))}
          </div>
        </Section>

        {/* Signal desk */}
        <Section title="Signal desk" count={data.freetrader?.status || 'freetrader'}>
          <div className="px-3 py-2">
            {decision ? (
              <>
                <div className="mb-2 flex items-baseline gap-3">
                  <span className={`font-mono text-lg font-semibold ${decision.action === 'BUY' || decision.action === 'LONG' ? 'text-hud-green' : decision.action === 'SELL' || decision.action === 'SHORT' ? 'text-hud-red' : 'text-hud-dim'}`}>
                    {decision.action || decision.signal || '—'}
                  </span>
                  <span className="font-mono text-[11px] text-hud-dim">{decision.symbol || decision.coin || '—'}</span>
                  <span className="font-mono text-[11px] text-hud-dim">conf {pct((decision.confidence ?? 0) * 100, 1)}</span>
                </div>
                <div className="font-mono text-[10px] text-hud-dim">{decision.reason || decision.rationale || 'no rationale supplied'}</div>
              </>
            ) : (
              <div className="font-mono text-[11px] text-hud-dim">no model decision recorded</div>
            )}
          </div>
        </Section>
      </div>

      <div className="font-mono text-[10px] text-hud-dim">
        {data.feed_root} · snapshot {data.ts} · paper telemetry, read-only
      </div>
    </div>
  );
}