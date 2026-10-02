import { useCallback, useEffect, useRef, useState } from 'react';

export interface Agent {
  id: string;
  name: string;
  role: string;
  floor: string | null;
  isGod: boolean;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  cwdValid: boolean;
  status: string;
  display: 'busy' | 'idle' | 'breaker' | 'offline';
  archived: boolean;
  breaker: string;
  tokens: number;
  usd: number;
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
}

export interface Summary {
  hive: string;
  label: string;
  present: boolean;
  godId: string | null;
  agents: Agent[];
}

export interface ProcessRecord {
  pid: number;
  name: string;
  kind: string;
  status: string;
  command: string;
  observed_at: string;
}

export interface ProjectRecord {
  project_id: string;
  name?: string;
  status?: string;
  branch?: string;
  health?: string;
  last_seen?: string;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id?: string;
  from?: string;
  to?: string;
  act?: string;
  subject?: string;
  body?: string;
  ts?: number | string;
  _file?: string;
  [k: string]: unknown;
}

export interface FleetEvent {
  type: string;
  agent_id?: string;
  session_id?: string;
  task_id?: string;
  project_id?: string;
  result?: string;
  timestamp?: string;
  [k: string]: unknown;
}

export interface SessionRecord {
  session_id: string;
  agent_id: string;
  process_id: number;
  project_id: string;
  status: string;
  started_at: string;
  last_heartbeat: string;
  current_task_id: string | null;
  updated_at: string;
  heartbeat_age_sec: number | null;
  fresh: boolean;
  /** Machine this session was reported by. The HUD spans several hosts. */
  host: string;
  host_stale: boolean;
}

export interface TaskRecord {
  task_id: string;
  title: string;
  objective?: string;
  status: string;
  assigned_agent?: string | null;
  claimed_by?: string | null;
  heartbeat?: string | null;
  result?: string;
  [k: string]: unknown;
}

export interface QueueSummary {
  total: number;
  queued: number;
  inProgress: number;
  complete: number;
  failed: number;
  quarantined?: number;
  blocked?: number;
  blockedTasks?: Array<{
    task_id: string;
    title: string;
    assigned_agent: string | null;
    waiting_on: string[] | null;
    reason: string | null;
    blocked_at: string | null;
  }>;
  staleInProgress: number;
  byStatus: Record<string, number>;
  inProgressTasks: Array<TaskRecord & { heartbeat_age_sec: number | null }>;
  completionsLastHour: number;
  failedLastHour: number;
  completionsByHour: Array<{ hour: string; count: number }>;
  recentCompletions: FleetEvent[];
}

export interface AlphaInsiderStrategy {
  id: string;
  name: string;
  type: string;
  status: string;
  source: string;
  note: string;
}

export interface AlphaInsiderPosition {
  symbol: string;
  side: string;
  quantity: string;
  entry: string;
  mark: string;
  pnl: string;
  pnlPercent: string;
}

export interface AlphaInsiderSnapshot {
  verified: boolean;
  holder: string;
  scopes: string[];
  lastSync: string;
  strategies: AlphaInsiderStrategy[];
  positions: AlphaInsiderPosition[];
  error?: string;
}

export interface AlphaInsiderStatus {
  verified: boolean;
  scopes?: string[];
  holder?: string;
}

export interface JarvisRouting {
  domain: string;
  prompt_matched?: boolean;
  target_matched?: boolean;
  requested_target?: string | null;
  resolved_target?: string | null;
  selector?: string;
}

export interface JarvisTask {
  task_id: string;
  title: string;
  objective: string;
  source: string | null;
  requested_by: string | null;
  actor: string;
  route: string | null;
  routing: JarvisRouting | null;
  status: string;
  priority: string;
  assigned_agent: string | null;
  claimed_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  result: string | null;
  risk: string;
}

