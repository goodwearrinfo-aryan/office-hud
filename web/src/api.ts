import { useCallback, useEffect, useState } from 'react';

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
  present: boolean;
  godId: string | null;
  agents: Agent[];
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
  staleInProgress: number;
  byStatus: Record<string, number>;
  inProgressTasks: Array<TaskRecord & { heartbeat_age_sec: number | null }>;
  completionsLastHour: number;
  failedLastHour: number;
  completionsByHour: Array<{ hour: string; count: number }>;
  recentCompletions: FleetEvent[];
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
}

export interface DocFile {
  file: string;
  path: string;
}

export interface DocsData {
  docs: DocFile[];
}

// ---- SSE fan-out: one shared stream, many subscribers ----
let es: EventSource | null = null;
const subscribers = new Set<() => void>();
function ensureStream() {
  if (es) return;
  es = new EventSource('/api/stream');
  es.addEventListener('change', () => subscribers.forEach((fn) => fn()));
  es.onerror = () => {
    es?.close();
    es = null;
    setTimeout(ensureStream, 3000); // auto-reconnect
  };
}
function subscribe(fn: () => void) {
  ensureStream();
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function useLive<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetch(path)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((j) => { setData(j); setError(null); })
      .catch((e) => setError(String(e)));
  }, [path]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 20000); // safety-net poll
    const unsub = subscribe(refresh);       // primary: SSE push
    return () => { clearInterval(iv); unsub(); };
  }, [refresh]);

  return { data, error, refresh };
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
