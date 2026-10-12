import { useState } from 'react';
import { exportAgents, exportLedger, exportBacktest, exportRiskMetrics, type ExportFormat } from '../utils/export';
import { useLive, type Agent, type LedgerEvent, type BacktestData, type StrategyBacktest, type Summary } from '../api';

interface Props {
  type: 'agents' | 'ledger' | 'backtest' | 'risk';
  label?: string;
  agents?: Agent[];
  events?: LedgerEvent[];
  backtestData?: BacktestData;
  riskMetrics?: any[];
  summary?: Summary;
}

export default function ExportButton({ type, label = 'Export', agents, events, backtestData, riskMetrics }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: agentsData } = useLive<Summary>('/api/summary');
  const { data: ledgerData } = useLive<{ events: any[] }>('/api/ledger?limit=2000');
  const { data: backtest } = useLive<any>('/api/trading/backtests');

  const handleExport = (format: ExportFormat) => {
    try {
      switch (type) {
        case 'agents':
          exportAgents(agents ?? agentsData?.agents ?? [], format);
          break;
        case 'ledger':
          exportLedger(events ?? ledgerData?.events ?? [], format);
          break;
        case 'backtest':
          exportBacktest(backtestData ?? backtest?.backtest ?? {}, format);
          break;
        case 'risk':
          // compute risk metrics from backtest
          const bt = backtestData ?? backtest?.backtest ?? {};
          const metrics = Object.entries<StrategyBacktest>(bt).map(([name, data]) => {
            const rets = data.windows.map((w) => w.test_return);
            const equity = data.windows.map((w: any) => w.test_return).reduce((acc: number[], r: number) => [...acc, (acc[acc.length - 1] || 0) + r], [] as number[]);
            let peak = -Infinity, maxDD = 0;
            for (const v of equity) { if (v > peak) peak = v; const dd = (peak - v) / (peak || 1); if (dd > maxDD) maxDD = dd; }
            const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
            const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1 || 1));
            const sharpe = std ? (mean) / std * Math.sqrt(252 * 288) : 0;
            const downside = rets.filter(r => r < 0);
            const downsideStd = downside.length ? Math.sqrt(downside.reduce((a, b) => a + b ** 2, 0) / downside.length) : 0;
            const sortino = downsideStd ? mean / downsideStd * Math.sqrt(252 * 288) : 0;
            const annReturn = mean * 252 * 288;
            const calmar = maxDD ? annReturn / maxDD : 0;
            const sorted = [...rets].sort((a, b) => a - b);
            const idx = Math.floor(0.05 * sorted.length);
            const var95 = -sorted[idx];
            const tail = sorted.slice(0, idx + 1);
            const cvar95 = tail.length ? -tail.reduce((a, b) => a + b, 0) / tail.length : 0;
            const skew = rets.length > 2 ? (rets.reduce((a, b) => a + (b - mean) ** 3, 0) / rets.length) / Math.pow(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length, 1.5) : 0;
            const kurtosis = rets.length > 3 ? (rets.reduce((a, b) => a + (b - mean) ** 4, 0) / rets.length) / Math.pow(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length, 2) - 3 : 0;
            return { strategy: name, sharpe, sortino, calmar, var95, cvar95, maxDD, volatility: std * Math.sqrt(252 * 288), skew, kurtosis };
          });
          exportRiskMetrics(riskMetrics ?? metrics, format);
          break;
      }
      setMenuOpen(false);
    } catch (e) {
      console.error('Export failed:', e);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        className="px-2.5 py-1.5 rounded-lg text-[10px] font-mono text-hud-dim hover:text-hud-text hover:bg-hud-edge transition-colors"
      >
        {label} ▾
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-full mt-1 bg-hud-panel border border-hud-edge rounded-lg shadow-lg min-w-[160px] z-50 py-1">
          <button
            onClick={() => { handleExport('json'); }}
            className="w-full px-3 py-2 text-left text-sm text-hud-text hover:bg-hud-edge transition-colors"
          >
            Download JSON
          </button>
          <button
            onClick={() => { handleExport('csv'); }}
            className="w-full px-3 py-2 text-left text-sm text-hud-text hover:bg-hud-edge transition-colors"
          >
            Download CSV
          </button>
        </div>
      )}
    </div>
  );
}