import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, mockUseLive, clearMockUseLive } from '../test/utils';
import OpsFloor from '../components/OpsFloor';

const mockServiceHealth = {
  host: 'test-host',
  checkedAt: new Date().toISOString(),
  services: [
    { name: 'Free harness', port: 8080, role: 'OpenAI API', status: 'online', latencyMs: 5, error: null, attempts: 1 },
    { name: 'WebSocket', port: 8081, role: 'event stream', status: 'online', latencyMs: 3, error: null, attempts: 1 },
    { name: 'Bridge', port: 19593, role: 'Anthropic bridge', status: 'offline', latencyMs: 0, error: 'connection refused', attempts: 1 },
  ],
};

const mockPortal = {
  host: 'test-host',
  checkedAt: new Date().toISOString(),
  entryPort: 4747,
  services: [
    { slug: 'dash', port: 3002, label: 'Trading Lab', role: 'dashboards', browser: true, status: 'online', latencyMs: 5, path: '/port/dash/' },
    { slug: 'bot', port: 8765, label: 'Bot API', role: 'paper/testnet', browser: true, status: 'online', latencyMs: 3, path: '/port/bot/' },
  ],
};

const mockHarness = {
  ok: true,
  url: 'http://127.0.0.1:8080/health',
  status: 'ok',
  provider: 'groq',
  model: 'qwen/qwen3.8-27b',
  degradedProviders: [],
  error: null,
  checkedAt: new Date().toISOString(),
};

const mockProviders = {
  providers: ['groq', 'cerebras', 'nvidia'],
  health: { groq: true, cerebras: false, nvidia: true },
};

const mockOps = {
  launchd: {
    available: true,
    error: null,
    services: [
      { label: 'com.aryan.test', loaded: true, running: true, pid: 1234, lastExit: 0, status: 'running', intent: 'keepalive' },
      { label: 'com.aryan.on-demand', loaded: true, running: false, pid: null, lastExit: 0, status: 'idle', intent: 'oneshot' },
      { label: 'com.aryan.failed', loaded: true, running: false, pid: null, lastExit: 1, status: 'failed', intent: 'keepalive' },
    ],
    counts: { running: 1, idle: 1, stopped: 0, failed: 1, total: 3 },
  },
  adherence: { log: 'adherence log', err: 'adherence err' },
  roster: { agents: [{ id: 'agent1' }] },
};

const mockPolymarket = {
  present: true,
  mode: 'paper',
  trades: 42,
  net_pnl: 150.25,
  realized_edge: 0.12,
  updated_at: new Date().toISOString(),
  gate: { status: 'open', priced_exits: 5, requirements_met: true },
  audit: { total: 100, allowed: 85, rejected: 15, reject_reasons: { 'low liquidity': 10, 'high spread': 5 } },
};

const mockPolymarketMarkets = {
  present: true,
  state_path: '/path/to/state',
  updated_at: new Date().toISOString(),
  summary: { trades: 42, open_trades: 5, closed_trades: 37, signals: 100, orders: 50, fills: 45, open_positions: 3, closed_positions: 10, markets: 10 },
  markets: [
    { market_id: '0x123', trades: 10, open_trades: 2, closed_trades: 8, signals: 25, orders: 12, fills: 10, open_positions: 1, closed_positions: 2, order_book: true, last_price: 0.55, last_update: new Date().toISOString(), categories: ['politics'], excluded: false, exclusion: null },
    { market_id: '0x456', trades: 5, open_trades: 1, closed_trades: 4, signals: 15, orders: 8, fills: 7, open_positions: 1, closed_positions: 1, order_book: false, last_price: 0.42, last_update: new Date().toISOString(), categories: ['sports'], excluded: true, exclusion: { market_id: '0x456', reason: 'low liquidity', excluded_at: new Date().toISOString() } },
  ],
  exclusions: { path: '/path/to/exclusions', present: true, valid: true, count: 1, items: [{ market_id: '0x456', reason: 'low liquidity', excluded_at: new Date().toISOString() }], error: null },
};

const mockJarvisTasks = {
  tasks: [
    { task_id: 'jarvis-1', title: '[Jarvis] Test task', objective: 'test', source: 'jarvis', requested_by: 'jarvis', actor: 'office-hud-local', route: 'JEV', routing: { domain: 'polymarket' }, status: 'QUEUED', priority: 'normal', assigned_agent: 'pm-worker', claimed_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null, result: null, risk: 'normal' },
  ],
};