export interface JarvisAuditEvent {
  task_id: string | null;
  actor: string;
  target: string | null;
  requested_target: string | null;
  routing: JarvisRouting | null;
  priority: string | null;
  risk: string;
  prompt_length: number;
  prompt_hash: string | null;
  timestamp: string | null;
}

export interface JarvisAuditResponse {
  events: JarvisAuditEvent[];
}

export interface JarvisTasksResponse {
  tasks: JarvisTask[];
}

export interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  ok?: boolean;
  error?: ApiErrorBody | string;
  message?: string;
}

export interface PolymarketGate {
  status: string | null;
  priced_exits: number | null;
  requirements_met: boolean | null;
}

export interface PolymarketAudit {
  total: number;
  allowed: number;
  rejected: number;
  reject_reasons: Record<string, number>;
}

export interface PolymarketState {
  present: boolean;
  mode: string;
  trades: number;
  net_pnl: number | null;
  realized_edge: number | null;
  updated_at: string | null;
  gate: PolymarketGate | null;
  audit: PolymarketAudit;
}

export interface PolymarketExclusion {
  market_id: string;
  reason: string;
  excluded_at: string;
}

export interface PolymarketExclusionFile {
  path: string;
  present: boolean;
  valid: boolean;
  count: number | null;
  items: PolymarketExclusion[];
  error: string | null;
}

export interface PolymarketExclusionSet {
  path: string;
  count: number;
  items: PolymarketExclusion[];
}

export interface PolymarketMarket {
  market_id: string;
  trades: number;
  open_trades: number;
  closed_trades: number;
  signals: number;
  orders: number;
  fills: number;
  open_positions: number;
  closed_positions: number;
  order_book: boolean;
  last_price: number | null;
  last_update: string | null;
  categories: string[];
  excluded: boolean | null;
  exclusion: PolymarketExclusion | null;
}

export interface PolymarketPortfolio {
  cash: number | null;
  starting_cash: number | null;
  daily_pnl: number | null;
  current_drawdown: number | null;
}

export interface PolymarketMarketSummary {
  trades: number;
  open_trades?: number;
  closed_trades?: number;
  trade_sides?: Record<string, number>;
  signals: number;
  signal_decisions?: Record<string, number>;
  orders: number;
  order_statuses?: Record<string, number>;
  fills: number;
  open_positions: number;
  closed_positions: number;
  markets: number;
  performance_metrics?: Record<string, unknown>;
  portfolio?: PolymarketPortfolio;
}

export interface PolymarketMarketsResponse {
  present: boolean;
  state_path: string;
  updated_at: string | null;
  summary: PolymarketMarketSummary;
  markets: PolymarketMarket[];
  exclusions: PolymarketExclusionFile;
}

export interface PolymarketExclusionResponse {
  ok: boolean;
  action: string;
  changed: boolean;
  market_id: string;
  exclusion: PolymarketExclusion | null;
  exclusions: PolymarketExclusionSet;
}

export interface PolymarketClearCount {
  before: number;
  after: number;
}

export interface PolymarketClearResponse {
  ok: boolean;
  scope: string;
  backup_path: string;
  cleared: Record<string, PolymarketClearCount>;
  preserved: {
    root_keys: string[];
    execution_engine_keys: string[];
    signal_history_count: number;
    performance_metrics_preserved: boolean;
    order_books_preserved: number;
    price_history_preserved: number;
    audit_log_preserved: number;
  };
}

export interface OfficeManagerStatus {
  registered: boolean;
  running: boolean;
  status: string;
  currentTask: string | null;
  lastActivity: string | null;
  session: SessionRecord | null;
  lastLogLine: string | null;
  queue: QueueSummary;
}

export interface HarnessHealth {
  ok: boolean;
  url: string;
  status: string;
  provider: string;
  model: string;
  error: string | null;
  checkedAt: string;
}

export interface ServicePort {
  name: string;
  port: number;
  role: string;
  status: 'online' | 'offline';
  latencyMs: number;
  error: string | null;
}

