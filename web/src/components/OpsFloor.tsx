import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useLive,
  type AdherenceLogs,
  type ApiErrorResponse,
  type HarnessHealth,
  type JarvisTask,
  type JarvisTasksResponse,
  type LaunchdService,
  type PolymarketClearResponse,
  type PolymarketExclusion,
  type PolymarketExclusionResponse,
  type PolymarketMarket,
  type PolymarketMarketsResponse,
  type PolymarketState,
  type RosterData,
  type ServiceHealth,
  type PortalResponse,
} from '../api';

type ProviderStatus = {
  providers: string[];
  health: Record<string, boolean>;
};

type OpsResponse = {
  launchd: { services: LaunchdService[] };
  adherence: AdherenceLogs;
  roster: RosterData;
};

type MarketRow = {
  id: string;
  market: PolymarketMarket | null;
  exclusion: PolymarketExclusion | null;
};

type PendingExclusion = {
  id: string;
};

type ActionName = 'exclude' | 'include' | 'clear';

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`badge ${ok ? 'badge-success' : 'badge-warning'}`}>{label}</span>;
}

function Metric({ label, value, tone = 'text-hud-text' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="panel-surface px-3 py-2">
      <div className="text-[10px] font-mono text-hud-dim">{label}</div>
      <div className={`mt-1 font-mono text-sm ${tone}`}>{value}</div>
    </div>
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function money(value: number | null | undefined) {
  if (!isFiniteNumber(value)) return '—';
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
}

function price(value: number | null | undefined) {
  if (!isFiniteNumber(value)) return '—';
  return value.toFixed(3);
}

function share(value: number | null | undefined) {
  if (!isFiniteNumber(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function stamp(value: string | null | undefined) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '—';
  return parsed.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function shortId(id: string) {
  if (id.length <= 18) return id;
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}

function isPolymarketTask(task: JarvisTask) {
  if (task.routing?.domain === 'polymarket') return true;
  return (task.assigned_agent ?? '').toLowerCase().startsWith('pm-');
}

function errorText(payload: ApiErrorResponse | null, status: number) {
  const detail = payload?.error;
  if (typeof detail === 'string') return detail || `Request failed with status ${status}`;
  if (detail?.message) return detail.message;
  if (payload?.message) return payload.message;
  return `Request failed with status ${status}`;
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as (T & ApiErrorResponse) | null;
  if (!response.ok) throw new Error(errorText(payload ?? null, response.status));
  if ((payload as ApiErrorResponse | null)?.ok === false) {
    throw new Error(errorText(payload ?? null, response.status));
  }
  return payload as T;
}

export default function OpsFloor() {
  const { data: serviceHealth, error: serviceError } = useLive<ServiceHealth>('/api/services/health');
  const { data: portal, error: portalError } = useLive<PortalResponse>('/api/portal');
  const { data: harness, error: harnessError } = useLive<HarnessHealth>('/api/harness/health');
  const { data: providers, error: providerError } = useLive<ProviderStatus>('/api/llm/providers');
  const { data: ops, error: opsError } = useLive<OpsResponse>('/api/trading/ops');
  const { data: polymarket, error: polymarketError, refresh: refreshPolymarket } = useLive<PolymarketState>('/api/polymarket');
  const { data: polymarketMarkets, error: marketsError, refresh: refreshMarkets } = useLive<PolymarketMarketsResponse>('/api/polymarket/markets');
  const { data: jarvisData, error: jarvisError, refresh: refreshJarvisTasks } = useLive<JarvisTasksResponse>('/api/jarvis/tasks');

  const [pendingExclusion, setPendingExclusion] = useState<PendingExclusion | null>(null);
  const [exclusionReason, setExclusionReason] = useState('');
  const [clearOpen, setClearOpen] = useState(false);
  const [clearConfirmation, setClearConfirmation] = useState('');
  const [activeAction, setActiveAction] = useState<ActionName | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [clearResult, setClearResult] = useState<PolymarketClearResponse | null>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);

  const services = serviceHealth?.services ?? [];
  const onlineServices = services.filter(service => service.status === 'online').length;
  const providerNames = providers?.providers ?? [];
  const healthyProviders = providerNames.filter(name => providers?.health?.[name]).length;
  const launchdDefinitions = ops?.launchd?.services?.length ?? 0;
  const adherencePresent = Boolean(ops?.adherence?.log || ops?.adherence?.err);
  const rosterAgents = ops?.roster?.agents?.length ?? 0;

  const gate = polymarket?.gate ?? null;
  const audit = polymarket?.audit ?? null;
  const exclusionsFile = polymarketMarkets?.exclusions ?? null;
  const exclusionsValid = Boolean(exclusionsFile?.valid);
  const polymarketBusy = Boolean(polymarketError || marketsError);
  const tradeCount = polymarket?.trades ?? polymarketMarkets?.summary?.trades ?? null;
  const netPnl = polymarket?.net_pnl ?? null;
  const openPositions = polymarketMarkets?.summary?.open_positions ?? null;
  const marketRows = useMemo<MarketRow[]>(() => {
    const byId = new Map<string, MarketRow>();
    for (const market of polymarketMarkets?.markets ?? []) {
      byId.set(market.market_id, { id: market.market_id, market, exclusion: market.exclusion ?? null });
    }
    for (const exclusion of exclusionsFile?.items ?? []) {
      if (!byId.has(exclusion.market_id)) byId.set(exclusion.market_id, { id: exclusion.market_id, market: null, exclusion });
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [polymarketMarkets, exclusionsFile]);
  const polymarketTasks = useMemo(() => (jarvisData?.tasks ?? []).filter(isPolymarketTask), [jarvisData]);

  useEffect(() => {
    if (pendingExclusion || clearOpen) confirmationRef.current?.focus();
  }, [pendingExclusion, clearOpen]);

  useEffect(() => {
    if (!pendingExclusion && !clearOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || activeAction) return;
      setPendingExclusion(null);
      setExclusionReason('');
      setClearOpen(false);
      setClearConfirmation('');
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [pendingExclusion, clearOpen, activeAction]);

  const resetActionFeedback = () => {
    setActionError(null);
    setActionMessage(null);
  };

  const refreshPolymarketState = () => {
    refreshPolymarket();
    refreshMarkets();
    refreshJarvisTasks();
  };

  const openExclusion = (row: MarketRow) => {
    resetActionFeedback();
    setClearResult(null);
    setPendingExclusion({ id: row.id });
    setExclusionReason('Excluded via Office HUD');
  };

  const submitExclusion = async () => {
    if (!pendingExclusion) return;
    setActiveAction('exclude');
    setActionError(null);
    setActionMessage(null);
    try {
      const result = await postJson<PolymarketExclusionResponse>('/api/polymarket/markets/exclude', {
        market_id: pendingExclusion.id,
        reason: exclusionReason.trim() || 'Excluded via Office HUD',
        confirmed: true,
      });
      setActionMessage(result.changed
        ? `Excluded ${shortId(result.market_id)} · ${result.exclusions.count} excluded`
        : `${shortId(result.market_id)} was already excluded`);
      setPendingExclusion(null);
      setExclusionReason('');
      refreshPolymarketState();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Exclusion rejected');
    } finally {
      setActiveAction(null);
    }
  };

  const submitInclude = async (marketId: string) => {
    setActiveAction('include');
    setActionError(null);
    setActionMessage(null);
    try {
      const result = await postJson<PolymarketExclusionResponse>('/api/polymarket/markets/include', {
        market_id: marketId,
        confirmed: true,
      });
      setActionMessage(result.changed
        ? `Re-included ${shortId(result.market_id)} · ${result.exclusions.count} excluded`
        : `${shortId(result.market_id)} was not excluded`);
      refreshPolymarketState();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Re-inclusion rejected');
    } finally {
      setActiveAction(null);
    }
  };

  const openClearTrades = () => {
    resetActionFeedback();
    setClearResult(null);
    setClearConfirmation('');
    setClearOpen(true);
  };

  const submitClearTrades = async () => {
    if (clearConfirmation !== 'EXECUTE') return;
    setActiveAction('clear');
    setActionError(null);
    setActionMessage(null);
    try {
      const result = await postJson<PolymarketClearResponse>('/api/polymarket/trades/clear', {
        confirmed: true,
        typeConfirmation: clearConfirmation,
      });
      const removed = Object.values(result.cleared ?? {}).reduce((sum, entry) => sum + (entry?.before ?? 0), 0);
      setClearResult(result);
      setActionMessage(`Cleared ${removed} paper records · ${result.backup_path ? `backup ${shortId(result.backup_path)}` : 'backup path unavailable'}`);
      setClearOpen(false);
      setClearConfirmation('');
      refreshPolymarketState();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Paper-trade cleanup rejected');
    } finally {
      setActiveAction(null);
    }
  };

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F9 · 24x7 OPS</h2>
        <div className="flex items-center gap-2">
          <span className="badge badge-info">FLEET READ ONLY</span>
          <span className="badge badge-warning">PAPER TRADING CONTROLS</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
        <Metric label="SERVICE PORTS" value={serviceError ? 'ERROR' : `${onlineServices}/${services.length}`} tone={serviceError ? 'text-hud-red' : 'text-hud-green'} />
        <Metric label="HARNESS" value={harnessError ? 'ERROR' : harness?.status ?? 'CHECKING'} tone={harnessError ? 'text-hud-red' : harness?.ok ? 'text-hud-green' : 'text-hud-amber'} />
        <Metric label="PROVIDERS" value={providerError ? 'ERROR' : `${healthyProviders}/${providerNames.length}`} tone={providerError ? 'text-hud-red' : 'text-hud-green'} />
        <Metric label="ADHERENCE" value={opsError ? 'ERROR' : adherencePresent ? 'LOG PRESENT' : 'NO LOG'} tone={opsError ? 'text-hud-red' : adherencePresent ? 'text-hud-green' : 'text-hud-dim'} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
        <div className="panel p-4 min-w-0">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="font-mono text-hud-amber text-sm">SERVICE PORTS</h3>
            <span className="badge badge-success">
              ONE PORT · {portal?.entryPort ?? '—'} · /port/&lt;service&gt;/
            </span>
          </div>
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Service</th><th>Port</th><th>Role</th><th>State</th><th>Open</th></tr></thead>
              <tbody>
                {portal?.services.map(service => (
                  <tr key={service.slug}>
                    <td>{service.label}</td>
                    <td className="font-mono">{service.port}</td>
                    <td className="text-hud-dim">{service.role}</td>
                    <td><StatusBadge ok={service.status === 'online'} label={service.status === 'online' ? 'LISTENING' : 'OFFLINE'} /></td>
                    <td>
                      <a
                        className="badge badge-warning"
                        href={service.path}
                        target="_blank"
                        rel="noreferrer"
                      >
                        OPEN
                      </a>
                    </td>
                  </tr>
                ))}
                {!portal && services.map(service => (
                  <tr key={service.port}>
                    <td>{service.name}</td>
                    <td className="font-mono">{service.port}</td>
                    <td className="text-hud-dim">{service.role}</td>
                    <td><StatusBadge ok={service.status === 'online'} label={service.status === 'online' ? 'LISTENING' : 'OFFLINE'} /></td>
                    <td className="text-hud-dim">—</td>
                  </tr>
                ))}
                {services.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-hud-dim">{serviceError || portalError ? 'Service status unavailable' : 'Loading service status…'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">PROVIDER HEALTH</h3>
          <div className="space-y-2">
            {providerNames.map(name => {
              const healthy = providers?.health?.[name] === true;
              return (
                <div key={name} className="panel-surface px-3 py-2 flex items-center justify-between">
                  <span className="font-mono text-xs">{name}</span>
                  <StatusBadge ok={healthy} label={providerError ? 'UNKNOWN' : healthy ? 'HEALTHY' : 'UNHEALTHY'} />
                </div>
              );
            })}
            {providerNames.length === 0 && <div className="text-hud-dim text-xs py-4">{providerError ? 'Provider status unavailable' : 'Loading providers…'}</div>}
          </div>
        </div>
      </div>

      <div className="panel p-4 mb-6 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h3 className="font-mono text-hud-amber text-sm">POLYMARKET OPERATIONS</h3>
          <div className="flex items-center gap-2">
            <span className={`badge ${polymarketBusy ? 'badge-danger' : polymarket?.present ? 'badge-success' : 'badge-neutral'}`}>
              {polymarketBusy
                ? 'FEED ERROR'
                : !polymarket
                  ? 'LOADING'
                  : polymarket.present
                    ? `ENGINE ${polymarket.mode?.toUpperCase() ?? 'PRESENT'}`
                    : 'NO ENGINE STATE'}
            </span>
            <button type="button" className="btn btn-sm" onClick={refreshPolymarketState}>REFRESH</button>
            <button type="button" className="btn btn-sm btn-danger" onClick={openClearTrades} disabled={!polymarket?.present || Boolean(activeAction)}>CLEAR PAPER TRADES</button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
          <Metric label="ENGINE STATE" value={polymarketError ? 'ERROR' : polymarket ? (polymarket.present ? (polymarket.mode ?? 'present').toUpperCase() : 'ABSENT') : 'LOADING'} tone={polymarketError ? 'text-hud-red' : polymarket?.present ? 'text-hud-green' : 'text-hud-dim'} />
          <Metric label="PAPER TRADES" value={polymarketError || marketsError ? 'ERROR' : tradeCount === null ? '—' : String(tradeCount)} tone={tradeCount === null ? 'text-hud-dim' : 'text-hud-text'} />
          <Metric label="NET P&L" value={polymarketError ? 'ERROR' : money(netPnl)} tone={polymarketError ? 'text-hud-red' : isFiniteNumber(netPnl) ? netPnl < 0 ? 'text-hud-red' : 'text-hud-green' : 'text-hud-dim'} />
          <Metric label="REALIZED EDGE" value={polymarketError ? 'ERROR' : share(polymarket?.realized_edge ?? null)} tone={isFiniteNumber(polymarket?.realized_edge) ? 'text-hud-text' : 'text-hud-dim'} />
          <Metric label="PROFITABILITY GATE" value={polymarketError ? 'ERROR' : gate ? gate.status ?? 'UNKNOWN' : 'NO GATE FILE'} tone={gate?.requirements_met ? 'text-hud-green' : gate ? 'text-hud-amber' : 'text-hud-dim'} />
          <Metric label="EXCLUSIONS" value={marketsError ? 'ERROR' : exclusionsFile ? exclusionsFile.valid ? String(exclusionsFile.count ?? 0) : 'INVALID' : '—'} tone={marketsError || (exclusionsFile && !exclusionsFile.valid) ? 'text-hud-red' : 'text-hud-text'} />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 mb-4">
          <div className="panel-surface px-3 py-2">
            <div className="text-[10px] font-mono text-hud-dim">SIGNAL AUDIT</div>
            <div className="mt-1 font-mono text-sm">
              {polymarketError ? 'ERROR' : audit ? `${audit.allowed} allowed / ${audit.rejected} rejected of ${audit.total}` : '—'}
            </div>
          </div>
          <div className="panel-surface px-3 py-2">
            <div className="text-[10px] font-mono text-hud-dim">OPEN POSITIONS</div>
            <div className="mt-1 font-mono text-sm">{marketsError ? 'ERROR' : openPositions ?? '—'}</div>
          </div>
          <div className="panel-surface px-3 py-2">
            <div className="text-[10px] font-mono text-hud-dim">ENGINE STATE UPDATED</div>
            <div className="mt-1 font-mono text-sm">{polymarketError ? 'ERROR' : stamp(polymarket?.updated_at ?? null)}</div>
          </div>
        </div>

        {actionError && <p className="text-hud-red text-xs font-mono mb-3" role="alert">Action failed: {actionError}</p>}
        {actionMessage && <p className="text-hud-green text-xs font-mono mb-3" role="status">{actionMessage}</p>}
        {clearResult && <p className="text-hud-dim text-xs font-mono mb-3">Cleanup preserved {clearResult.preserved.signal_history_count} signals · backup {clearResult.backup_path || '—'}</p>}

        <div className="table-container mb-4">
          <table className="table">
            <thead><tr><th>Market</th><th>Trades</th><th>Signals</th><th>Positions</th><th>Last Price</th><th>Categories</th><th>State</th><th>Action</th></tr></thead>
            <tbody>
              {marketRows.map(row => (
                <tr key={row.id}>
                  <td className="font-mono text-xs" title={row.id}>{shortId(row.id)}</td>
                  <td className="font-mono">{row.market?.trades ?? '—'}</td>
                  <td className="font-mono">{row.market?.signals ?? '—'}</td>
                  <td className="font-mono">{row.market ? row.market.open_positions : '—'}</td>
                  <td className="font-mono">{price(row.market?.last_price ?? null)}</td>
                  <td className="text-hud-dim text-xs">{row.market?.categories?.length ? row.market.categories.join(', ') : '—'}</td>
                  <td>{row.exclusion ? <span className="badge badge-danger">EXCLUDED</span> : row.market ? <span className="badge badge-success">ACTIVE</span> : <span className="badge badge-neutral">NO STATE</span>}</td>
                  <td>
                    {row.exclusion ? (
                      <button type="button" className="btn btn-sm" onClick={() => submitInclude(row.id)} disabled={Boolean(activeAction) || !exclusionsValid}>RE-INCLUDE</button>
                    ) : (
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => openExclusion(row)} disabled={Boolean(activeAction) || !exclusionsValid}>EXCLUDE</button>
                    )}
                  </td>
                </tr>
              ))}
              {marketRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-hud-dim">
                    {marketsError
                      ? `Market feed unavailable: ${marketsError}`
                      : !polymarketMarkets
                        ? 'Loading Polymarket markets…'
                        : 'No Polymarket markets recorded in the local engine state.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {exclusionsFile && !exclusionsFile.valid && (
          <p className="text-hud-red text-xs font-mono mb-3" role="alert">Exclusion file invalid: {exclusionsFile.error ?? 'unknown error'} · mutation disabled</p>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="panel-surface p-3 min-w-0">
            <div className="text-[10px] font-mono text-hud-dim mb-2">MARKET EXCLUSIONS</div>
            <div className="space-y-2">
              {exclusionsFile?.items.map(exclusion => (
                <div key={exclusion.market_id} className="panel-surface px-3 py-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-xs truncate" title={exclusion.market_id}>{shortId(exclusion.market_id)}</div>
                    <div className="text-[10px] font-mono text-hud-dim truncate" title={exclusion.reason}>{exclusion.reason}</div>
                    <div className="text-[10px] font-mono text-hud-dim">{stamp(exclusion.excluded_at)}</div>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => submitInclude(exclusion.market_id)} disabled={Boolean(activeAction) || !exclusionsValid}>RE-INCLUDE</button>
                </div>
              ))}
              {!exclusionsFile?.items.length && (
                <div className="text-hud-dim text-xs">
                  {marketsError
                    ? 'Exclusion list unavailable.'
                    : !polymarketMarkets
                      ? 'Loading exclusion list…'
                      : exclusionsFile && !exclusionsFile.valid
                        ? 'Exclusion file could not be parsed.'
                        : 'No markets excluded.'}
                </div>
              )}
            </div>
          </div>

          <div className="panel-surface p-3 min-w-0">
            <div className="text-[10px] font-mono text-hud-dim mb-2">POLYMARKET JEV HISTORY</div>
            <div className="space-y-2">
              {polymarketTasks.slice(0, 8).map(task => (
                <div key={task.task_id} className="panel-surface px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-hud-amber">{task.status}</span>
                    <span className="font-mono text-[10px] text-hud-dim">{stamp(task.updated_at ?? task.created_at)}</span>
                  </div>
                  <div className="font-mono text-xs truncate" title={task.title}>{task.title}</div>
                  <div className="text-[10px] font-mono text-hud-dim">
                    {task.assigned_agent ?? 'auto-route'}
                    {task.routing?.resolved_target ? ` · ${task.routing.resolved_target}` : ''}
                    {task.risk === 'destructive' ? ' · destructive' : ''}
                  </div>
                </div>
              ))}
              {!polymarketTasks.length && (
                <div className="text-hud-dim text-xs">{jarvisError ? `JEV history unavailable: ${jarvisError}` : 'No Polymarket-routed JEV commands yet.'}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">ADHERENCE / RUNTIME</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-hud-dim">Launchd definitions</span><span className="font-mono">{opsError ? 'ERROR' : launchdDefinitions}</span></div>
            <div className="flex justify-between"><span className="text-hud-dim">Adherence log</span><span className={`font-mono ${adherencePresent ? 'text-hud-green' : 'text-hud-dim'}`}>{opsError ? 'ERROR' : adherencePresent ? 'PRESENT' : 'MISSING'}</span></div>
            <div className="flex justify-between"><span className="text-hud-dim">Roster agents</span><span className="font-mono">{opsError ? 'ERROR' : rosterAgents}</span></div>
            <div className="flex justify-between"><span className="text-hud-dim">Harness route</span><span className="font-mono text-xs truncate max-w-[60%]" title={`${harness?.provider ?? ''}:${harness?.model ?? ''}`}>{harnessError ? 'ERROR' : `${harness?.provider ?? '—'}:${harness?.model ?? '—'}`}</span></div>
          </div>
        </div>

        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">SECURITY BOUNDARY</h3>
          <div className="panel-surface p-4 text-xs text-hud-dim leading-5">
            Credential values and key suffixes are intentionally not rendered on this floor. Fleet, provider, and adherence state stay read only. The Polymarket panel above is the single write surface: it mutates local paper records and the market exclusion list only, always behind an explicit confirmation, and never places a live order.
          </div>
        </div>
      </div>

      {pendingExclusion && (
        <div className="jarvis-modal-backdrop" onClick={() => { if (!activeAction) { setPendingExclusion(null); setExclusionReason(''); } }}>
          <section className="jarvis-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="ops-exclude-title" onClick={event => event.stopPropagation()}>
            <div className="jarvis-panel-heading">
              <div><span className="jarvis-kicker">MARKET EXCLUSION</span><h2 id="ops-exclude-title">Exclude market from paper engine?</h2></div>
              <button type="button" className="jarvis-modal-close" onClick={() => setPendingExclusion(null)} disabled={Boolean(activeAction)} aria-label="Close confirmation">×</button>
            </div>
            <div className="jarvis-confirm-card">
              <span>MARKET</span>
              <p className="font-mono break-all">{pendingExclusion.id}</p>
              <div><span>local paper exclusion list</span><span>{exclusionsFile?.count === null || exclusionsFile?.count === undefined ? 'exclusion count unavailable' : `${exclusionsFile.count} currently excluded`}</span><span className="text-alert">BLOCKS NEW SIGNALS</span></div>
            </div>
            <label className="mt-3 flex flex-col gap-2 font-mono text-[10px] uppercase tracking-widest text-hud-dim">
              Reason
              <input ref={confirmationRef} className="input normal-case" value={exclusionReason} onChange={event => setExclusionReason(event.target.value)} maxLength={500} autoComplete="off" />
            </label>
            <div className="jarvis-confirm-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setPendingExclusion(null)} disabled={Boolean(activeAction)}>Cancel</button>
              <button type="button" className="jarvis-confirm-submit" onClick={submitExclusion} disabled={Boolean(activeAction)}>{activeAction === 'exclude' ? 'Excluding…' : 'Confirm exclude'}</button>
            </div>
          </section>
        </div>
      )}

      {clearOpen && (
        <div className="jarvis-modal-backdrop" onClick={() => { if (!activeAction) { setClearOpen(false); setClearConfirmation(''); } }}>
          <section className="jarvis-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="ops-clear-title" onClick={event => event.stopPropagation()}>
            <div className="jarvis-panel-heading">
              <div><span className="jarvis-kicker">PAPER TRADE CLEANUP</span><h2 id="ops-clear-title">Clear local paper trade history?</h2></div>
              <button type="button" className="jarvis-modal-close" onClick={() => setClearOpen(false)} disabled={Boolean(activeAction)} aria-label="Close confirmation">×</button>
            </div>
            <div className="jarvis-confirm-card">
              <span>SCOPE</span>
              <p>Empties trade history, orders, fills, and positions in the local Polymarket engine state. Signal history, order books, price history, and the audit log are preserved, and a timestamped backup is written before the file is replaced.</p>
              <div><span>{tradeCount === null ? 'unknown' : tradeCount} trades</span><span>{openPositions === null ? 'unknown' : openPositions} open positions</span><span className="text-alert">IRREVERSIBLE</span></div>
            </div>
            <label className="jarvis-type-confirm">
              Type <strong>EXECUTE</strong> to authorize
              <input ref={confirmationRef} value={clearConfirmation} onChange={event => setClearConfirmation(event.target.value.toUpperCase())} autoComplete="off" />
            </label>
            <div className="jarvis-confirm-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setClearOpen(false)} disabled={Boolean(activeAction)}>Cancel</button>
              <button type="button" className="jarvis-confirm-submit" onClick={submitClearTrades} disabled={Boolean(activeAction) || clearConfirmation !== 'EXECUTE'}>{activeAction === 'clear' ? 'Clearing…' : 'Clear paper trades'}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
