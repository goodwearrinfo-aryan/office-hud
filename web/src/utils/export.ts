// Export utilities for CSV/JSON download

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

export function exportAgents(agents: any[]) {
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
  downloadJSON(simplified, `agents-${Date.now()}.json`);
  downloadCSV(simplified, `agents-${Date.now()}.csv`);
}

export function exportLedger(events: any[]) {
  const simplified = events.map(e => ({
    ts: e.ts,
    tsHuman: e.ts ? new Date(e.ts > 1e12 ? e.ts : e.ts * 1000).toISOString() : '',
    kind: e.kind,
    ...Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'ts' && k !== 'kind')),
  }));
  downloadJSON(simplified, `ledger-${Date.now()}.json`);
  downloadCSV(simplified, `ledger-${Date.now()}.csv`);
}

export function exportBacktest(backtest: any) {
  downloadJSON(backtest, `backtest-${Date.now()}.json`);
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
  downloadCSV(rows, `backtest-windows-${Date.now()}.csv`);
}

export function exportRiskMetrics(metrics: any[]) {
  downloadJSON(metrics, `risk-metrics-${Date.now()}.json`);
  downloadCSV(metrics, `risk-metrics-${Date.now()}.csv`);
}