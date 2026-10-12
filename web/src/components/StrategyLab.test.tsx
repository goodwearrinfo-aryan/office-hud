import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/dom';
import '@testing-library/jest-dom';
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
    renderWithProviders(<StrategyLab />);
    expect(screen.getByText('F7 · STRATEGY LAB')).toBeInTheDocument();
  });

  it('shows READ ONLY RESEARCH badge', () => {
    renderWithProviders(<StrategyLab />);
    expect(screen.getByText('READ ONLY RESEARCH')).toBeInTheDocument();
  });

  it('renders KPI metric cards', () => {
    renderWithProviders(<StrategyLab />);
    expect(screen.getByText('EVALUATED')).toBeInTheDocument();
    expect(screen.getByText('BEST SHARPE')).toBeInTheDocument();
    expect(screen.getByText('BEST OOS RETURN')).toBeInTheDocument();
    expect(screen.getByText('STRATEGY FILES')).toBeInTheDocument();
  });

  it('shows best sharpe and OOS return values', () => {
    renderWithProviders(<StrategyLab />);
    const sharpeValues = screen.getAllByText('1.85');
    expect(sharpeValues.length).toBeGreaterThanOrEqual(1);
    const oosValues = screen.getAllByText('13.4%');
    expect(oosValues.length).toBeGreaterThanOrEqual(1);
  });

  it('renders research notebook section', () => {
    renderWithProviders(<StrategyLab />);
    expect(screen.getByText('RESEARCH NOTEBOOK')).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('read-only research'))).toBeInTheDocument();
  });

  it('renders strategy catalog', () => {
    renderWithProviders(<StrategyLab />);
    expect(screen.getByText('STRATEGY CATALOG')).toBeInTheDocument();
    expect(screen.getByText('ema_crossover.py')).toBeInTheDocument();
    expect(screen.getByText('rsi_meanrev.py')).toBeInTheDocument();
  });

  it('renders backtest research table', () => {
    renderWithProviders(<StrategyLab />);
    expect(screen.getByText('BACKTEST RESEARCH')).toBeInTheDocument();
    const ema = screen.getAllByText('EMA_Crossover');
    expect(ema.length).toBeGreaterThanOrEqual(1);
    const rsi = screen.getAllByText('RSI_MeanReversion');
    expect(rsi.length).toBeGreaterThanOrEqual(1);
  });

  it('renders walk-forward analysis table', () => {
    renderWithProviders(<StrategyLab />);
    expect(screen.getByText('WALK-FORWARD ANALYSIS')).toBeInTheDocument();
    const positiveCells = screen.getAllByText((content) => content.includes('5') && content.includes('/'));
    expect(positiveCells.length).toBeGreaterThanOrEqual(1);
    const windows = screen.getAllByText('7');
    expect(windows.length).toBeGreaterThanOrEqual(1);
  });

  it('shows loading state when data is not ready', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', null, null, true);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    renderWithProviders(<StrategyLab />);
    expect(screen.getByText('Loading backtest data…')).toBeInTheDocument();
  });

  it('shows error state when backtest data fails', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', null, 'Failed to fetch', false);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    renderWithProviders(<StrategyLab />);
    expect(screen.getByText('Backtest data unavailable: Failed to fetch')).toBeInTheDocument();
  });

  it('shows empty state when no backtest data', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', { backtest: {}, walkforward: {} }, null, false);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    renderWithProviders(<StrategyLab />);
    expect(screen.getByText('No backtest data')).toBeInTheDocument();
  });

  it('shows empty state when no strategy files', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', mockBacktestData, null, false);
    mockUseLive('/api/trading/strategies', { strategies: [] }, null, false);
    renderWithProviders(<StrategyLab />);
    expect(screen.getByText('No strategy files found')).toBeInTheDocument();
  });
});
