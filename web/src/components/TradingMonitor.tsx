import { useLive } from '../api';

function formatNumber(value: number | null | undefined, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function formatPercentValue(value: number | null | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
}

function formatCurrency(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
}

function tone(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 'text-hud-dim';
  return value > 0 ? 'text-hud-green' : 'text-hud-red';
}

function Metric({ label, value, tone: t }: { label: string; value: string; tone?: string }) {
  return (
    <div className="panel-surface px-3 py-2">
      <div className="text-[10px] font-mono text-hud-dim">{label}</div>
      <div className={`mt-1 font-mono text-sm ${t || 'text-hud-text'}`}>{value}</div>
    </div>
  );
}

function Section({ title, children, error, running }: { title: string; children: React.ReactNode; error?: string | null; running?: boolean }) {
  return (
    <div className="panel p-4 min-w-0 mb-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="font-mono text-hud-amber text-sm">{title}</h3>
        <span className={`badge badge-xs ${running ? 'badge-success' : 'badge-error'}`}>
          {running ? 'RUNNING' : 'STOPPED'}
        </span>
      </div>
      {error && <p className="text-hud-red text-xs mb-2">Error: {error}</p>}
      {children}
    </div>
  );
}

export default function TradingMonitor() {
  const { data: multistrat } = useLive<any>('/api/trading/alphainsider');
  const { data: strategyMonitor } = useLive<any>('/api/trading/strategy-monitor');
  const { data: riskMonitor } = useLive<any>('/api/trading/risk-monitor');
  const { data: marketData } = useLive<any>('/api/trading/market-data');
  const { data: alerts } = useLive<any>('/api/trading/alerts');
  const { data: paperOps } = useLive<any>('/api/trading/paper-ops');
  const { data: performance } = useLive<any>('/api/trading/performance');

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F6 · TRADING MONITOR</h2>
        <span className="badge badge-warning">LIVE · PAPER / TESTNET</span>
      </div>

      {/* Alpha Insider Multistrat */}
      <Section title="ALPHA INSIDER MULTISTRAT" running={multistrat?.state === 'ok'} error={multistrat?.lastError}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <Metric label="STATE" value={multistrat?.state?.toUpperCase() || '—'} tone={multistrat?.state === 'ok' ? 'text-hud-green' : 'text-hud-red'} />
          <Metric label="OPEN POSITIONS" value={String(multistrat?.openPositions ?? 0)} />
          <Metric label="REALIZED PNL" value={formatNumber(multistrat?.realizedPnl)} tone={tone(multistrat?.realizedPnl)} />
          <Metric label="DAILY REALIZED" value={formatCurrency(multistrat?.dailyRealized)} tone={tone(multistrat?.dailyRealized)} />
        </div>
        <div className="grid grid-cols-2 gap-2 mb-4">
          <div className="panel-surface p-2">
            <div className="text-[10px] text-hud-dim">STRATEGIES</div>
            <div className="font-mono text-sm text-hud-text">
              {multistrat?.strategies?.join(', ') || '—'}
            </div>
          </div>
          <div className="panel-surface p-2">
            <div className="text-[10px] text-hud-dim">FEED UPDATED</div>
            <div className="font-mono text-sm text-hud-text">{multistrat?.updatedAt ? new Date(multistrat.updatedAt).toLocaleTimeString() : '—'}</div>
          </div>
        </div>
        <div className="panel-surface p-2">
          <div className="text-[10px] text-hud-dim mb-1">OPEN POSITIONS BY STRATEGY</div>
          <div className="grid grid-cols-2 gap-1 text-xs">
            {multistrat?.feed?.strategies && Object.entries(multistrat.feed.strategies).map(([name, data]: any) => (
              <div key={name} className="panel-surface px-2 py-1">
                <div className="font-mono text-hud-amber">{name}</div>
                <div className="text-hud-dim">{data.open} open · {data.symbols?.join(', ')}</div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Strategy Monitor */}
      <Section title="STRATEGY MONITOR" running={strategyMonitor?.running} error={strategyMonitor?.lastSignal ? null : undefined}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <Metric label="SIGNALS GENERATED" value={String(strategyMonitor?.signalsGenerated ?? 0)} />
          <Metric label="TRADES EXECUTED" value={String(strategyMonitor?.tradesExecuted ?? 0)} />
          <Metric label="WIN RATE" value={formatPercentValue(strategyMonitor?.winRate)} tone={tone(strategyMonitor?.winRate ? strategyMonitor.winRate - 50 : 0)} />
          <Metric label="PROFIT FACTOR" value={formatNumber(strategyMonitor?.profitFactor)} tone={tone(strategyMonitor?.profitFactor ? strategyMonitor.profitFactor - 1 : 0)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="panel-surface p-2">
            <div className="text-[10px] text-hud-dim">LAST SIGNAL</div>
            <div className="font-mono text-sm text-hud-text">
              {strategyMonitor?.lastSignal
                ? `${strategyMonitor.lastSignal.direction} ${strategyMonitor.lastSignal.symbol} @ ${strategyMonitor.lastSignal.price} (${formatPercentValue(strategyMonitor.lastSignal.confidence)})`
                : '—'}
            </div>
          </div>
          <div className="panel-surface p-2">
            <div className="text-[10px] text-hud-dim">LAST TRADE</div>
            <div className="font-mono text-sm text-hud-text">
              {strategyMonitor?.lastTrade
                ? `${strategyMonitor.lastTrade.side} ${strategyMonitor.lastTrade.symbol} @ ${strategyMonitor.lastTrade.price} P&L: ${formatPercentValue(strategyMonitor.lastTrade.pnl_pct)}`
                : '—'}
            </div>
          </div>
        </div>
      </Section>

      {/* Risk Monitor */}
      <Section title="RISK MONITOR" running={riskMonitor?.running} error={riskMonitor?.lastError}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <Metric label="EQUITY" value={formatCurrency(riskMonitor?.currentEquity)} />
          <Metric label="DAILY P&L" value={formatCurrency(riskMonitor?.dailyPnl)} tone={tone(riskMonitor?.dailyPnl)} />
          <Metric label="DRAWDOWN" value={formatPercentValue(riskMonitor?.totalDrawdown)} tone={riskMonitor?.totalDrawdown && riskMonitor.totalDrawdown > 0 ? 'text-hud-red' : 'text-hud-green'} />
          <Metric label="CONSECUTIVE LOSSES" value={String(riskMonitor?.consecutiveLosses ?? 0)} tone={riskMonitor?.consecutiveLosses && riskMonitor.consecutiveLosses > 2 ? 'text-hud-red' : 'text-hud-green'} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <Metric label="OPEN POSITIONS" value={String(riskMonitor?.openPositions ?? 0)} />
          <Metric label="HALT ACTIVE" value={riskMonitor?.haltActive ? 'YES' : 'NO'} tone={riskMonitor?.haltActive ? 'text-hud-red' : 'text-hud-green'} />
          <Metric label="BLOCK NEW" value={riskMonitor?.blockNewPositions ? 'YES' : 'NO'} tone={riskMonitor?.blockNewPositions ? 'text-hud-red' : 'text-hud-green'} />
          <Metric label="DAILY START" value={formatCurrency(riskMonitor?.dailyStartEquity)} />
        </div>
        {riskMonitor?.limits && Object.keys(riskMonitor.limits).length > 0 && (
          <div className="panel-surface p-2 mt-2">
            <div className="text-[10px] text-hud-dim mb-1">RISK LIMITS</div>
            <div className="grid grid-cols-2 gap-1 text-xs">
              {Object.entries(riskMonitor.limits).map(([key, value]: any) => (
                <div key={key} className="panel-surface px-2 py-1">
                  <div className="text-hud-dim">{key}</div>
                  <div className="font-mono">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* Market Data Monitor */}
      <Section title="MARKET DATA MONITOR" running={marketData?.running} error={marketData?.lastAnomaly ? 'Anomaly detected' : undefined}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <Metric label="SYMBOLS TRACKED" value={String(Object.keys(marketData?.symbols || {}).length)} />
          <Metric label="ANOMALIES" value={String(marketData?.anomalies?.length ?? 0)} tone={marketData?.anomalies?.length ? 'text-hud-red' : 'text-hud-green'} />
          <Metric label="WS HEALTH" value={marketData?.wsHealth?.connected ? 'CONNECTED' : 'DISCONNECTED'} tone={marketData?.wsHealth?.connected ? 'text-hud-green' : 'text-hud-red'} />
          <Metric label="LAST CHECK" value={marketData?.lastCheck ? new Date(marketData.lastCheck).toLocaleTimeString() : '—'} />
        </div>
        {marketData?.anomalies?.length && (
          <div className="panel-surface p-2">
            <div className="text-[10px] text-hud-red mb-1">RECENT ANOMALIES</div>
            <div className="max-h-32 overflow-auto text-xs">
              {marketData.anomalies.slice(-5).reverse().map((a: any, i: number) => (
                <div key={i} className="text-hud-red font-mono">
                  {a.timestamp ? new Date(a.timestamp).toLocaleTimeString() : 'NOW'} · {a.type} · {a.symbol} · {a.details}
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* Alerts */}
      <Section title="ALERTS" running={alerts?.running}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <Metric label="TOTAL" value={String(alerts?.totalAlerts ?? 0)} />
          <Metric label="CRITICAL" value={String(alerts?.counts?.critical ?? 0)} tone={alerts?.counts?.critical ? 'text-hud-red' : 'text-hud-green'} />
          <Metric label="WARNING" value={String(alerts?.counts?.warning ?? 0)} tone={alerts?.counts?.warning ? 'text-hud-amber' : 'text-hud-green'} />
          <Metric label="INFO" value={String(alerts?.counts?.info ?? 0)} />
        </div>
        {alerts?.recentAlerts?.length && (
          <div className="max-h-32 overflow-auto text-xs">
            {alerts.recentAlerts.slice(0, 5).map((a: any, i: number) => (
              <div key={i} className={`panel-surface px-2 py-1 ${a.severity === 'CRITICAL' ? 'border-l-2 border-hud-red' : a.severity === 'WARNING' ? 'border-l-2 border-hud-amber' : ''}`}>
                <div className="flex justify-between text-xs">
                  <span>{a.kind}</span>
                  <span className={a.severity === 'CRITICAL' ? 'text-hud-red' : a.severity === 'WARNING' ? 'text-hud-amber' : 'text-hud-dim'}>{a.severity}</span>
                </div>
                <div className="text-hud-dim text-xs">{a.message}</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Paper Trading Ops */}
      <Section title="PAPER TRADING OPS" running={paperOps?.running}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <Metric label="EQUITY" value={formatCurrency(paperOps?.totalEquity)} />
          <Metric label="REALIZED P&L" value={formatCurrency(paperOps?.totalRealizedPnl)} tone={tone(paperOps?.totalRealizedPnl)} />
          <Metric label="UNREALIZED P&L" value={formatCurrency(paperOps?.totalUnrealizedPnl)} tone={tone(paperOps?.totalUnrealizedPnl)} />
          <Metric label="WIN RATE" value={formatPercentValue(paperOps?.winRate)} tone={tone(paperOps?.winRate ? paperOps.winRate - 50 : 0)} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <Metric label="TRADES" value={String(paperOps?.tradesExecuted ?? 0)} />
          <Metric label="FILLS" value={String(paperOps?.fillsRecorded ?? 0)} />
          <Metric label="MAX DD" value={formatCurrency(paperOps?.maxDrawdown)} tone={paperOps?.maxDrawdown ? 'text-hud-red' : 'text-hud-green'} />
          <Metric label="MAX DD %" value={formatPercentValue(paperOps?.maxDrawdownPct)} tone={paperOps?.maxDrawdownPct ? 'text-hud-red' : 'text-hud-green'} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="panel-surface p-2">
            <div className="text-[10px] text-hud-dim">RECONCILIATION</div>
            <div className="font-mono text-sm text-hud-text">
              {paperOps?.reconciliation?.positions_match ? 'MATCHED' : 'MISMATCH'}
            </div>
          </div>
          <div className="panel-surface p-2">
            <div className="text-[10px] text-hud-dim">OPEN POSITION</div>
            <div className="font-mono text-sm text-hud-text">
              {paperOps?.openPosition
                ? `${paperOps.openPosition.side} ${paperOps.openPosition.symbol} @ ${paperOps.openPosition.entry}`
                : 'FLAT'}
            </div>
          </div>
        </div>
      </Section>

      {/* Performance Reporter */}
      <Section title="PERFORMANCE REPORTER" running={!!performance?.reportsAvailable}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <Metric label="REPORTS AVAILABLE" value={String(performance?.reportsAvailable ?? 0)} />
          <Metric label="LATEST" value={performance?.latestReport?.created || '—'} />
        </div>
        {performance?.latestReport && (
          <div className="panel-surface p-2">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="panel-surface px-2 py-1">
                <div className="text-hud-dim">BEST STRATEGY</div>
                <div className="font-mono">{performance.latestReport.bestStrategy}</div>
              </div>
              <div className="panel-surface px-2 py-1">
                <div className="text-hud-dim">WORST STRATEGY</div>
                <div className="font-mono">{performance.latestReport.worstStrategy}</div>
              </div>
              <div className="panel-surface px-2 py-1">
                <div className="text-hud-dim">AVG RETURN</div>
                <div className={`font-mono ${tone(performance.latestReport.avgReturn)}`}>{formatPercentValue(performance.latestReport.avgReturn)}</div>
              </div>
              <div className="panel-surface px-2 py-1">
                <div className="text-hud-dim">AVG SHARPE</div>
                <div className={`font-mono ${tone(performance.latestReport.avgSharpe)}`}>{formatNumber(performance.latestReport.avgSharpe)}</div>
              </div>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
