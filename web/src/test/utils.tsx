import { ReactElement, ReactNode } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import { vi } from 'vitest';

vi.mock('../live/store', () => ({
  liveStore: { subscribe: vi.fn(), subscribeStatus: vi.fn(), subscribeViewers: vi.fn() },
  useResource: vi.fn((key: string) => {
    const response = mockUseLiveResponses.get(key);
    if (response) {
      return { data: response.data, error: response.error, loading: response.loading, updatedAt: response.updatedAt, stale: response.stale, refresh: vi.fn() };
    }
    return { data: null, error: null, loading: false, updatedAt: null, stale: false, refresh: vi.fn() };
  }),
  useConnectionStatus: vi.fn(() => ({ state: 'live', since: Date.now() })),
  useViewers: vi.fn(() => []),
  acknowledgeAlert: vi.fn(),
  acknowledgeAllAlerts: vi.fn(),
  LiveStoreProvider: vi.fn(({ children }) => children),
}));

// Test-only stand-in, matching the vi.mock factory above. src/live/store.ts
// exports a LiveStore class but no Provider, so this deliberately lives here
// rather than being imported from production code -- vitest.setup.ts re-exports
// it for consumers that render outside renderWithProviders.
const LiveStoreProvider = ({ children }: { children: ReactNode }) => <>{children}</>;
export { LiveStoreProvider };

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
): RenderResult {
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <LiveStoreProvider>{children}</LiveStoreProvider>
    ),
    ...options,
  });
}

const mockUseLiveResponses = new Map<string, { data: unknown; error: string | null; loading: boolean; updatedAt: number; stale: boolean }>();

const URL_TO_RESOURCE_KEY: Record<string, string> = {
  '/api/trading/backtests': 'tradingBacktests',
  '/api/trading/strategies': 'tradingStrategies',
  '/api/trading/live': 'tradingLive',
  '/api/trading/ops': 'tradingOps',
  '/api/summary': 'summary',
  '/api/queue': 'queue',
  '/api/agents': 'agents',
  '/api/services/health': 'services',
  '/api/harness/health': 'harness',
  '/api/llm/providers': 'providers',
  '/api/llm/circuit-breakers': 'breakers',
  '/api/llm/costs': 'costs',
  '/api/polymarket': 'polymarket',
  '/api/polymarket/status': 'polymarketStatus',
  '/api/polymarket/markets': 'polymarketMarkets',
  '/api/jarvis/tasks': 'jarvisTasks',
  '/api/floors': 'floors',
  '/api/validationEvidence': 'validationEvidence',
  '/api/knowledge/graphify': 'knowledgeStats',
  '/api/knowledge/graphify/communities': 'knowledge',
  '/api/knowledge/docs': 'knowledgeDocs',
  '/api/knowledge/graphify/data': 'knowledgeGraph',
  '/api/office-manager': 'officeManager',
  '/api/trading/alphainsider': 'alphainsiderMultistrat',
  '/api/trading/strategy-monitor': 'strategyMonitor',
  '/api/trading/risk-monitor': 'riskMonitor',
  '/api/trading/market-data': 'marketDataMonitor',
  '/api/trading/alerts': 'alertMonitor',
  '/api/trading/paper-ops': 'paperTradingOps',
  '/api/trading/performance': 'performanceReporter',
};

function getResourceKey(url: string): string {
  return URL_TO_RESOURCE_KEY[url] || url;
}

export function mockUseLive<T>(url: string, data: T | null = null, error: string | null = null, loading = false) {
  const resourceKey = getResourceKey(url);
  mockUseLiveResponses.set(resourceKey, { data, error, loading, updatedAt: Date.now(), stale: false });
};

export function clearMockUseLive() {
  mockUseLiveResponses.clear();
}

export function mockFetch(responses: Map<string, unknown>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const match = Array.from(responses.keys()).find((key) => urlStr.includes(key));
    if (match) {
      const response = responses.get(match);
      return {
        ok: true,
        json: async () => response,
        status: 200,
      } as Response;
    }
    return originalFetch(url);
  });
  return () => { globalThis.fetch = originalFetch; };
}

export function createMockAgent(overrides: Partial<{
  id: string;
  name: string;
  role: string;
  floor: string | null;
  isGod: boolean;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  cwdValid: boolean;
  display: 'busy' | 'idle' | 'stale' | 'breaker' | 'offline';
  archived: boolean;
  breaker: string;
  tokens: number;
  usd: number;
  capUsdPerDay: number | null;
  capUsdPerMonth: number | null;
  sessionUsd: number;
  lastTool: string | null;
  lastActiveSecAgo: number | null;
  inboxBacklog: number;
  onHold: boolean;
  lastSeen: number | null;
  sessionId: string | null;
  sessionStatus: string | null;
  processId: number | null;
  heartbeatAgeSec: number | null;
  sessionFresh: boolean;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
}> = {}) {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    role: 'worker',
    floor: 'f1',
    isGod: false,
    provider: 'freeHarness',
    model: 'qwen/qwen2.5-32b-instruct',
    cwd: '/home/test',
    cwdValid: true,
    display: 'idle',
    archived: false,
    breaker: 'healthy',
    tokens: 0,
    usd: 0,
    capUsdPerDay: null,
    capUsdPerMonth: null,
    sessionUsd: 0,
    lastTool: null,
    lastActiveSecAgo: null,
    inboxBacklog: 0,
    onHold: false,
    lastSeen: Date.now(),
    sessionId: 'sess-1',
    sessionStatus: 'RUNNING',
    processId: 12345,
    heartbeatAgeSec: 10,
    sessionFresh: true,
    currentTaskId: null,
    currentTaskTitle: null,
    evidence: {
      hasSession: true,
      sessionFresh: true,
      hasTask: false,
      taskStatus: null,
      heartbeatAgeSec: 10,
      processId: 12345,
      processLiveness: 'alive' as const,
      processVerified: true,
    },
    ...overrides,
  };
}

export function createMockBacktestData(overrides: Partial<{
  backtest: Record<string, unknown>;
  walkforward: Record<string, unknown>;
}> = {}) {
  return {
    backtest: {
      'EMA_Crossover': {
        avg_test_sharpe: 1.85,
        avg_test_return: 0.234,
        consistency: 0.72,
        avg_win_rate: 0.58,
        avg_profit_factor: 1.45,
        avg_trades: 142,
      },
      'RSI_MeanReversion': {
        avg_test_sharpe: 1.42,
        avg_test_return: 0.156,
        consistency: 0.68,
        avg_win_rate: 0.62,
        avg_profit_factor: 1.31,
        avg_trades: 89,
      },
      ...overrides.backtest,
    },
    walkforward: {
      'EMA_Crossover': {
        avg_is_return: 0.198,
        avg_oos_return: 0.134,
        consistency: 0.71,
        positive_oos_periods: 5,
        total_periods: 7,
        num_windows: 7,
        avg_is_trades: 22,
        avg_oos_trades: 18,
        avg_oos_win_rate: 0.56,
        avg_oos_profit_factor: 1.38,
      },
      ...overrides.walkforward,
    },
  };
}
