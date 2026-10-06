'use strict';
// Risk metrics library for F11 Risk Metrics floor.
// Computes VaR, CVaR, Max Drawdown, and correlation from trade/position data.

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1));
}

function covariance(arr1, arr2) {
  if (arr1.length !== arr2.length || !arr1.length) return 0;
  const m1 = mean(arr1);
  const m2 = mean(arr2);
  return arr1.reduce((sum, v, i) => sum + (v - m1) * (arr2[i] - m2), 0) / (arr1.length - 1);
}

function correlation(arr1, arr2) {
  const cov = covariance(arr1, arr2);
  const sd1 = stdev(arr1);
  const sd2 = stdev(arr2);
  if (sd1 === 0 || sd2 === 0) return 0;
  return cov / (sd1 * sd2);
}

/**
 * Historical Value at Risk (VaR) at confidence level.
 * @param {number[]} returns - Daily returns (can be negative)
 * @param {number} confidence - Confidence level (e.g., 0.95 for 95%)
 * @returns {number|null} VaR as positive number (loss magnitude)
 */
function historicalVaR(returns, confidence = 0.95) {
  if (!returns.length) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.floor((1 - confidence) * returns.length);
  return Math.abs(sorted[idx] || 0);
}

/**
 * Conditional Value at Risk (CVaR / Expected Shortfall).
 * Average of losses beyond VaR threshold.
 * @param {number[]} returns - Daily returns
 * @param {number} confidence - Confidence level (e.g., 0.95)
 * @returns {number|null} CVaR as positive number
 */
function historicalCVaR(returns, confidence = 0.95) {
  if (!returns.length) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.floor((1 - confidence) * returns.length);
  const tail = sorted.slice(0, Math.max(1, idx + 1));
  return Math.abs(mean(tail));
}

/**
 * Maximum Drawdown from equity curve.
 * @param {number[]} equity - Equity values over time
 * @returns {{maxDrawdown: number, maxDrawdownPct: number, peak: number, trough: number}}
 */
function maxDrawdown(equity) {
  if (!equity.length) return { maxDrawdown: 0, maxDrawdownPct: 0, peak: 0, trough: 0 };
  let peak = equity[0];
  let maxDD = 0;
  let maxDDPct = 0;
  let peakVal = equity[0];
  let troughVal = equity[0];
  for (const v of equity) {
    if (v > peak) {
      peak = v;
    }
    const dd = peak - v;
    const ddPct = peak > 0 ? dd / peak : 0;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDPct = ddPct;
      peakVal = peak;
      troughVal = v;
    }
  }
  return { maxDrawdown: maxDD, maxDrawdownPct: maxDDPct, peak: peakVal, trough: troughVal };
}

/**
 * Pairwise correlation matrix for strategy returns.
 * @param {Object.<string, number[]>} strategyReturns - Map of strategy name to daily returns
 * @returns {Object.<string, Object.<string, number>>} Correlation matrix
 */
function correlationMatrix(strategyReturns) {
  const names = Object.keys(strategyReturns);
  const matrix = {};
  for (const name1 of names) {
    matrix[name1] = {};
    for (const name2 of names) {
      if (name1 === name2) {
        matrix[name1][name2] = 1;
      } else {
        matrix[name1][name2] = correlation(strategyReturns[name1], strategyReturns[name2]);
      }
    }
  }
  return matrix;
}

/**
 * Stress test scenarios.
 * @param {number[]} equity - Equity curve
 * @param {Object.<string, number[]>} strategyReturns - Strategy daily returns
 * @returns {Object} Stress test results
 */
