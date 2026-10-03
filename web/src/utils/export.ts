// Export utilities for CSV/JSON download

/**
 * Which file(s) an export call should produce.
 *
 * Every exporter used to emit JSON *and* CSV unconditionally, while the button
 * that calls them offered "Download JSON" and "Download CSV" as two separate
 * menu items. Both items therefore produced two downloads, and neither did what
 * it said. `both` stays the default so any caller that never picked a format
 * keeps its old behaviour.
 */
export type ExportFormat = 'json' | 'csv' | 'both';

function emit(rows: any[], name: string, format: ExportFormat): void {
  if (format !== 'csv') downloadJSON(rows, `${name}-${Date.now()}.json`);
  if (format !== 'json') downloadCSV(rows, `${name}-${Date.now()}.csv`);
}

export function downloadJSON(data: any, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadCSV(data: any[], filename: string) {
  if (!data.length) return;
  const headers = Object.keys(data[0]);
  const rows = data.map(row => headers.map(h => {
    const val = row[h];
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val).includes(',') ? `"${String(val).replace(/"/g, '""')}"` : String(val);
  }).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportAgents(agents: any[], format: ExportFormat = 'both') {
  const simplified = agents.map(a => ({
    id: a.id,
    name: a.name,
    role: a.role,
    isGod: a.isGod,
    status: a.display,
    archived: a.archived,
    breaker: a.breaker,
    provider: a.provider,
    cwd: a.cwd,
    cwdValid: a.cwdValid,
    tokens: a.tokens,
    usd: a.usd,
    sessionUsd: a.sessionUsd,
    lastTool: a.lastTool,
    lastActiveSecAgo: a.lastActiveSecAgo,
    inboxBacklog: a.inboxBacklog,
    onHold: a.onHold,
    lastSeen: a.lastSeen,
    lastSeenHuman: a.lastSeen ? new Date(a.lastSeen).toISOString() : '',
  }));
  emit(simplified, 'agents', format);
}

export function exportLedger(events: any[], format: ExportFormat = 'both') {
  const simplified = events.map(e => ({
    ts: e.ts,
    tsHuman: e.ts ? new Date(e.ts > 1e12 ? e.ts : e.ts * 1000).toISOString() : '',
    kind: e.kind,
    ...Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'ts' && k !== 'kind')),
  }));
  emit(simplified, 'ledger', format);
}

export function exportBacktest(backtest: any, format: ExportFormat = 'both') {
  if (format !== 'csv') downloadJSON(backtest, `backtest-${Date.now()}.json`);
  // Flatten for CSV
  const rows: any[] = [];
  for (const [strategy, data] of Object.entries(backtest)) {
    if (typeof data === 'object' && data !== null && 'windows' in data) {
      (data as any).windows.forEach((w: any, i: number) => {
        rows.push({
          strategy,
          window: i,
          train_start: w.train_start,
          train_end: w.train_end,
          test_start: w.test_start,
          test_end: w.test_end,
          ...w.best_params,
          train_sharpe: w.train_sharpe,
          test_sharpe: w.test_sharpe,
          test_return: w.test_return,
          test_max_dd: w.test_max_dd,
          test_win_rate: w.test_win_rate,
          test_profit_factor: w.test_profit_factor,
          test_trades: w.test_trades,
        });
      });
    }
  }
  if (format !== 'json') downloadCSV(rows, `backtest-windows-${Date.now()}.csv`);
}

export function exportRiskMetrics(metrics: any[], format: ExportFormat = 'both') {
  emit(metrics, 'risk-metrics', format);
}