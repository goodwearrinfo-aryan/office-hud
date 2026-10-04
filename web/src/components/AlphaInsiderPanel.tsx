import { useEffect, useMemo, useState } from 'react';
import { useLive, type AlphaInsiderPosition, type AlphaInsiderStatus, type AlphaInsiderStrategy } from '../api';

type StrategyPayload = { response?: Array<Record<string, unknown>> };
type PositionPayload = { response?: Array<Record<string, unknown>> };
type PollerPayload = {
  present?: boolean;
  status?: string;
  strategy_value?: number | string | null;
  open_positions_count?: number | null;
  cash_value?: number | null;
  positions?: Array<Record<string, unknown>>;
  last_run?: string | null;
};

function value(input: unknown, fallback: string) {
  if (input === null || input === undefined || input === '') return fallback;
  return String(input);
}

/** Provider numerics arrive as decimal strings; keep significant digits honest. */
function decimal(input: unknown, digits: number): string {
  const parsed = typeof input === 'number' ? input : Number(input);
  if (input === null || input === undefined || input === '' || !Number.isFinite(parsed)) return '—';
  return parsed.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function parseStrategies(payload: StrategyPayload | null): AlphaInsiderStrategy[] {
  return (payload?.response ?? []).map((record, index) => ({
    id: value(record.strategy_id ?? record.id, `strategy-${index}`),
    name: value(record.strategy_name ?? record.name, `Strategy ${index + 1}`),
    type: value(record.strategy_type ?? record.type, 'unknown'),
    status: value(record.status, 'unknown'),
    source: 'alphainsider',
    note: 'Reported by AlphaInsider',
  }));
}

function parsePositions(payload: PositionPayload | null): AlphaInsiderPosition[] {
  return (payload?.response ?? []).map((record, index) => ({
    // The provider sends amount/price/total. It never sends quantity, entry,
    // mark or pnl - reading those names made every cell render as a dash.
    symbol: value(record.symbol ?? record.stock, `position-${index}`),
    side: value(record.side, 'LONG'),
    quantity: value(record.amount, '—'),
    entry: '—',
    mark: value(record.price, '—'),
    pnl: '—',
    pnlPercent: '—',
  }));
}

export default function AlphaInsiderPanel() {
  const { data: status, error: statusError, refresh: refreshStatus } = useLive<AlphaInsiderStatus>('/api/alphainsider/status');
  const { data: strategyData, error: strategyError, refresh: refreshStrategies } = useLive<StrategyPayload>('/api/alphainsider/strategies');
  const { data: poller, error: pollerError, refresh: refreshPoller } = useLive<PollerPayload>('/api/alphainsider/poller');
  const [positions, setPositions] = useState<AlphaInsiderPosition[]>([]);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const strategies = useMemo(() => parseStrategies(strategyData), [strategyData]);
  const strategyId = strategies[0]?.id;

  useEffect(() => {
    if (!strategyId) {
      setPositions([]);
      setPositionsError(null);
      return undefined;
    }
    const controller = new AbortController();
    setPositionsError(null);
    fetch(`/api/alphainsider/positions?strategy_id=${encodeURIComponent(strategyId)}`, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error(`Positions returned ${response.status}`);
        return response.json() as Promise<PositionPayload>;
      })
      .then(payload => setPositions(parsePositions(payload)))
      .catch(error => {
        if (!controller.signal.aborted) setPositionsError(error instanceof Error ? error.message : 'Positions unavailable');
      });
    return () => controller.abort();
  }, [strategyId]);

  const refresh = () => {
    refreshStatus();
    refreshStrategies();
    refreshPoller();
  };

  // Prefer the poller's own view of the book: it already filtered settled cash
  // out, so a fully-closed account reads FLAT instead of "1 open position".
  const pollerPositions = useMemo(
    () => (poller?.positions ?? []).map((record, index) => ({
      symbol: value(record.symbol, `position-${index}`),
      side: value(record.side, 'LONG'),
      quantity: value(record.amount, '—'),
      entry: '—',
      mark: value(record.price, '—'),
      pnl: '—',
      pnlPercent: '—',
    })),
    [poller],
  );
  const hasPollerBook = Boolean(poller?.present) && Array.isArray(poller?.positions);
  const shownPositions = hasPollerBook ? pollerPositions : positions;
  const openCount = hasPollerBook
    ? (poller?.open_positions_count ?? pollerPositions.length)
    : positions.length;
  const equity = hasPollerBook ? poller?.strategy_value : null;
  const cash = hasPollerBook ? poller?.cash_value : null;
  const closedOut = hasPollerBook && openCount === 0;

  return (
    <section className="jarvis-panel jarvis-alpha-panel">
      <div className="jarvis-panel-heading">
        <div><span className="jarvis-kicker">PRIVATE WORKSPACE FEATURE</span><h2>Alpha Insider mirror</h2></div>
        <div className="jarvis-panel-tools"><span className={status?.verified ? 'text-green' : 'text-alert'}>{status?.verified ? 'TOKEN VERIFIED' : status ? 'UNVERIFIED' : 'CHECKING'}</span><button type="button" className="jarvis-floor-task static" onClick={refresh} aria-label="Refresh Alpha Insider data">REFRESH</button></div>
      </div>
      <div className="jarvis-alpha-metrics">
        <div><span>DATA SOURCE</span><strong>{status ? 'LIVE API' : statusError ? 'OFFLINE' : 'CONNECTING'}</strong></div>
        <div><span>STRATEGIES</span><strong>{strategies.length || '—'}</strong></div>
        <div><span>OPEN LEGS</span><strong>{hasPollerBook ? (openCount || 0) : (positions.length || '—')}</strong></div>
        <div><span>EQUITY</span><strong>{equity === null || equity === undefined ? '—' : decimal(equity, 6)}</strong></div>
        <div><span>CASH AT REST</span><strong>{cash === null || cash === undefined ? '—' : decimal(cash, 6)}</strong></div>
        <div><span>SCOPES</span><strong>{status?.scopes?.length || '—'}</strong></div>
      </div>
      {strategyError && <p className="jarvis-alpha-error">Strategy feed unavailable: {strategyError}</p>}
      {positionsError && <p className="jarvis-alpha-error">Position feed unavailable: {positionsError}</p>}
      {pollerError && <p className="jarvis-alpha-error">Stats feed unavailable: {pollerError}</p>}
      <div className="jarvis-alpha-grid">
        <div className="jarvis-alpha-list">
          <div className="jarvis-alpha-list-title">STRATEGIES</div>
          {strategies.slice(0, 4).map(strategy => <div className="jarvis-alpha-row" key={strategy.id}><div><strong>{strategy.name}</strong><small>{strategy.id} · {strategy.type}</small></div><span>{strategy.status}</span></div>)}
          {!strategies.length && !strategyError && <div className="jarvis-loading">No strategies reported.</div>}
        </div>
        <div className="jarvis-alpha-list">
          <div className="jarvis-alpha-list-title">OPEN RISK LEGS</div>
          {shownPositions.slice(0, 4).map(position => <div className="jarvis-alpha-row" key={`${position.symbol}-${position.side}`}><div><strong>{position.symbol}</strong><small>{position.side} · amt {position.quantity}</small></div><span>{position.mark}</span></div>)}
          {closedOut
            ? <div className="jarvis-loading">Flat. Cash only — no open legs.</div>
            : !shownPositions.length && !positionsError && <div className="jarvis-loading">No positions reported.</div>}
        </div>
      </div>
      <div className="jarvis-alpha-boundary"><span>READ-ONLY PROVIDER</span><small>OpenAlice mirrors provider signals into its paper book; provider mutation endpoints are not exposed. Equity and cash are the provider's own account figures — a settled cash row is not an open position.</small></div>
    </section>
  );
}
