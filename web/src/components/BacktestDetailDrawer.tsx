import { useEffect, useState } from 'react';
import { useLive } from '../api';
import { formatNumber, formatPercent, formatCurrency, valueTone, Metric, Badge } from '../utils/tradingFormat';
import { Chart, registerables } from 'chart.js';
import 'chartjs-adapter-date-fns';

Chart.register(...registerables);

interface Props {
  strategyName: string;
  onClose: () => void;
}

export default function BacktestDetailDrawer({ strategyName, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<'equity' | 'trades' | 'sensitivity' | 'walkforward' | 'validation' | 'deploy'>('equity');
  const [chartInstance, setChartInstance] = useState<Chart | null>(null);
  const [equityData, setEquityData] = useState<number[]>([]);

  const { data: backtestData } = useLive<any>(`/api/trading/backtest/${encodeURIComponent(strategyName)}`);
  const { data: backtests } = useLive<any>('/api/trading/backtests');
  const { data: validationEvidence } = useLive<any>('/api/validationEvidence');
  const { data: paperTradingOps } = useLive<any>('/api/trading/paper-ops');

  const strategy = backtestData?.backtest?.[strategyName] || backtests?.backtest?.[strategyName];
  const walkforward = backtestData?.walkforward?.[strategyName];

  useEffect(() => {
    if (strategy?.equity_curve) {
      setEquityData(strategy.equity_curve);
    } else if (backtests?.backtest?.[strategyName]?.equity_curve) {
      setEquityData(backtests.backtest[strategyName].equity_curve);
    }
  }, [strategy, backtests]);

  useEffect(() => {
    if (activeTab === 'equity' && equityData.length > 0) {
      renderEquityChart();
    }
  }, [activeTab, equityData]);

  const renderEquityChart = () => {
    const canvas = document.getElementById('equity-chart') as HTMLCanvasElement;
    if (!canvas) return;

    if (chartInstance) {
      chartInstance.destroy();
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const labels = equityData.map((_, i) => i);
    const cumulative = equityData.map((_, i) => equityData.slice(0, i + 1).reduce((a, b) => a + b, 10000));
    const drawdown = cumulative.map((v: number, i: number) => {
      const peak = Math.max(...cumulative.slice(0, i + 1));
      void v;
      return peak > 0 ? ((peak - v) / peak) * 100 : 0;
    });

    const newChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Equity',
            data: cumulative,
            borderColor: '#60a5fa',
            backgroundColor: 'rgba(96, 165, 250, 0.1)',
            fill: true,
            tension: 0.2,
            pointRadius: 0,
          },
          {
            label: 'Drawdown %',
            data: drawdown,
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            fill: true,
            tension: 0.2,
            pointRadius: 0,
            yAxisID: 'y1',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { color: '#232a38' }, ticks: { color: '#6b7280' } },
          y: { 
            grid: { color: '#232a38' }, 
            ticks: { color: '#6b7280' },
            title: { display: true, text: 'Equity ($)', color: '#9ca3af' }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: { color: '#ef4444' },
            title: { display: true, text: 'Drawdown %', color: '#ef4444' }
          },
        },
        plugins: {
          legend: { labels: { color: '#9ca3af' } },
        },
      },
    });

    setChartInstance(newChart);
  };

  useEffect(() => {
    return () => {
      if (chartInstance) {
        chartInstance.destroy();
      }
    };
  }, []);

  const tabs = [
    { id: 'equity', label: 'Equity Curve' },
    { id: 'trades', label: 'Trade Analysis' },
    { id: 'sensitivity', label: 'Param Sensitivity' },
    { id: 'walkforward', label: 'Walk-Forward' },
    { id: 'validation', label: 'Validation' },
    { id: 'deploy', label: 'Deploy' },
  ];

  const isPaperRunning = paperTradingOps?.running && paperTradingOps?.strategy === strategyName;

  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <div className="w-full md:w-[90vw] lg:w-[1200px] bg-hud-panel border-t border-hud-edge p-4 animate-slide-up max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3 border-b border-hud-edge pb-2">
          <div className="flex items-center gap-2">
            <h3 className="font-mono text-hud-amber text-lg">BACKTEST DETAIL</h3>
            <Badge label={strategyName} variant="info" />
          </div>
          <button className="btn btn-ghost text-xs" onClick={onClose}>Close</button>
        </div>

        {/* Tab Navigation */}
        <div className="flex gap-1 mb-4 border-b border-hud-edge pb-2 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id as any)}
              className={`px-3 py-1.5 text-xs font-mono rounded-t transition-colors ${
                activeTab === tab.id
                  ? 'bg-hud-edge text-hud-text'
                  : 'text-hud-dim hover:text-hud-text'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-auto space-y-4">
          {activeTab === 'equity' && (
            <div className="h-[500px]">
              <canvas id="equity-chart" className="w-full h-full" />
            </div>
          )}

          {activeTab === 'trades' && strategy?.trades && (
            <div className="space-y-4">
              <div className="grid grid-cols-4 gap-3">
                <Metric label="TOTAL TRADES" value={String(strategy.trades.length)} />
                <Metric label="WIN RATE" value={formatPercent(strategy.avg_win_rate)} tone={valueTone(strategy.avg_win_rate)} />
                <Metric label="PROFIT FACTOR" value={formatNumber(strategy.avg_profit_factor)} tone={valueTone(strategy.avg_profit_factor - 1)} />
                <Metric label="AVG HOLD" value={strategy.avg_hold ? `${strategy.avg_hold.toFixed(1)}h` : '--'} />
              </div>
              <div className="table-container">
                <table className="table">
                  <thead><tr><th>Entry</th><th>Exit</th><th>Side</th><th>PnL</th><th>Hold</th></tr></thead>
                  <tbody>
                    {strategy.trades.slice(0, 50).map((trade: any, i: number) => (
                      <tr key={i}>
                        <td className="font-mono text-xs">{trade.entry_time}</td>
                        <td className="font-mono text-xs">{trade.exit_time}</td>
                        <td className={valueTone(trade.pnl)}>{trade.side}</td>
                        <td className={valueTone(trade.pnl)}>{formatCurrency(trade.pnl)}</td>
                        <td>{trade.hold_hours?.toFixed(1)}h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'sensitivity' && (
            <div className="space-y-4">
              <div className="text-[10px] text-hud-dim mb-2">Parameter sensitivity heatmap (placeholder - requires pre-computed data)</div>
              <div className="grid grid-cols-4 gap-2">
                {strategy?.param_ranges && Object.entries(strategy.param_ranges).map(([param, range]) => (
                  <div key={param} className="panel-surface px-3 py-2">
                    <div className="text-[10px] font-mono text-hud-dim">{param}</div>
                    <div className="font-mono text-xs">{JSON.stringify(range)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'walkforward' && walkforward && (
            <div className="space-y-4">
              <div className="grid grid-cols-4 gap-3">
                <Metric label="IS RETURN" value={formatPercent(walkforward.avg_is_return)} tone={valueTone(walkforward.avg_is_return)} />
                <Metric label="OOS RETURN" value={formatPercent(walkforward.avg_oos_return)} tone={valueTone(walkforward.avg_oos_return)} />
                <Metric label="CONSISTENCY" value={formatPercent(walkforward.consistency)} />
                <Metric label="POSITIVE OOS" value={`${walkforward.positive_oos_periods}/${walkforward.total_periods}`} />
              </div>
              <div className="table-container">
                <table className="table">
                  <thead><tr><th>Window</th><th>IS Return</th><th>OOS Return</th><th>Params</th></tr></thead>
                  <tbody>
                    {walkforward.window_details?.map((w: any, i: number) => (
                      <tr key={i}>
                        <td className="font-mono text-xs">{w.is_start} - {w.oos_end}</td>
                        <td className={valueTone(w.is_return)}>{formatPercent(w.is_return)}</td>
                        <td className={valueTone(w.oos_return)}>{formatPercent(w.oos_return)}</td>
                        <td className="font-mono text-xs">{JSON.stringify(w.params)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'validation' && (
            <div className="space-y-4">
              <div className="grid grid-cols-4 gap-3">
                <Metric label="INFERENCE FLOOR" value={validationEvidence?.inference_floor ?? 'N/A'} />
                <Metric label="ARMS BELOW FLOOR" value={String(validationEvidence?.arms_below_floor ?? 0)} tone={valueTone((validationEvidence?.arms_below_floor ?? 0) * -1)} />
                <Metric label="PROMOTION STATE" value={validationEvidence?.promotion?.state?.toUpperCase() ?? 'UNKNOWN'} />
                <Metric label="ENTRY ALLOWED" value={validationEvidence?.promotion?.entry_allowed ? 'YES' : 'NO'} tone={validationEvidence?.promotion?.entry_allowed ? 'text-hud-green' : 'text-hud-red'} />
              </div>
              <div className="table-container">
                <table className="table">
                  <thead><tr><th>Arm</th><th>Trades</th><th>Progress</th><th>Floor Met</th></tr></thead>
                  <tbody>
                    {validationEvidence?.arms?.map((arm: any) => (
                      <tr key={arm.id}>
                        <td className="font-mono text-xs">{arm.label}</td>
                        <td className="font-mono">{arm.trades} / {arm.floor_required}</td>
                        <td>{arm.progress_pct}%</td>
                        <td><Badge label={arm.floor_met ? 'YES' : 'NO'} variant={arm.floor_met ? 'success' : 'danger'} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'deploy' && (
            <div className="space-y-4">
              <div className="panel p-4">
                <h4 className="font-mono text-hud-amber text-sm mb-3">DEPLOY TO PAPER TRADING</h4>
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] font-mono text-hud-dim block mb-1">Strategy</label>
                    <div className="font-mono text-sm">{strategyName}</div>
                  </div>
                  <div>
                    <label className="text-[10px] font-mono text-hud-dim block mb-1">Status</label>
                    <Badge label={isPaperRunning ? 'RUNNING' : 'STOPPED'} variant={isPaperRunning ? 'success' : 'neutral'} />
                  </div>
                  <div>
                    <label className="text-[10px] font-mono text-hud-dim block mb-1">Paper Trading Engine</label>
                    <div className="font-mono text-sm">{paperTradingOps?.status ?? 'UNKNOWN'}</div>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    try {
                      await fetch('/api/trading/promote', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ strategy: strategyName, confirmed: true })
                      });
                    } catch (e) {
                      console.error('Promote failed:', e);
                    }
                  }}
                  disabled={isPaperRunning}
                >
                  {isPaperRunning ? 'Already Running' : 'Promote to Paper'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {}}
                  disabled={!isPaperRunning}
                >
                  Stop Paper Trading
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}