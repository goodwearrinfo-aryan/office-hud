import { useLive } from '../api';

type CandleStrategySignal = {
  signal_id: string;
  timestamp: string;
  strategy_id: string;
  direction: 'LONG' | 'SHORT' | 'NO_TRADE';
  setup: string;
  candle_pattern: string;
  market_context: string;
  location: string;
  entry: { price: number; order_type: string };
  stop_loss: { price: number; type: string };
  target_1: { price: number; type: string };
  target_2: { price: number; type: string } | null;
  risk_reward: number;
  oi_state: string;
  oi_confirmation: string;
  nifty_15m_confirmation: string;
  time_filter: string;
  confidence: number;
  invalidation: { condition: string; price_level: number | null };
  evidence: Record<string, unknown>;
  missing_information: string[];
  status: string;
  no_trade_reasons: string[];
};

type CandleStrategyFeed = {
  timestamp: number;
  timeframe: string;
  symbols: Record<string, {
    signals: CandleStrategySignal[];
    summary: {
      total_strategies: number;
      confirmed_long: number;
      confirmed_short: number;
      no_trade: number;
    };
  }>;
};

function formatNumber(value: number | null | undefined, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function formatPercent(value: number | null | undefined, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
}

function valueTone(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 'text-hud-dim';
  return value > 0 ? 'text-hud-green' : 'text-hud-red';
}

function directionBadge(direction: string) {
  if (direction === 'LONG') return <span className="badge badge-success">LONG</span>;
  if (direction === 'SHORT') return <span className="badge badge-error">SHORT</span>;
  return <span className="badge badge-ghost">NO TRADE</span>;
}

function confirmationBadge(confirmation: string) {
  if (confirmation === 'CONFIRMED') return <span className="badge badge-success badge-xs">✓</span>;
  if (confirmation === 'CONFLICTING') return <span className="badge badge-error badge-xs">✗</span>;
  if (confirmation === 'MISSING') return <span className="badge badge-warning badge-xs">?</span>;
  return <span className="badge badge-ghost badge-xs">{confirmation}</span>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="panel-surface px-3 py-2">
      <div className="text-[10px] font-mono text-hud-dim">{label}</div>
      <div className={`mt-1 font-mono text-sm ${tone || 'text-hud-text'}`}>{value}</div>
    </div>
  );
}

export default function CandleStrategies() {
  const { data: feed } = useLive<CandleStrategyFeed>('/api/trading/candle-strategies');

  if (!feed) {
    return (
      <div className="h-full overflow-auto p-4">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 className="font-mono text-hud-amber text-lg">F8 · CANDLE STRATEGIES</h2>
          <span className="badge badge-info">PAPER ONLY</span>
        </div>
        <div className="text-center py-12 text-hud-dim">Loading candle strategy feed…</div>
      </div>
    );
  }

  const symbols = Object.entries(feed.symbols ?? {});
  const totalConfirmed = symbols.reduce((sum, [, data]) => sum + data.summary.confirmed_long + data.summary.confirmed_short, 0);
  const totalNoTrade = symbols.reduce((sum, [, data]) => sum + data.summary.no_trade, 0);

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F8 · CANDLE STRATEGIES</h2>
        <div className="flex items-center gap-2">
          <span className="badge badge-info">PAPER ONLY</span>
          <span className="badge badge-ghost">{feed.timeframe}</span>
          <span className="text-[10px] font-mono text-hud-dim">
            Updated: {new Date(feed.timestamp).toLocaleTimeString()}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
        <Metric label="SYMBOLS" value={String(symbols.length)} />
        <Metric label="CONFIRMED" value={String(totalConfirmed)} tone={totalConfirmed > 0 ? 'text-hud-green' : 'text-hud-dim'} />
        <Metric label="LONG" value={String(symbols.reduce((s, [, d]) => s + d.summary.confirmed_long, 0))} tone="text-hud-green" />
        <Metric label="SHORT" value={String(symbols.reduce((s, [, d]) => s + d.summary.confirmed_short, 0))} tone="text-hud-red" />
      </div>

      {symbols.length === 0 && (
        <div className="panel p-8 text-center text-hud-dim">
          No candle strategy data available. Run feed generator to populate.
        </div>
      )}

      <div className="space-y-4">
        {symbols.map(([symbol, data]) => (
          <div key={symbol} className="panel p-4 min-w-0">
            <div className="flex items-center justify-between gap-4 mb-4">
              <h3 className="font-mono text-hud-amber text-lg">{symbol}</h3>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-hud-dim">
                  {data.summary.confirmed_long} LONG · {data.summary.confirmed_short} SHORT · {data.summary.no_trade} NO TRADE
                </span>
              </div>
            </div>

            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-[180px]">Strategy</th>
                    <th className="w-[80px]">Dir</th>
                    <th className="w-[60px]">Conf</th>
                    <th className="w-[60px]">OI</th>
                    <th className="w-[60px]">NIFTY</th>
                    <th className="w-[60px]">Time</th>
                    <th className="w-[80px]">Entry</th>
                    <th className="w-[80px]">SL</th>
                    <th className="w-[80px]">T1</th>
                    <th className="w-[80px]">RR</th>
                    <th>Reason / Invalidation</th>
                  </tr>
                </thead>
                <tbody>
                  {data.signals.map(signal => (
                    <tr key={signal.signal_id} className={signal.direction === 'NO_TRADE' ? 'opacity-50' : ''}>
                      <td className="font-mono text-xs truncate" title={signal.strategy_id}>
                        {signal.strategy_id.replace('CANDLE_', '')}
                      </td>
                      <td>{directionBadge(signal.direction)}</td>
                      <td className={valueTone(signal.confidence)}>
                        {formatPercent(signal.confidence, 0)}
                      </td>
                      <td>{confirmationBadge(signal.oi_confirmation)}</td>
                      <td>{confirmationBadge(signal.nifty_15m_confirmation)}</td>
                      <td>{confirmationBadge(signal.time_filter)}</td>
                      <td className="font-mono text-xs">{formatNumber(signal.entry.price)}</td>
                      <td className="font-mono text-xs text-hud-red">{formatNumber(signal.stop_loss.price)}</td>
                      <td className="font-mono text-xs text-hud-green">{formatNumber(signal.target_1.price)}</td>
                      <td className={valueTone(signal.risk_reward - 1)}>{formatNumber(signal.risk_reward)}</td>
                      <td className="text-[10px] text-hud-dim max-w-xs truncate" title={signal.invalidation.condition}>
                        {signal.direction === 'NO_TRADE' 
                          ? signal.no_trade_reasons.join(', ') 
                          : signal.invalidation.condition}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 panel p-4 text-[10px] text-hud-dim">
        <strong>Legend:</strong> Dir=Direction | Conf=Confidence | OI=Open Interest Confirmation | NIFTY=NIFTY 15m Confirmation | Time=Time Window Filter | SL=Stop Loss | T1=Target 1 | RR=Risk/Reward
        <br />
        All signals are <strong>PAPER ONLY</strong> — never promoted to live. NO_TRADE rows show rejected setups with reasons.
      </div>
    </div>
  );
}