import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, mockUseLive, createMockBacktestData, clearMockUseLive } from '../test/utils';
import StrategyLab from '../components/StrategyLab';

const mockBacktestData = createMockBacktestData();

const mockStrategies = {
  strategies: [
    { file: 'ema_crossover.py', path: '/home/trading-bot/strategies/ema_crossover.py' },
    { file: 'rsi_meanrev.py', path: '/home/trading-bot/strategies/rsi_meanrev.py' },
  ],
};

describe('StrategyLab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', mockBacktestData, null, false);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
  });

  it('renders without crashing', () => {
    const { container } = renderWithProviders(<StrategyLab />);
    expect(container).toBeInTheDocument();
  });

  it('shows floor title', () => {
    const { getByText } = renderWithProviders(<StrategyLab />);
    expect(getByText('F7 · STRATEGY LAB')).toBeInTheDocument();
  });

  it('shows READ ONLY RESEARCH badge', () => {
    const { getByText } = renderWithProviders(<StrategyLab />);
    expect(getByText('READ ONLY RESEARCH')).toBeInTheDocument();
  });

  it('renders KPI metric cards', () => {
    const { getByText } = renderWithProviders(<StrategyLab />);
    expect(getByText('EVALUATED')).toBeInTheDocument();
    expect(getByText('BEST SHARPE')).toBeInTheDocument();
    expect(getByText('BEST OOS RETURN')).toBeInTheDocument();
    expect(getByText('STRATEGY FILES')).toBeInTheDocument();
  });

  it('shows best sharpe and OOS return values', () => {
    const { getAllByText } = renderWithProviders(<StrategyLab />);
    const sharpeValues = getAllByText('1.85');
    expect(sharpeValues.length).toBeGreaterThanOrEqual(1);
    const oosValues = getAllByText('13.4%');
    expect(oosValues.length).toBeGreaterThanOrEqual(1);
  });

  it('renders research notebook section', () => {
    const { getByText } = renderWithProviders(<StrategyLab />);
    expect(getByText('RESEARCH NOTEBOOK')).toBeInTheDocument();
    expect(getByText((content) => content.includes('read-only research'))).toBeInTheDocument();
  });

  it('renders strategy catalog', () => {
    const { getByText } = renderWithProviders(<StrategyLab />);
    expect(getByText('STRATEGY CATALOG')).toBeInTheDocument();
    expect(getByText('ema_crossover.py')).toBeInTheDocument();
    expect(getByText('rsi_meanrev.py')).toBeInTheDocument();
  });

  it('renders backtest research table', () => {
    const { getByText, getAllByText } = renderWithProviders(<StrategyLab />);
    expect(getByText('BACKTEST RESEARCH')).toBeInTheDocument();
    const ema = getAllByText('EMA_Crossover');
    expect(ema.length).toBeGreaterThanOrEqual(1);
    const rsi = getAllByText('RSI_MeanReversion');
    expect(rsi.length).toBeGreaterThanOrEqual(1);
  });

  it('renders walk-forward analysis table', () => {
    const { getByText, getAllByText } = renderWithProviders(<StrategyLab />);
    expect(getByText('WALK-FORWARD ANALYSIS')).toBeInTheDocument();
    const positiveCells = getAllByText((content) => content.includes('5') && content.includes('/'));
    expect(positiveCells.length).toBeGreaterThanOrEqual(1);
    const windows = getAllByText('7');
    expect(windows.length).toBeGreaterThanOrEqual(1);
  });

  it('shows loading state when data is not ready', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', null, null, true);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    const { getByText } = renderWithProviders(<StrategyLab />);
    expect(getByText('Loading backtest data…')).toBeInTheDocument();
  });

  it('shows error state when backtest data fails', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', null, 'Failed to fetch', false);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    const { getByText } = renderWithProviders(<StrategyLab />);
    expect(getByText('Backtest data unavailable: Failed to fetch')).toBeInTheDocument();
  });

  it('shows empty state when no backtest data', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', { backtest: {}, walkforward: {} }, null, false);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    const { getByText } = renderWithProviders(<StrategyLab />);
    expect(getByText('No backtest data')).toBeInTheDocument();
  });

  it('shows empty state when no strategy files', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', mockBacktestData, null, false);
    mockUseLive('/api/trading/strategies', { strategies: [] }, null, false);
    const { getByText } = renderWithProviders(<StrategyLab />);
    expect(getByText('No strategy files found')).toBeInTheDocument();
  });
});