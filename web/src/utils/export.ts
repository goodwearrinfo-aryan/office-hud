export type ExportFormat = 'json' | 'csv';

const toCsv = (rows: Record<string, unknown>[]): string => {
  if (!rows.length) return '';
  const headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\n');
};

const download = (name: string, content: string, mime: string) => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

const write = (base: string, data: unknown[], format: ExportFormat) => {
  if (format === 'csv') {
    download(`${base}-${stamp()}.csv`, toCsv(data as Record<string, unknown>[]), 'text/csv');
  } else {
    download(`${base}-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
  }
};

export function exportAgents(agents: unknown[], format: ExportFormat): void {
  write('agents', agents, format);
}

export function exportLedger(events: unknown[], format: ExportFormat): void {
  write('ledger', events, format);
}

export function exportBacktest(backtestData: unknown, format: ExportFormat): void {
  write('backtest', Array.isArray(backtestData) ? backtestData : [backtestData], format);
}

export function exportRiskMetrics(metrics: unknown[], format: ExportFormat): void {
  write('risk-metrics', metrics, format);
}