export interface ServiceHealth {
  host: string;
  checkedAt: string;
  services: ServicePort[];
}

export interface PortalService {
  slug: string;
  port: number;
  label: string;
  role: string;
  browser: boolean;
  status: 'online' | 'offline' | 'unknown';
  latencyMs: number | null;
  path: string;
}

export interface PortalResponse {
  host: string;
  checkedAt: string;
  entryPort: number;
  services: PortalService[];
}

export interface VerifyState {
  present: boolean;
  at?: string;
  verdict_tally?: { OK?: number; DODGE?: number; SHORT?: number; FAIL?: number; EMPTY?: number };
  requeued?: Array<[string, string]>;
  quarantined?: Array<[string, string]>;
  realWorkRatePct?: number | null;
}

export interface AgentDetail {
  agent: Agent;
  identity: string | null;
  memory: string | null;
  inbox: Message[];
  outbox: Message[];
  sessions: SessionRecord[];
  currentTasks: TaskRecord[];
  recentEvents: FleetEvent[];
}

export interface LedgerEvent {
  ts?: number;
  kind?: string;
  [k: string]: unknown;
}

export interface BacktestWindow {
  train_start: string;
  train_end: string;
  test_start: string;
  test_end: string;
  best_params: Record<string, any>;
  train_sharpe: number;
  test_sharpe: number;
  test_return: number;
  test_max_dd: number;
  test_win_rate: number;
  test_profit_factor: number;
  test_trades: number;
}

export interface StrategyBacktest {
  windows: BacktestWindow[];
  avg_test_sharpe: number;
  avg_test_return: number;
  consistency: number;
  avg_win_rate: number;
  avg_profit_factor: number;
  avg_trades?: number;
}

export interface WalkForwardResult {
  strategy: string;
  num_windows: number;
  avg_is_return: number;
  avg_oos_return: number;
  is_return_std: number;
  oos_return_std: number;
  consistency: number;
  positive_oos_periods: number;
  total_periods: number;
  is_oos_correlation: number;
  avg_is_trades: number;
  avg_oos_trades: number;
  avg_is_win_rate: number;
  avg_oos_win_rate: number;
  avg_oos_profit_factor: number;
  param_stability: Record<string, any>;
  window_details: any[];
}

export interface BacktestData {
  backtest: Record<string, StrategyBacktest>;
  walkforward: Record<string, WalkForwardResult>;
}

export interface TradingConfig {
  exchange?: any;
  logging?: any;
  [k: string]: any;
}

export interface StrategyFile {
  file: string;
  path: string;
}

export interface LiveMetrics {
  dbExists: boolean;
  logExists: boolean;
  logSize: number;
}

export interface LaunchdService {
  file: string;
  path: string;
}

export interface LaunchdStatus {
  services: LaunchdService[];
}

// Live launchd state, read from `launchctl list`. `idle` is a one-shot job that
// finished cleanly. `stopped` exited non-zero but nothing is restarting it —
// usually a job deliberately reporting a condition (a quota guard, a failed
// self-check) rather than a crash. `failed` is a KeepAlive job that is down,
// which is never normal because launchd would keep trying.
export type LaunchdServiceStatus = 'running' | 'idle' | 'stopped' | 'failed';

export interface FleetLaunchdEntry {
  label: string;
  loaded: boolean;
  running: boolean;
  pid: number | null;
  lastExit: number;
  status: LaunchdServiceStatus;
  intent: 'keepalive' | 'interval' | 'oneshot';
}

export interface FleetLaunchdState {
  available: boolean;
  error: string | null;
  services: FleetLaunchdEntry[];
  counts: { running: number; idle: number; stopped: number; failed: number; total: number };
}

export interface AdherenceLogs {
  log: string | null;
  err: string | null;
}