describe('OpsFloor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockUseLive();
    mockUseLive('/api/services/health', mockServiceHealth, null, false);
    mockUseLive('/api/portal', mockPortal, null, false);
    mockUseLive('/api/harness/health', mockHarness, null, false);
    mockUseLive('/api/llm/providers', mockProviders, null, false);
    mockUseLive('/api/trading/ops', mockOps, null, false);
    mockUseLive('/api/polymarket', mockPolymarket, null, false);
    mockUseLive('/api/polymarket/markets', mockPolymarketMarkets, null, false);
    mockUseLive('/api/jarvis/tasks', mockJarvisTasks, null, false);
  });

  it('renders without crashing', () => {
    const { container } = renderWithProviders(<OpsFloor />);
    expect(container).toBeInTheDocument();
  });

  it('shows floor title', () => {
    const { getByText } = renderWithProviders(<OpsFloor />);
    expect(getByText('F9 · 24x7 OPS')).toBeInTheDocument();
  });

  it('shows badges', () => {
    const { getByText } = renderWithProviders(<OpsFloor />);
    expect(getByText('FLEET READ ONLY')).toBeInTheDocument();
    expect(getByText('PAPER TRADING CONTROLS')).toBeInTheDocument();
  });

  it('renders service ports metric cards', () => {
    const { getByText } = renderWithProviders(<OpsFloor />);
    expect(getByText('SERVICE PORTS')).toBeInTheDocument();
    expect(getByText('HARNESS')).toBeInTheDocument();
    expect(getByText('PROVIDERS')).toBeInTheDocument();
    expect(getByText('ADHERENCE')).toBeInTheDocument();
  });

  it('shows online/offline service status', () => {
    const { getByText, getAllByText } = renderWithProviders(<OpsFloor />);
    expect(getByText('Free harness')).toBeInTheDocument();
    expect(getByText('WebSocket')).toBeInTheDocument();
    expect(getByText('Bridge')).toBeInTheDocument();
    const listening = getAllByText('LISTENING');
    expect(listening.length).toBeGreaterThanOrEqual(1);
    expect(getByText('OFFLINE')).toBeInTheDocument();
  });

  it('renders provider health', () => {
    const { getByText, getAllByText } = renderWithProviders(<OpsFloor />);
    expect(getByText('PROVIDER HEALTH')).toBeInTheDocument();
    expect(getByText('groq')).toBeInTheDocument();
    expect(getByText('cerebras')).toBeInTheDocument();
    expect(getByText('nvidia')).toBeInTheDocument();
    const healthy = getAllByText('HEALTHY');
    expect(healthy.length).toBeGreaterThanOrEqual(1);
    expect(getByText('UNHEALTHY')).toBeInTheDocument();
  });

  it('renders Polymarket operations section', () => {
    const { getByText } = renderWithProviders(<OpsFloor />);
    expect(getByText('POLYMARKET OPERATIONS')).toBeInTheDocument();
    expect(getByText('ENGINE PAPER')).toBeInTheDocument();
    expect(getByText('PAPER TRADES')).toBeInTheDocument();
    expect(getByText('42')).toBeInTheDocument();
    expect(getByText('NET P&L')).toBeInTheDocument();
    expect(getByText('$150.25')).toBeInTheDocument();
    expect(getByText('REALIZED EDGE')).toBeInTheDocument();
    expect(getByText('12.0%')).toBeInTheDocument();
  });

  it('renders Polymarket markets table', () => {
    const { getByText, getAllByText } = renderWithProviders(<OpsFloor />);
    expect(getByText('0x123')).toBeInTheDocument(); // short market ID
    const market456 = getAllByText('0x456');
    expect(market456.length).toBeGreaterThanOrEqual(1);
    expect(getByText('EXCLUDED')).toBeInTheDocument();
    expect(getByText('ACTIVE')).toBeInTheDocument();
  });

  it('shows REFRESH and CLEAR PAPER TRADES buttons', () => {
    const { getByText } = renderWithProviders(<OpsFloor />);
    expect(getByText('REFRESH')).toBeInTheDocument();
    expect(getByText('CLEAR PAPER TRADES')).toBeInTheDocument();
  });

  it('renders market exclusions list', () => {
    const { getAllByText } = renderWithProviders(<OpsFloor />);
    expect(getByText('MARKET EXCLUSIONS')).toBeInTheDocument();
    const market456 = getAllByText('0x456');
    expect(market456.length).toBeGreaterThanOrEqual(1);
    expect(getByText('low liquidity')).toBeInTheDocument();
  });

  it('renders Polymarket JEV history', () => {
    const { getByText, getAllByText } = renderWithProviders(<OpsFloor />);
    expect(getByText('POLYMARKET JEV HISTORY')).toBeInTheDocument();
    const task1 = getAllByText('jarvis-1');
    expect(task1.length).toBeGreaterThanOrEqual(1);
  });

  it('renders adherence/runtime section', () => {
    const { getByText } = renderWithProviders(<OpsFloor />);
    expect(getByText('ADHERENCE / RUNTIME')).toBeInTheDocument();
    expect(getByText('Launchd definitions')).toBeInTheDocument();
    expect(getByText('Adherence log')).toBeInTheDocument();
    expect(getByText('PRESENT')).toBeInTheDocument();
    expect(getByText('Roster agents')).toBeInTheDocument();
  });

  it('renders security boundary note', () => {
    const { getByText } = renderWithProviders(<OpsFloor />);
    expect(getByText('SECURITY BOUNDARY')).toBeInTheDocument();
    expect(getByText((content) => content.includes('Credential values and key suffixes'))).toBeInTheDocument();
  });
});