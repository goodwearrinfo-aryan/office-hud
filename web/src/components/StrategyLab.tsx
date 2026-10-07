import { useState, useCallback } from 'react';
import { useLive, type BacktestData } from '../api';
import { formatNumber, formatPercent, valueTone, Metric, Badge } from '../utils/tradingFormat';
import BacktestDetailDrawer from './BacktestDetailDrawer';

const STRATEGY_TEMPLATES = [
  {
    id: 'mean-reversion',
    name: 'Mean Reversion (RSI)',
    description: 'Classic RSI mean reversion with Bollinger Bands filter',
    code: `import { Strategy } from 'jesse'

class RSIMeanReversion(Strategy):
    def __init__(self):
        super().__init__()
        self.rsi_period = 14
        self.bb_period = 20
        self.bb_std = 2.0
        self.rsi_oversold = 30
        self.rsi_overbought = 70
        self.stop_loss_pct = 0.02
        self.take_profit_pct = 0.04

    def should_long(self) -> bool:
        rsi = self.rsi(self.rsi_period)
        bb_lower = self.bb_lower(self.bb_period, self.bb_std)
        return self.price < bb_lower and rsi < self.rsi_oversold

    def should_short(self) -> bool:
        rsi = self.rsi(self.rsi_period)
        bb_upper = self.bb_upper(self.bb_period, self.bb_std)
        return self.price > bb_upper and rsi > self.rsi_overbought

    def go_long(self):
        self.buy = self.position_size(self.capital, self.price)

    def go_short(self):
        self.sell = self.position_size(self.capital, self.price)

    def update_position(self):
        if self.position.is_long:
            if self.price >= self.position.entry_price * (1 + self.take_profit_pct):
                self.liquidate()
            elif self.price <= self.position.entry_price * (1 - self.stop_loss_pct):
                self.liquidate()
        elif self.position.is_short:
            if self.price <= self.position.entry_price * (1 - self.take_profit_pct):
                self.liquidate()
            elif self.price >= self.position.entry_price * (1 + self.stop_loss_pct):
                self.liquidate()
`
  },
  {
    id: 'trend-following',
    name: 'Trend Following (EMA Crossover)',
    description: 'EMA crossover with ATR trailing stop',
    code: `import { Strategy } from 'jesse'

class EMATrendFollow(Strategy):
    def __init__(self):
        super().__init__()
        self.fast_ema = 12
        self.slow_ema = 26
        self.atr_period = 14
        self.atr_mult = 2.0

    def should_long(self) -> bool:
        fast = self.ema(self.fast_ema)
        slow = self.ema(self.slow_ema)
        return fast > slow and self.price > fast

    def should_short(self) -> bool:
        fast = self.ema(self.fast_ema)
        slow = self.ema(self.slow_ema)
        return fast < slow and self.price < fast

    def go_long(self):
        self.buy = self.position_size(self.capital, self.price)

    def go_short(self):
        self.sell = self.position_size(self.capital, self.price)

    def update_position(self):
        atr = self.atr(self.atr_period)
        if self.position.is_long:
            stop = self.price - atr * self.atr_mult
            if self.price <= stop:
                self.liquidate()
        elif self.position.is_short:
            stop = self.price + atr * self.atr_mult
            if self.price >= stop:
                self.liquidate()
`
  },
  {
    id: 'breakout',
    name: 'Breakout (Donchian Channel)',
    description: 'Donchian channel breakout with volume filter',
    code: `import { Strategy } from 'jesse'

class DonchianBreakout(Strategy):
    def __init__(self):
        super().__init__()
        self.channel_period = 20
        self.volume_ma_period = 20
        self.volume_mult = 1.5

    def should_long(self) -> bool:
        upper = self.highest(self.channel_period)
        vol_ma = self.volume_sma(self.volume_ma_period)
        return self.price >= upper and self.volume > vol_ma * self.volume_mult

    def should_short(self) -> bool:
        lower = self.lowest(self.channel_period)
        vol_ma = self.volume_sma(self.volume_ma_period)
        return self.price <= lower and self.volume > vol_ma * self.volume_mult

    def go_long(self):
        self.buy = self.position_size(self.capital, self.price)

    def go_short(self):
        self.sell = self.position_size(self.capital, self.price)

    def update_position(self):
        if self.position.is_long:
            stop = self.lowest(self.channel_period)
            if self.price <= stop:
                self.liquidate()
        elif self.position.is_short:
            stop = self.highest(self.channel_period)
            if self.price >= stop:
                self.liquidate()
`
  },
  {
    id: 'perp-basis',
    name: 'Perp Basis Trade (Funding Rate)',
    description: 'Cash-and-carry basis trade on perpetual futures',
    code: `import { Strategy } from 'jesse'

class PerpBasisTrade(Strategy):
    def __init__(self):
        super().__init__()
        self.funding_threshold = 0.0001
        self.max_leverage = 3
        self.rebalance_hours = 8

    def should_long(self) -> bool:
        funding = self.funding_rate()
        return funding < -self.funding_threshold

    def should_short(self) -> bool:
        funding = self.funding_rate()
        return funding > self.funding_threshold

    def go_long_perp(self):
        self.buy = self.position_size(self.capital * self.max_leverage, self.price)

    def go_short_perp(self):
        self.sell = self.position_size(self.capital * self.max_leverage, self.price)
`
  },
];