export interface RosterAgent {
  id: string;
  name: string;
  character: string;
  accent: string;
  description: string;
  project: string;
  tmuxTarget: string;
  cwd: string;
  status: string;
  action: string;
  progress: number;
  currentStation: string;
  ptyId: string;
  command: string;
  provider: string;
  model: string;
  isGod: boolean;
  carrying: string;
}

export interface RosterData {
  version: number;
  savedAt: string;
  agents: RosterAgent[];
  archived: any[];
  restorable: any[];
  queues: any;
  selectedId: string;
}

export interface GraphifyStats {
  exists: boolean;
  files?: string[];
  count?: number;
}

export interface GraphifyCommunities {
  exists: boolean;
  nodes: number;
  links: number;
  built_at_commit?: string | null;
  communities: Array<{ label: string; count: number }>;
}

export interface GraphNode {
  id: string;
  label: string;
  file_type?: string;
  source_file?: string;
  source_location?: string;
  metadata?: Record<string, any>;
  _origin?: string;
  community?: number;
  norm_label?: string;
  community_name?: string;
  [k: string]: any;
}

export interface GraphLink {
  source: string;
  target: string;
  [k: string]: any;
}

export interface GraphifyGraph {
  directed: boolean;
  multigraph: boolean;
  graph: Record<string, any>;
  nodes: GraphNode[];
  links: GraphLink[];
  built_at_commit?: string;
}

export interface DocFile {
  file: string;
  path: string;
}

export interface DocsData {
  docs: DocFile[];
}

// ---- live data layer ----
// Thin adapter over the socket-backed store (see live/store.ts). Paths that the
// server exposes as a named resource are delivered by push; anything else falls
// back to a plain fetch on an interval. The old "SSE says change, everyone
// refetches" behaviour is gone.

import {
  liveStore,
  useResource,
  useConnectionStatus,
  useViewers,
  acknowledgeAlert,
  acknowledgeAllAlerts,
  type Alert,
  type AlertSummary,
  type ResolvedAlert,
  type AutonomyState,
  type AutonomyPolicy,
  type AutonomyProposal,
  type AutonomyAuditEntry,
  type CapacityAssessment,
  type LiveStatus,
  type ConnectionStatus,
  type Viewer,
} from './live/store';

export {
  liveStore,
  useResource,
  useConnectionStatus,
  useViewers,
  acknowledgeAlert,
  acknowledgeAllAlerts,
};
export type {
  Alert, AlertSummary, ResolvedAlert, LiveStatus, ConnectionStatus, Viewer,
  AutonomyState, AutonomyPolicy, AutonomyProposal, AutonomyAuditEntry, CapacityAssessment,
};

/** Panel path -> resource name, for the endpoints the server pushes. */
const RESOURCE_BY_PATH: Record<string, string> = {
  '/api/summary': 'summary',
  '/api/agents': 'agents',
  '/api/queue': 'queue',
  '/api/projects': 'projects',
  '/api/tasks?counts=1': 'taskCounts',
  '/api/task-board': 'taskBoard',
  '/api/autonomy': 'autonomy',
  '/api/live/status': 'streamStatus',
  '/api/sessions': 'sessions',
  '/api/processes': 'processes',
  '/api/verify': 'verify',
  '/api/office-manager': 'officeManager',
  '/api/validationEvidence': 'validationEvidence',
  '/api/jev/stats': 'jevStats',
  '/api/services/health': 'services',
  '/api/harness/health': 'harness',
  '/api/llm/providers': 'providers',
  '/api/llm/circuit-breakers': 'breakers',
  '/api/llm/costs': 'costs',
  '/api/events': 'events',
  '/api/knowledge/graphify/communities': 'knowledge',
  '/api/knowledge/graphify': 'knowledgeStats',
  '/api/knowledge/graphify/data': 'knowledgeGraph',
  '/api/knowledge/docs': 'knowledgeDocs',
  '/api/jarvis/tasks': 'jarvisTasks',
  '/api/trading/backtests': 'tradingBacktests',
  '/api/trading/strategies': 'tradingStrategies',
  '/api/trading/ops': 'tradingOps',
  '/api/trading/live': 'tradingLive',
  '/api/polymarket': 'polymarket',
  '/api/polymarket/status': 'polymarketStatus',
  '/api/polymarket/markets': 'polymarketMarkets',
};

