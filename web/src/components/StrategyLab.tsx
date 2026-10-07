import { useState, useCallback } from 'react';
import { useLive, type BacktestData, type StrategyFile } from '../api';
import { formatNumber, formatPercent, valueTone, Metric, Badge } from '../utils/tradingFormat';
import CodeEditor from 'react-simple-code-editor';
import { marked } from 'marked';
import BacktestDetailDrawer from './BacktestDetailDrawer';

const STRATEGY_TEMPLATES = [

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
        qty = self.position_size(self.capital * 0.1, self.price)
        self.buy = qty, self.price
        self.stop_loss = self.price * (1 - self.stop_loss_pct)
        self.take_profit = self.price * (1 + self.take_profit_pct)

    def go_short(self):
        qty = self.position_size(self.capital * 0.1, self.price)
        self.sell = qty, self.price
        self.stop_loss = self.price * (1 + self.stop_loss_pct)
        self.take_profit = self.price * (1 + self.take_profit_pct)
`
  },
  {
    id: 'trend-following',
    name: 'Trend Following (EMA Crossover)',
    description: 'EMA crossover with ADX trend strength filter',
    code: `import { Strategy } from 'jesse'

class EMACrossover(Strategy):
    def __init__(self):
        super().__init__()
        self.fast_ema = 12
        self.slow_ema = 26
        self.adx_period = 14
        self.adx_threshold = 25
        self.stop_loss_pct = 0.03
        self.take_profit_pct = 0.06

    def should_long(self) -> bool:
        fast_ema = self.ema(self.fast_ema)
        slow_ema = self.ema(self.slow_ema)
        adx = self.adx(self.adx_period)
        return fast_ema > slow_ema and adx > self.adx_threshold

    def should_short(self) -> bool:
        fast_ema = self.ema(self.fast_ema)
        slow_ema = self.ema(self.slow_ema)
        adx = self.adx(self.adx_period)
        return fast_ema < slow_ema and adx > self.adx_threshold

    def go_long(self):
        qty = self.position_size(self.capital * 0.1, self.price)
        self.buy = qty, self.price
        self.stop_loss = self.price * (1 - self.stop_loss_pct)
        self.take_profit = self.price * (1 + self.take_profit_pct)

    def go_short(self):
        qty = self.position_size(self.capital * 0.1, self.price)
        self.sell = qty, self.price
        self.stop_loss = self.price * (1 + self.stop_loss_pct)
        self.take_profit = self.price * (1 + self.take_profit_pct)
`
  },
  {
    id: 'breakout',
    name: 'Breakout (Donchian Channel)',
    description: 'Donchian channel breakout with ATR trailing stop',
    code: `import { Strategy } from 'jesse'

class DonchianBreakout(Strategy):
    def __init__(self):
        super().__init__()
        self.channel_period = 20
        self.atr_period = 14
        self.atr_mult = 2.0
        self.stop_loss_pct = 0.02

    def should_long(self) -> bool:
        upper = self.highest(self.channel_period)
        return self.price > upper

    def should_short(self) -> bool:
        lower = self.lowest(self.channel_period)
        return self.price < lower

    def go_long(self):
        qty = self.position_size(self.capital * 0.1, self.price)
        self.buy = qty, self.price
        self.stop_loss = self.price - self.atr(self.atr_period) * self.atr_mult

    def go_short(self):
        qty = self.position_size(self.capital * 0.1, self.price)
        self.sell = qty, self.price
        self.stop_loss = self.price + self.atr(self.atr_period) * self.atr_mult
`
  },
  {
    id: 'stat-arb',
    name: 'Statistical Arbitrage (Z-Score)',
    description: 'Pairs trading with z-score mean reversion',
    code: `import { Strategy } from 'jesse'

class StatArb(Strategy):
    def __init__(self):
        super().__init__()
        self.lookback = 20
        self.z_entry = 2.0
        self.z_exit = 0.5
        self.pair_symbol = 'ETH-USDT'

    def on_candle(self):
        if self.index < self.lookback:
            return
        
        spread = self.price - self.get_external_price(self.pair_symbol)
        mean = self.sma(spread, self.lookback)
        std = self.std(spread, self.lookback)
        z_score = (spread - mean) / std if std > 0 else 0
        
        if z_score > self.z_entry:
            self.go_short()
        elif z_score < -self.z_entry:
            self.go_long()
        elif abs(z_score) < self.z_exit:
            self.liquidate()

    def go_long(self):
        self.buy = 1, self.price

    def go_short(self):
        self.sell = 1, self.price
`
  },
  {
    id: 'funding',
    name: 'Funding Rate Arbitrage',
    description: 'Capture funding rate with delta-neutral perp/spot',
    code: `import { Strategy } from 'jesse'

class FundingArb(Strategy):
    def __init__(self):
        super().__init__()
        self.funding_threshold = 0.0001
        self.leverage = 1.0
        self.rebalance_hours = 8

    def on_candle(self):
        funding_rate = self.get_funding_rate()
        if abs(funding_rate) < self.funding_threshold:
            return
        
        if funding_rate > 0:
            self.go_short_perp()
            self.go_long_spot()
        else:
            self.go_long_perp()
            self.go_short_spot()

    def go_long_perp(self):
        self.buy = self.position_size(self.capital * self.leverage, self.price)

    def go_short_perp(self):
        self.sell = self.position_size(self.capital * self.leverage, self.price)
`
  },
];

const WALKFORWARD_DEFAULTS = {
  train_window: 730,
  test_window: 90,
  step: 30,
  anchor: 'rolling',
};

interface StrategyTemplate {
  id: string;
  name: string;
  description: string;
  code: string;
}

interface BacktestResult {
  avg_test_sharpe: number;
  avg_test_return: number;
  consistency: number;
  avg_win_rate: number;
  avg_profit_factor: number;
  avg_trades?: number;
}

interface WalkForwardResult {
  avg_oos_return: number;
  positive_oos_periods: number;
  total_periods: number;
  num_windows: number;
  avg_oos_trades?: number;
}

interface BacktestData {
  backtest?: Record<string, BacktestResult>;
  walkforward?: Record<string, WalkForwardResult>;
}

interface ExperimentRun {
  id: string;
  timestamp: number;
  templateId: string;
  params: Record<string, any>;
  walkforward: WalkForwardConfig;
  status: 'running' | 'completed' | 'failed';
  result?: {
    sharpe: number;
    return: number;
    trades: number;
  };
  error?: string;
}

interface WalkForwardConfig {
  train_window: number;
  test_window: number;
  step: number;
  anchor: string;
}

interface StrategyTemplate {
  id: string;
  name: string;
  description: string;
  code: string;
}

interface BacktestData {
  backtest?: Record<string, BacktestResult>;
  walkforward?: Record<string, WalkForwardResult>;
}

export default function StrategyLab() {
  const { data: backtestData, error: backtestError } = useLive<BacktestData>('/api/trading/backtests');
  const { data: strategyData } = useLive<{ strategies: StrategyFile[] }>('/api/trading/strategies');
  const { data: terminalHealth } = useLive<any>('/api/terminals/health');
  
  const [selectedTemplate, setSelectedTemplate] = useState<typeof STRATEGY_TEMPLATES[0] | null>(STRATEGY_TEMPLATES[0]);
  const [code, setCode] = useState(STRATEGY_TEMPLATES[0].code);
  const [walkforward, setWalkforward] = useState<WalkForwardConfig>(WALKFORWARD_DEFAULTS);
  const [notebookContent, setNotebookContent] = useState('');
  const [experiments, setExperiments] = useState<Array<{
    id: string;
    timestamp: number;
    templateId: string;
    params: Record<string, any>;
    walkforward: WalkForwardConfig;
    status: 'running' | 'completed' | 'failed';
    result?: { sharpe: number; return: number; trades: number };
    error?: string;
  }>>([]);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [notebookMarkdown] = useState(`# Research Notebook

## Strategy Idea
- **Hypothesis**: Mean reversion works best in ranging markets with high volatility
- **Asset**: BTC-USDT perp
- **Timeframe**: 15m
- **Entry**: RSI < 30 + price below BB lower band
- **Exit**: RSI > 70 or price > BB upper band

## Parameters to Test
| Param | Range | Step |
|-------|-------|------|
| RSI Period | 10-20 | 2 |
| BB Period | 15-25 | 5 |
| BB Std | 1.5-2.5 | 0.5 |

## Walk-Forward Config
- Train: 730 days (2 years)
- Test: 90 days (3 months)
- Step: 30 days
- Anchor: Rolling

## Next Steps
1. Run parameter sweep
2. Analyze walk-forward OOS stability
3. Check regime performance (trend vs range)
4. Promote if inference floor met`);

  const [experiments, setExperiments] = useState<Array<{
    id: string;
    timestamp: number;
    templateId: string;
    params: Record<string, any>;
    walkforward: WalkForwardConfig;
    status: 'running' | 'completed' | 'failed';
    result?: { sharpe: number; return: number; trades: number };
    error?: string;
  }>>([]);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [notebookMarkdown] = useState(`# Research Notebook

## Strategy Idea
- **Hypothesis**: Mean reversion works best in ranging markets with high volatility
- **Asset**: BTC-USDT perp
- **Timeframe**: 15m
- **Entry**: RSI < 30 + price below BB lower band
- **Exit**: RSI > 70 or price > BB upper band

## Parameters to Test
| Param | Range | Step |
|-------|-------|------|
| RSI Period | 10-20 | 2 |
| BB Period | 15-25 | 5 |
| BB Std | 1.5-2.5 | 0.5 |

## Walk-Forward Config
- Train: 730 days (2 years)
- Test: 90 days (3 months)
- Step: 30 days
- Anchor: Rolling

## Next Steps
1. Run parameter sweep
2. Analyze walk-forward OOS stability
3. Check regime performance (trend vs range)
4. Promote if inference floor met`);

  const { data: backtestData, error: backtestError } = useLive<BacktestData>('/api/trading/backtests');
  const { data: strategyData } = useLive<{ strategies: StrategyFile[] }>('/api/trading/strategies');
  const { data: terminalHealth } = useLive<any>('/api/terminals/health');
  
  const [selectedTemplate, setSelectedTemplate] = useState<typeof STRATEGY_TEMPLATES[0] | null>(STRATEGY_TEMPLATES[0]);
  const [code, setCode] = useState(STRATEGY_TEMPLATES[0].code);
  const [walkforward, setWalkforward] = useState<WalkForwardConfig>(WALKFORWARD_DEFAULTS);
  const [notebookContent, setNotebookContent] = useState('');
  const [experiments, setExperiments] = useState<Array<{
    id: string;
    timestamp: number;
    templateId: string;
    params: Record<string, any>;
    walkforward: WalkForwardConfig;
    status: 'running' | 'completed' | 'failed';
    result?: { sharpe: number; return: number; trades: number };
    error?: string;
  }>>([]);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [notebookMarkdown] = useState(`# Research Notebook

## Strategy Idea
- **Hypothesis**: Mean reversion works best in ranging markets with high volatility
- **Asset**: BTC-USDT perp
- **Timeframe**: 15m
- **Entry**: RSI < 30 + price below BB lower band
- **Exit**: RSI > 70 or price > BB upper band

## Parameters to Test
| Param | Range | Step |
|-------|-------|------|
| RSI Period | 10-20 | 2 |
| BB Period | 15-25 | 5 |
| BB Std | 1.5-2.5 | 0.5 |

## Walk-Forward Config
- Train: 730 days (2 years)
- Test: 90 days (3 months)
- Step: 30 days
- Anchor: Rolling

## Next Steps
1. Run parameter sweep
2. Analyze walk-forward OOS stability
3. Check regime performance (trend vs range)
4. Promote if inference floor met`);

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
                  <select
                    className="input w-full"
                    value={walkforward.anchor}
                    onChange={(e) => setWalkforward(w => ({ ...w, anchor: e.target.value }))}
                  >
                    <option value="rolling">Rolling</option>
                    <option value="anchored">Anchored</option>
                  </select>
                </div>
              </div>
            </div>

            <button
              type="button"
              className="btn btn-primary w-full mt-3"
              onClick={handleRunBacktest}
              disabled={!terminalReady || !!runningJob}
            >
              {runningJob ? 'Running ' + runningJob + '...' : 'RUN BACKTEST'}
            </button>
          </div>
        </div>

        {/* Center: Research Notebook */}
        <div className="xl:col-span-1 panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">RESEARCH NOTEBOOK</h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 h-[500px]">
            <div className="panel-surface p-3 overflow-auto">
              <CodeEditor
                value={notebookContent || notebookMarkdown}
                onValueChange={setNotebookContent}
                style={{
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  lineHeight: '1.5',
                  width: '100%',
                  height: '100%',
                  background: '#0b0e14',
                  color: '#e5e7eb',
                  padding: '8px',
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                }}
                tabSize={2}
                insertSpaces={true}
                highlight={(code) => code}
                padding={8}
              />
            </div>
            <div className="panel-surface p-3 overflow-auto bg-hud-bg" dangerouslySetInnerHTML={{ __html: marked.parse(notebookContent || notebookMarkdown || '') }} />
          </div>
        </div>

        {/* Right: Experiment Tracker */}
        <div className="xl:col-span-1 panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">EXPERIMENT TRACKER</h3>
          <div className="space-y-2 max-h-[500px] overflow-auto">
            {renderExperimentTracker()}
          </div>
        </div>
      </div>

      {/* Bottom: Results Tables */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">BACKTEST RESEARCH</h3>
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Strategy</th><th>Sharpe</th><th>Return</th><th>Consistency</th></tr></thead>
              <tbody>
                {backtests.map(([name, result]) => (
                  <tr key={name}>
                    <td className="max-w-[220px] truncate" title={name}>{name}</td>
                    <td className={valueTone(result.avg_test_sharpe)}>{formatNumber(result.avg_test_sharpe)}</td>
                    <td className={valueTone(result.avg_test_return)}>{formatPercent(result.avg_test_return)}</td>
                    <td>{formatPercent(result.consistency)}</td>
                  </tr>
                ))}
                {backtestError && <tr><td colSpan={4} className="py-8 text-center text-hud-red">Backtest data unavailable: {backtestError}</td></tr>}
                {!backtestError && !backtestData && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">Loading backtest data…</td></tr>}
                {backtestData && backtests.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">No backtest data</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">WALK-FORWARD ANALYSIS</h3>
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Strategy</th><th>OOS return</th><th>Positive</th><th>Windows</th></tr></thead>
              <tbody>
                {walkforwards.map(([name, result]) => (
                  <tr key={name}>
                    <td className="max-w-[220px] truncate" title={name}>{name}</td>
                    <td className={valueTone(result.avg_oos_return)}>{formatPercent(result.avg_oos_return)}</td>
                    <td>{result.positive_oos_periods}/{result.total_periods}</td>
                    <td>{result.num_windows}</td>
                  </tr>
                ))}
                {!backtestData && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">Loading walk-forward data…</td></tr>}
                {backtestData && walkforwards.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">No walk-forward data</td></tr>}
              </tbody>
            </table>
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

function formatNumber(value: number | null | undefined, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function formatPercent(value: number | null | undefined, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '--';
}

function valueTone(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 'text-hud-dim';
  return value > 0 ? 'text-hud-green' : 'text-hud-red';
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="panel-surface px-3 py-2">
      <div className="text-[10px] font-mono text-hud-dim">{label}</div>
      <div className={`mt-1 font-mono text-sm ${tone || 'text-hud-text'}`}>{value}</div>
    </div>
  );
}

function Badge({ label, variant }: { label: string; variant?: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }) {
  const variants = {
    success: 'badge-success',
    warning: 'badge-warning',
    danger: 'badge-danger',
    info: 'badge-info',
    neutral: 'badge-neutral',
  };
  return (
    <span className={`badge font-mono ${variants[variant]} text-[10px]`}>{label}</span>
  );
}