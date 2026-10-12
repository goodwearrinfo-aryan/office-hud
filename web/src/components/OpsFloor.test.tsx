import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/dom';
import '@testing-library/jest-dom';
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
    { market_id: '0x123', trades: 10, open_trades: 2, closed_trades: 8, signals: 25, orders: 12, fills: 10, open_positions: 1, closed_positions: 1, order_book: true, last_price: 0.55, last_update: new Date().toISOString(), categories: ['politics'], excluded: false, exclusion: null },
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
    renderWithProviders(<OpsFloor />);
    expect(screen.getByText('F9 · 24x7 OPS')).toBeInTheDocument();
  });

  it('shows badges', () => {
    renderWithProviders(<OpsFloor />);
    expect(screen.getByText('FLEET READ ONLY')).toBeInTheDocument();
    expect(screen.getByText('PAPER TRADING CONTROLS')).toBeInTheDocument();
  });

  it('renders service ports metric cards', () => {
    renderWithProviders(<OpsFloor />);
    // 'SERVICE PORTS' is deliberately rendered twice: as the metric card label
    // (OpsFloor.tsx:283) and as the section heading (OpsFloor.tsx:292). Both
    // are real, so the singular query this test used is what no longer fits.
    const servicePorts = screen.getAllByText('SERVICE PORTS');
    expect(servicePorts.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('HARNESS')).toBeInTheDocument();
    expect(screen.getByText('PROVIDERS')).toBeInTheDocument();
    expect(screen.getByText('ADHERENCE')).toBeInTheDocument();
  });

  it('shows online/offline service status', () => {
    renderWithProviders(<OpsFloor />);
    expect(screen.getByText('Free harness')).toBeInTheDocument();
    expect(screen.getByText('WebSocket')).toBeInTheDocument();
    expect(screen.getByText('Bridge')).toBeInTheDocument();
    const listening = screen.getAllByText('LISTENING');
    expect(listening.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
  });

  it('renders provider health', () => {
    renderWithProviders(<OpsFloor />);
    expect(screen.getByText('PROVIDER HEALTH')).toBeInTheDocument();
    expect(screen.getByText('groq')).toBeInTheDocument();
    expect(screen.getByText('cerebras')).toBeInTheDocument();
    expect(screen.getByText('nvidia')).toBeInTheDocument();
    const healthy = screen.getAllByText('HEALTHY');
    expect(healthy.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('UNHEALTHY')).toBeInTheDocument();
  });

  it('renders Polymarket operations section', () => {
    renderWithProviders(<OpsFloor />);
    expect(screen.getByText('POLYMARKET OPERATIONS')).toBeInTheDocument();
    expect(screen.getByText('ENGINE PAPER')).toBeInTheDocument();
    expect(screen.getByText('PAPER TRADES')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('NET P&L')).toBeInTheDocument();
    expect(screen.getByText('$150.25')).toBeInTheDocument();
    expect(screen.getByText('REALIZED EDGE')).toBeInTheDocument();
    expect(screen.getByText('12.0%')).toBeInTheDocument();
  });

  it('renders Polymarket markets table', () => {
    renderWithProviders(<OpsFloor />);
    expect(screen.getByText('0x123')).toBeInTheDocument();
    const market456 = screen.getAllByText('0x456');
    expect(market456.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('EXCLUDED')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });

  it('shows REFRESH and CLEAR PAPER TRADES buttons', () => {
    renderWithProviders(<OpsFloor />);
    expect(screen.getByText('REFRESH')).toBeInTheDocument();
    expect(screen.getByText('CLEAR PAPER TRADES')).toBeInTheDocument();
  });

  it('renders market exclusions list', () => {
    renderWithProviders(<OpsFloor />);
    expect(screen.getByText('MARKET EXCLUSIONS')).toBeInTheDocument();
    const market456 = screen.getAllByText('0x456');
    expect(market456.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('low liquidity')).toBeInTheDocument();
  });

  it('renders Polymarket JEV history', () => {
    renderWithProviders(<OpsFloor />);
    expect(screen.getByText('POLYMARKET JEV HISTORY')).toBeInTheDocument();
    // OpsFloor.tsx:471-483 renders each history card as status / stamp / title /
    // assigned agent (+ resolved target). task_id is consumed only as the React
    // key on line 472 and is never painted, so the old getAllByText('jarvis-1')
    // could not match any DOM text. Assert on the fields that are rendered.
    expect(screen.getByText('[Jarvis] Test task')).toBeInTheDocument();
    expect(screen.getByText('QUEUED')).toBeInTheDocument();
    expect(screen.getByText('pm-worker')).toBeInTheDocument();
    // The empty state (line 486) must not be showing alongside a real row.
    expect(screen.queryByText('No Polymarket-routed JEV commands yet.')).not.toBeInTheDocument();
  });

  it('renders adherence/runtime section', () => {
    renderWithProviders(<OpsFloor />);
    expect(screen.getByText('ADHERENCE / RUNTIME')).toBeInTheDocument();
    expect(screen.getByText('Launchd definitions')).toBeInTheDocument();
    expect(screen.getByText('Adherence log')).toBeInTheDocument();
    expect(screen.getByText('PRESENT')).toBeInTheDocument();
    expect(screen.getByText('Roster agents')).toBeInTheDocument();
  });

  it('renders security boundary note', () => {
    renderWithProviders(<OpsFloor />);
    expect(screen.getByText('SECURITY BOUNDARY')).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('Credential values and key suffixes'))).toBeInTheDocument();
  });
});