const POLL_ONLY_MS = 20000;

/** Fallback for endpoints the socket does not carry. */
function usePolled<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    // An empty path means the caller is served by the socket instead. Hooks
    // cannot be conditional, so useLive points the unused poller at ''. That
    // must be inert: fetch('') resolves against the document base URL and
    // fetches the SPA shell, which then fails response.json().
    if (!path) return;
    fetch(path, { headers: { Accept: 'application/json' } })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<T>;
      })
      .then((json) => { if (alive.current) { setData(json); setError(null); } })
      .catch((e: unknown) => { if (alive.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive.current) setLoading(false); });
  }, [path]);

  useEffect(() => {
    alive.current = true;
    if (!path) {
      setData(null);
      setError(null);
      setLoading(false);
      return () => { alive.current = false; };
    }
    setLoading(true);
    refresh();
    const timer = setInterval(refresh, POLL_ONLY_MS);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh, path]);

  return { data, error, loading, refresh };
}

/**
 * Map a panel path onto a pushed resource, if the server carries one.
 * Template paths (`/api/agents/<id>`) become parameterized resource keys.
 */
export function resourceKeyForPath(path: string): string | null {
  const direct = RESOURCE_BY_PATH[path];
  if (direct) return direct;

  const agent = /^\/api\/agents\/([^/?]+)/.exec(path);
  if (agent) return `agents/${agent[1]}`;

  const ledger = /^\/api\/ledger\?/.test(path);
  if (ledger) {
    const source = /[?&]source=([^&]+)/.exec(path)?.[1];
    return `ledger/${source === 'log' ? 'log' : 'events'}`;
  }
  return null;
}

export function useLive<T>(path: string) {
  const resource = resourceKeyForPath(path);
  // Hooks cannot be conditional, so both are always called; the unused one is
  // pointed at an empty path and does nothing. A non-resource path must not
  // create a phantom store subscription, which is why the key is null here.
  const pushed = useResource<T | null>(resource ?? '');
  const polled = usePolled<T>(resource ? '' : path);
  return resource ? pushed : polled;
}

export function relTime(ts?: number | null): string {
  if (!ts) return '—';
  const diff = Date.now() - (ts > 1e12 ? ts : ts * 1000);
  if (diff < 0) return 'now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function shortTime(ts?: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Floor default model/provider config
export const FLOOR_DEFAULTS: Record<string, { model: string; provider: string }> = {
  F1: { model: 'qwen/qwen2.5-32b-instruct', provider: 'freeHarness' },
  F2: { model: 'qwen/qwen2.5-32b-instruct', provider: 'freeHarness' },
  F3: { model: 'qwen/qwen2.5-32b-instruct', provider: 'freeHarness' },
  F4: { model: 'qwen/qwen2.5-32b-instruct', provider: 'freeHarness' },
  F5: { model: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia' },
  F6: { model: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia' },
  F7: { model: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia' },
  F8: { model: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia' },
  F9: { model: 'qwen/qwen2.5-32b-instruct', provider: 'freeHarness' },
  F10: { model: 'qwen/qwen2.5-32b-instruct', provider: 'freeHarness' },
  F11: { model: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia' },
  F12: { model: 'qwen/qwen2.5-32b-instruct', provider: 'freeHarness' },
  god: { model: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia' },
  'office-manager': { model: 'qwen/qwen2.5-32b-instruct', provider: 'freeHarness' },
  mainbot: { model: 'qwen/qwen2.5-32b-instruct', provider: 'freeHarness' },
};

export function getFloorDefault(floor: string): { model: string; provider: string } | undefined {
  return FLOOR_DEFAULTS[floor];
}
