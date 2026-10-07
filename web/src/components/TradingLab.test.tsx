import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
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
    renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(screen.container).toBeInTheDocument();
  });

  it('shows floor title', () => {
    renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(screen.getByText('F6 · TRADING LAB')).toBeInTheDocument();
  });

  it('shows READ ONLY badge', () => {
    renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(screen.getByText('READ ONLY · PAPER / TESTNET')).toBeInTheDocument();
  });

  it('renders metric cards', () => {
    renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(screen.getAllByText('DATABASE')).toHaveLength(1);
    expect(screen.getAllByText('TRADING LOG')).toHaveLength(1);
    expect(screen.getAllByText('STRATEGY FILES')).toHaveLength(2);
  });

  it('renders backtest table with data', () => {
    renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(screen.getByText('BACKTEST RESULTS')).toBeInTheDocument();
    const emaCrossover = screen.getAllByText('EMA_Crossover');
    expect(emaCrossover.length).toBeGreaterThanOrEqual(1);
    const rsi = screen.getAllByText('RSI_MeanReversion');
    expect(rsi.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('1.85')).toBeInTheDocument();
    expect(screen.getByText('23.4%')).toBeInTheDocument();
  });

  it('renders walk-forward table with data', () => {
    renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(screen.getByText('WALK-FORWARD RESULTS')).toBeInTheDocument();
    const positiveCells = screen.getAllByText((content) => content.includes('5') && content.includes('/'));
    expect(positiveCells.length).toBeGreaterThanOrEqual(1);
  });

  it('renders strategy files table', () => {
    renderWithProviders(<TradingLab onNavigate={() => {}} />);
    const strategyFilesHeaders = screen.getAllByText('STRATEGY FILES');
    expect(strategyFilesHeaders.length).toBe(2);
    expect(screen.getByText('ema_crossover.py')).toBeInTheDocument();
    expect(screen.getByText('rsi_meanrev.py')).toBeInTheDocument();
  });

  it('shows loading state when data is not ready', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', null, null, true);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    mockUseLive('/api/trading/live', mockLive, null, false);
    renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(screen.getByText('Loading backtest data…')).toBeInTheDocument();
  });

  it('shows error state when backtest data fails', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', null, 'Failed to fetch', false);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    mockUseLive('/api/trading/live', mockLive, null, false);
    renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(screen.getByText('Backtest data unavailable: Failed to fetch')).toBeInTheDocument();
  });

  it('shows empty state when no backtest data', () => {
    clearMockUseLive();
    mockUseLive('/api/trading/backtests', { backtest: {}, walkforward: {} }, null, false);
    mockUseLive('/api/trading/strategies', mockStrategies, null, false);
    mockUseLive('/api/trading/live', mockLive, null, false);
    renderWithProviders(<TradingLab onNavigate={() => {}} />);
    expect(screen.getByText('No backtest data')).toBeInTheDocument();
  });
});
