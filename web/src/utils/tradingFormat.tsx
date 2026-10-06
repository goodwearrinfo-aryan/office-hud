export function formatNumber(value: number | null | undefined, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(digits)
    : '--';
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(digits)}%`
    : '--';
}

export function formatBps(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 10000).toFixed(0)} bps`
    : '--';
}

export function formatCurrency(value: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(value as number)) return '--';
  const v = value as number;
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toFixed(digits)}`;
}

export function formatLargeNumber(value: number | null | undefined): string {
  if (!Number.isFinite(value as number)) return '--';
  const v = Math.abs(value as number);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export function valueTone(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
    return 'text-hud-dim';
  }
  return value > 0 ? 'text-hud-green' : 'text-hud-red';
}

export function regimeLabel(regime: string | null | undefined): string {
  if (!regime) return 'UNKNOWN';
  const r = regime.toLowerCase();
  if (r.includes('bull') || r.includes('up')) return 'BULL';
  if (r.includes('bear') || r.includes('down')) return 'BEAR';
  if (r.includes('side') || r.includes('range')) return 'SIDEWAYS';
  return regime.toUpperCase();
}

export function timeframeLabel(tf: string | null | undefined): string {
  if (!tf) return '--';
  const t = tf.toLowerCase();
  if (t.includes('1m') || t === '1min') return '1m';
  if (t.includes('5m') || t === '5min') return '5m';
  if (t.includes('15m') || t === '15min') return '15m';
  if (t.includes('1h') || t === '1hour') return '1h';
  if (t.includes('4h') || t === '4hour') return '4h';
  if (t.includes('1d') || t === '1day') return '1d';
  if (t.includes('1w') || t === '1week') return '1w';
  return tf.toUpperCase();
}

export function assetClassLabel(asset: string | null | undefined): string {
  if (!asset) return '--';
  const a = asset.toLowerCase();
  if (a.includes('btc') || a.includes('bitcoin')) return 'BTC';
  if (a.includes('eth') || a.includes('ethereum')) return 'ETH';
  if (a.includes('sol') || a.includes('solana')) return 'SOL';
  if (a.includes('usd') || a.includes('stable')) return 'STABLE';
  if (a.includes('perp') || a.includes('future')) return 'PERP';
  return asset.toUpperCase();
}

export function strategyTypeLabel(type: string | null | undefined): string {
  if (!type) return 'UNKNOWN';
  const t = type.toLowerCase();
  if (t.includes('mean') || t.includes('revert')) return 'MEAN-REV';
  if (t.includes('trend') || t.includes('follow')) return 'TREND';
  if (t.includes('break') || t.includes('out')) return 'BREAKOUT';
  if (t.includes('stat') || t.includes('arb')) return 'STAT-ARB';
  if (t.includes('fund') || t.includes('carry')) return 'FUNDING';
  return type.toUpperCase();
}

export interface MetricProps {
  label: string;
  value: string;
  tone?: string;
  sub?: string;
}

export function Metric({ label, value, tone = 'text-hud-text', sub }: MetricProps) {
  return (
    <div className="panel-surface px-3 py-2 min-w-0">
      <div className="text-[10px] font-mono text-hud-dim truncate">{label}</div>
      <div className={`mt-1 font-mono text-sm ${tone}`}>{value}</div>
      {sub && <div className="text-[10px] text-hud-dim mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

export interface BadgeProps {
  label: string;
  variant?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  size?: 'sm' | 'md';
}

export function Badge({ label, variant = 'neutral', size = 'sm' }: BadgeProps) {
  const base = 'badge font-mono';
  const sizes = { sm: 'text-[10px] px-2 py-0.5', md: 'text-xs px-2.5 py-1' };
  const variants = {
    success: 'badge-success',
    warning: 'badge-warning',
    danger: 'badge-danger',
    info: 'badge-info',
    neutral: 'badge-neutral',
  };
  return (
    <span className={`${base} ${variants[variant]} ${sizes[size]}`}>
      {label}
    </span>
  );
}

export function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return <Badge label={label} variant={ok ? 'success' : 'warning'} />;
}

export function money(value: number | null | undefined): string {
  if (!Number.isFinite(value as number)) return '--';
  const v = value as number;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
}

export function price(value: number | null | undefined, digits = 3): string {
  if (!Number.isFinite(value as number)) return '--';
  return (value as number).toFixed(digits);
}

export function share(value: number | null | undefined, digits = 1): string {
  if (!Number.isFinite(value as number)) return '--';
  return `${((value as number) * 100).toFixed(digits)}%`;
}

export function stamp(value: string | null | undefined): string {
  if (!value) return '--';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '--';
  return parsed.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortId(id: string, prefix = 10, suffix = 6): string {
  if (id.length <= prefix + suffix + 1) return id;
  return `${id.slice(0, prefix)}…${id.slice(-suffix)}`;
}