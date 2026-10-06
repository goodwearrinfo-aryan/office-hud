import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, mockUseLive, createMockBacktestData, clearMockUseLive } from '../test/utils';
import TradingLab from '../components/TradingLab';

const mockBacktestData = createMockBacktestData();

const mockStrategies = {
  strategies: [
    { file: 'ema_crossover.py', path: '/home/trading-bot/strategies/ema_crossover.py' },
    { file: 'rsi_meanrev.py', path: '/home/trading-bot/strategies/rsi_meanrev.py' },
  ],
};

const mockLive = {
  dbExists: true,
  logExists: true,
  logSize: 2048576,
};

describe('TradingLab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', mockBacktestData, null, false);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    mockUseLive('/api/trading/live', mockLive, null, false);
  });

  it('renders without crashing', () => {
    const { container } = renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(container).toBeInTheDocument();
  });

  it('shows floor title', () => {
    const { getByText } = renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(getByText('F6 · TRADING LAB')).toBeInTheDocument();
  });

  it('shows READ ONLY badge', () => {
    const { getByText } = renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(getByText('READ ONLY · PAPER / TESTNET')).toBeInTheDocument();
  });

  it('renders metric cards', () => {
    const { getAllByText } = renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(getAllByText('DATABASE')).toHaveLength(1);
    expect(getAllByText('TRADING LOG')).toHaveLength(1);
    expect(getAllByText('STRATEGY FILES')).toHaveLength(2); // metric label + table header
  });

  it('renders backtest table with data', () => {
    const { getByText, getAllByText } = renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(getByText('BACKTEST RESULTS')).toBeInTheDocument();
    const emaCrossover = getAllByText('EMA_Crossover');
    expect(emaCrossover.length).toBeGreaterThanOrEqual(1);
    const rsi = getAllByText('RSI_MeanReversion');
    expect(rsi.length).toBeGreaterThanOrEqual(1);
    expect(getByText('1.85')).toBeInTheDocument(); // Sharpe
    expect(getByText('23.4%')).toBeInTheDocument(); // Return
  });

  it('renders walk-forward table with data', () => {
    const { getByText, getAllByText } = renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(getByText('WALK-FORWARD RESULTS')).toBeInTheDocument();
    // The "5" in "5 / 7" is part of a text node, use a partial match
    const positiveCells = getAllByText((content) => content.includes('5') && content.includes('/'));
    expect(positiveCells.length).toBeGreaterThanOrEqual(1);
  });

  it('renders strategy files table', () => {
    const { getAllByText, getByText } = renderWithProviders(<TradingLab onNavigate={() => {}} />);
    const strategyFilesHeaders = getAllByText('STRATEGY FILES');
    expect(strategyFilesHeaders.length).toBe(2); // metric label + table header
    expect(getByText('ema_crossover.py')).toBeInTheDocument();
    expect(getByText('rsi_meanrev.py')).toBeInTheDocument();
  });

  it('shows loading state when data is not ready', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', null, null, true);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    mockUseLive('/api/trading/live', mockLive, null, false);
    const { getByText } = renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(getByText('Loading backtest data…')).toBeInTheDocument();
  });

  it('shows error state when backtest data fails', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', null, 'Failed to fetch', false);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    mockUseLive('/api/trading/live', mockLive, null, false);
    const { getByText } = renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(getByText('Backtest data unavailable: Failed to fetch')).toBeInTheDocument();
  });

  it('shows empty state when no backtest data', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', { backtest: {}, walkforward: {} }, null, false);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    mockUseLive('/api/trading/live', mockLive, null, false);
    const { getByText } = renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(getByText('No backtest data')).toBeInTheDocument();
  });
});