const WALKFORWARD_DEFAULTS = {
  train_window: 730,
  test_window: 90,
  step: 30,
  anchor: 'rolling',
};

interface WalkForwardConfig {
  train_window: number;
  test_window: number;
  step: number;
  anchor: string;
}

interface ExperimentRun {
  id: string;
  timestamp: number;
  templateId: string;
  params: Record<string, any>;
  walkforward: WalkForwardConfig;
  status: 'running' | 'completed' | 'failed';
  result?: { sharpe: number; return: number; trades: number };
  error?: string;
}

export default function StrategyLab() {
  const { data: backtestData } = useLive<BacktestData>('/api/trading/backtests');
  const { data: terminalHealth } = useLive<any>('/api/terminals/health');
  
  const [selectedTemplate, setSelectedTemplate] = useState<typeof STRATEGY_TEMPLATES[0] | null>(STRATEGY_TEMPLATES[0]);
  const [code, setCode] = useState(STRATEGY_TEMPLATES[0].code);
  const [walkforward, setWalkforward] = useState<WalkForwardConfig>(WALKFORWARD_DEFAULTS);
  const [notebookContent, setNotebookContent] = useState('');
  const [experiments, setExperiments] = useState<ExperimentRun[]>([]);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);

  const extractParamsFromCode = useCallback((code: string): Record<string, number> => {
    const params: Record<string, number> = {};
    const regex = /self\.(\w+)\s*=\s*([\d.]+)/g;
    let match;
    while ((match = regex.exec(code)) !== null) {
      params[match[1]] = parseFloat(match[2]);
    }
    return params;
  }, []);

  const handleRunBacktest = useCallback(async () => {
    if (!selectedTemplate) return;
    
    const params = extractParamsFromCode(code);
    const jobId = `backtest-${Date.now()}`;
    
    setRunningJob(jobId);
    setExperiments(prev => [
      {
        id: jobId,
        timestamp: Date.now(),
        templateId: selectedTemplate.id,
        params,
        walkforward: { ...walkforward },
        status: 'running',
      },
      ...prev,
    ]);

    try {
      const response = await fetch('/api/trading/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: selectedTemplate.id,
          code,
          params,
          walkforward,
        }),
      });

      const result = await response.json();
      
      if (response.ok) {
        setExperiments(prev => prev.map(exp => 
          exp.id === jobId 
            ? { ...exp, status: 'completed', result: { sharpe: result.sharpe, return: result.return, trades: result.trades } }
            : exp
        ));
      } else {
        setExperiments(prev => prev.map(exp => 
          exp.id === jobId 
            ? { ...exp, status: 'failed', error: result.error || 'Backtest failed' }
            : exp
        ));
      }
    } catch (err) {
      setExperiments(prev => prev.map(exp => 
        exp.id === jobId 
          ? { ...exp, status: 'failed', error: String(err) }
          : exp
      ));
    } finally {
      setRunningJob(null);
    }
  }, [selectedTemplate, code, walkforward, extractParamsFromCode]);

  const backtests = Object.entries(backtestData?.backtest ?? {})
    .sort(([, a], [, b]) => (b.avg_test_sharpe ?? 0) - (a.avg_test_sharpe ?? 0));
  const walkforwards = Object.entries(backtestData?.walkforward ?? {})
    .sort(([, a], [, b]) => (b.avg_oos_return ?? 0) - (a.avg_oos_return ?? 0));
  const bestBacktest = backtests[0]?.[1];
  const bestWalkforward = walkforwards[0]?.[1];

  const terminalReady = terminalHealth?.status === 'ok';

  const renderExperimentTracker = () => {
    if (experiments.length === 0) {
      return (
        <div className="text-hud-dim text-xs py-8 text-center">No experiments yet. Run a backtest to start tracking.</div>
      );
    }
    return (
      <>
        {experiments.map(exp => (
          <div key={exp.id} className="panel-surface px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs truncate">{exp.templateId}</span>
              <Badge
                label={exp.status.toUpperCase()}
                variant={
                  exp.status === 'running' ? 'info' :
                  exp.status === 'completed' ? 'success' :
                  'danger'
                }
              />
            </div>
            <div className="text-[10px] text-hud-dim mt-1">
              {new Date(exp.timestamp).toLocaleString()} · WF: {exp.walkforward.train_window}/{exp.walkforward.test_window}/{exp.walkforward.step}
            </div>
            {exp.result && (
              <div className="flex gap-4 mt-1 text-[10px] font-mono">
                <span className={valueTone(exp.result.sharpe)}>Sharpe: {formatNumber(exp.result.sharpe)}</span>
                <span className={valueTone(exp.result.return)}>Return: {formatPercent(exp.result.return)}</span>
                <span>Trades: {exp.result.trades}</span>
              </div>
            )}
            {exp.error && (
              <div className="text-hud-red text-xs mt-1 truncate">{exp.error}</div>
            )}
          </div>
        ))}
      </>
    );
  };

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F7 · STRATEGY LAB</h2>
        <span className="badge badge-info">RESEARCH & DEVELOPMENT</span>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
        <Metric label="EVALUATED" value={String(backtests.length)} />
        <Metric label="BEST SHARPE" value={formatNumber(bestBacktest?.avg_test_sharpe)} tone={valueTone(bestBacktest?.avg_test_sharpe)} />
        <Metric label="BEST OOS RETURN" value={formatPercent(bestWalkforward?.avg_oos_return)} tone={valueTone(bestWalkforward?.avg_oos_return)} />
        <Metric label="TERMINAL" value={terminalReady ? 'READY' : 'NOT READY'} tone={terminalReady ? 'text-hud-green' : 'text-hud-red'} />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
        {/* Left: Strategy Builder */}
        <div className="xl:col-span-1 panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">STRATEGY BUILDER</h3>
          
          <div className="space-y-3">
            <div>
              <label className="text-[10px] font-mono text-hud-dim block mb-1">Template</label>
              <select
                className="input w-full"
                value={selectedTemplate?.id || ''}
                onChange={(e) => {
                  const t = STRATEGY_TEMPLATES.find(t => t.id === e.target.value);
                  if (t) setSelectedTemplate(t);
                }}
              >
                {STRATEGY_TEMPLATES.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[10px] font-mono text-hud-dim block mb-1">Parameters</label>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {Object.entries(extractParamsFromCode(code)).map(([key, val]) => (
                  <div key={key} className="panel-surface px-2 py-1 flex justify-between">
                    <span className="font-mono text-hud-dim">{key}</span>
                    <input
                      type="number"
                      step="any"
                      className="input w-20"
                      value={val}
                      onChange={(e) => {
                        const newVal = parseFloat(e.target.value) || 0;
                        setCode(code.replace(
                          new RegExp('self\\.' + key + '\\s*=\\s*[\\d.]+'),
                          'self.' + key + ' = ' + newVal
                        ));
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] font-mono text-hud-dim block mb-1">Walk-Forward Config</label>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="panel-surface px-2 py-1">
                  <div className="text-hud-dim">Train Window (days)</div>
                  <input
                    type="number"
                    className="input w-full"
                    value={walkforward.train_window}
                    onChange={(e) => setWalkforward(w => ({ ...w, train_window: parseInt(e.target.value) || 730 }))}
                  />
                </div>
                <div className="panel-surface px-2 py-1">
                  <div className="text-hud-dim">Test Window (days)</div>
                  <input
                    type="number"
                    className="input w-full"
                    value={walkforward.test_window}
                    onChange={(e) => setWalkforward(w => ({ ...w, test_window: parseInt(e.target.value) || 90 }))}
                  />
                </div>
                <div className="panel-surface px-2 py-1">
                  <div className="text-hud-dim">Step (days)</div>
                  <input
                    type="number"
                    className="input w-full"
                    value={walkforward.step}
                    onChange={(e) => setWalkforward(w => ({ ...w, step: parseInt(e.target.value) || 30 }))}
                  />
                </div>
                <div className="panel-surface px-2 py-1">
                  <div className="text-hud-dim">Anchor</div>
                  <select className="input w-full" value={walkforward.anchor} onChange={(e) => setWalkforward(w => ({ ...w, anchor: e.target.value }))}>
                    <option value="rolling">Rolling</option>
                    <option value="anchored">Anchored</option>
                  </select>
                </div>
              </div>
            </div>

            <button
              className="btn btn-primary w-full"
              onClick={handleRunBacktest}
              disabled={runningJob !== null || !terminalReady}
            >
              {runningJob ? 'RUNNING...' : 'RUN BACKTEST'}
            </button>

            <div className="pt-4 border-t border-hud-border">
              <h4 className="font-mono text-hud-amber text-xs mb-2">RESEARCH NOTES</h4>
              <textarea
                className="input w-full min-h-[200px] font-mono text-xs"
                value={notebookContent}
                onChange={(e) => setNotebookContent(e.target.value)}
                placeholder="Record your hypothesis, observations, and decisions here..."
              />
            </div>
          </div>
        </div>

        {/* Middle: Experiment Tracker */}
        <div className="xl:col-span-1 panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">EXPERIMENT TRACKER</h3>
          <div className="space-y-2 max-h-[500px] overflow-auto">
            {renderExperimentTracker()}
          </div>
        </div>

        {/* Right: Backtest Results */}
        <div className="xl:col-span-1 panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">BACKTEST RESULTS</h3>
          <div className="space-y-4">
            <div>
              <h4 className="font-mono text-hud-amber text-xs mb-2">Top Backtests</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-hud-dim border-b border-hud-border">
                      <th className="text-left pb-1">Strategy</th>
                      <th className="text-right pb-1">Sharpe</th>
                      <th className="text-right pb-1">Return</th>
                      <th className="text-right pb-1">Trades</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backtests.slice(0, 10).map(([name, result]) => (
                      <tr key={name} className="border-b border-hud-border/50 hover:bg-hud-surface cursor-pointer" onClick={() => setSelectedStrategy(name)}>
                        <td className="py-1 font-mono truncate max-w-[150px]">{name}</td>
                        <td className="py-1 text-right font-mono">{formatNumber(result.avg_test_sharpe)}</td>
                        <td className="py-1 text-right font-mono">{formatPercent(result.avg_test_return)}</td>
                        <td className="py-1 text-right font-mono">{result.avg_trades ?? 0}</td>
                      </tr>
                    ))}
                    {!backtestData && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">Loading backtest data…</td></tr>}
                    {backtestData && backtests.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">No backtest data</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h4 className="font-mono text-hud-amber text-xs mb-2">Walk-Forward Results</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-hud-dim border-b border-hud-border">
                      <th className="text-left pb-1">Strategy</th>
                      <th className="text-right pb-1">Avg OOS Return</th>
                      <th className="text-right pb-1">Positive Periods</th>
                      <th className="text-right pb-1">Windows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {walkforwards.slice(0, 10).map(([name, result]) => (
                      <tr key={name} className="border-b border-hud-border/50">
                        <td className="py-1 font-mono truncate max-w-[150px]">{name}</td>
                        <td className="py-1 text-right font-mono">{formatPercent(result.avg_oos_return)}</td>
                        <td className="py-1 text-right font-mono">{result.positive_oos_periods}/{result.total_periods}</td>
                        <td className="py-1 text-right font-mono">{result.num_windows}</td>
                      </tr>
                    ))}
                    {!backtestData && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">Loading walk-forward data…</td></tr>}
                    {backtestData && walkforwards.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">No walk-forward data</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      {selectedStrategy && (
        <BacktestDetailDrawer
          strategyName={selectedStrategy}
          onClose={() => setSelectedStrategy(null)}
        />
      )}
    </div>
  );
}