function stressTests(equity, strategyReturns) {
  const { maxDrawdown: maxDD, maxDrawdownPct } = maxDrawdown(equity);
  const currentEquity = equity[equity.length - 1] || 10000;
  const peak = Math.max(...equity);
  
  return {
    marketCrash: {
      scenario: 'Market crash (-20%)',
      equityAfter: currentEquity * 0.8,
      drawdown: (currentEquity * 0.2) / currentEquity,
    },
    flashCrash: {
      scenario: 'Flash crash (-10% in 1hr)',
      equityAfter: currentEquity * 0.9,
      drawdown: 0.1,
    },
    liquidityCrisis: {
      scenario: 'Liquidity crisis (50% wider spreads)',
      equityAfter: currentEquity * 0.95,
      drawdown: 0.05,
    },
    correlationBreakdown: {
      scenario: 'Correlation breakdown (all corr = 1)',
      equityAfter: currentEquity * (1 - maxDrawdownPct),
      drawdown: maxDrawdownPct,
    },
    currentMaxDrawdown: { value: maxDD, pct: maxDrawdownPct },
  };
}

/**
 * Compute daily returns from equity curve.
 * @param {number[]} equity
 * @returns {number[]}
 */
function computeReturns(equity) {
  if (equity.length < 2) return [];
  const returns = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    if (prev > 0) {
      returns.push((equity[i] - prev) / prev);
    }
  }
  return returns;
}

/**
 * Aggregate strategy returns from trade data.
 * @param {Array} trades - Array of trades with {strategy, pnl_usd, entry_time, exit_time}
 * @returns {Object.<string, number[]>} Daily returns per strategy
 */
function aggregateStrategyReturns(trades) {
  if (!trades?.length) return {};
  // Group trades by date and strategy
  const byDateStrategy = {};
  for (const t of trades) {
    if (!t.exit_time || !t.strategy) continue;
    const date = new Date(t.exit_time).toISOString().split('T')[0];
    const key = `${date}|${t.strategy}`;
    if (!byDateStrategy[key]) byDateStrategy[key] = { pnl: 0, equity: 0 };
    byDateStrategy[key].pnl += t.pnl_usd || 0;
  }
  // Convert to daily returns per strategy (simplified: assume starting equity)
  const strategies = new Set(Object.values(trades).map(t => t.strategy).filter(Boolean));
  const result = {};
  for (const strat of strategies) {
    const daily = [];
    // This is a simplified version - in reality you'd need starting equity per strategy
    // For now return empty arrays - the real implementation would need more data
    result[strat] = daily;
  }
  return result;
}

/**
 * Compute portfolio metrics from trades and positions.
 * @param {Array} trades - Closed trades
 * @param {Array} positions - Open positions
 * @param {number} startingEquity - Starting equity
 * @returns {Object} Portfolio metrics
 */
function computePortfolioMetrics(trades, positions, startingEquity = 10000) {
  const closedPnl = trades?.reduce((sum, t) => sum + (t.pnl_usd || 0), 0) || 0;
  const unrealizedPnl = positions?.reduce((sum, p) => sum + (p.unrealized_pnl || 0), 0) || 0;
  const currentEquity = startingEquity + closedPnl + unrealizedPnl;
  const totalPnl = closedPnl + unrealizedPnl;
  const totalPnlPct = startingEquity > 0 ? totalPnl / startingEquity : 0;
  
  const wins = trades?.filter(t => (t.pnl_usd || 0) > 0).length || 0;
  const losses = trades?.filter(t => (t.pnl_usd || 0) < 0).length || 0;
  const totalTrades = trades?.length || 0;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  
  const grossProfit = trades?.filter(t => (t.pnl_usd || 0) > 0).reduce((s, t) => s + t.pnl_usd, 0) || 0;
  const grossLoss = Math.abs(trades?.filter(t => (t.pnl_usd || 0) < 0).reduce((s, t) => s + t.pnl_usd, 0)) || 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  
  return {
    startingEquity,
    currentEquity,
    closedPnl,
    unrealizedPnl,
    totalPnl,
    totalPnlPct,
    winRate,
    profitFactor,
    totalTrades,
    wins,
    losses,
  };
}

module.exports = {
  historicalVaR,
  historicalCVaR,
  maxDrawdown,
  correlationMatrix,
  stressTests,
  computeReturns,
  aggregateStrategyReturns,
  computePortfolioMetrics,
  percentile,
  mean,
  stdev,
  covariance,
  correlation,
};