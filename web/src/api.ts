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
  /**
   * `stale` is a real state the server emits and this type used to deny:
   * index.js derives it for an agent that HAS a session which is no longer
   * fresh (`else if (session) display = 'stale'`), ranks it between idle and
   * breaker, and counts it separately in the floor rollup. Omitting it here
   * made a stale employee unrepresentable, so every panel that switched on
   * `display` silently folded it into `offline` -- a session-backed agent
   * rendered identically to one that was never seen.
   *
   * Ordered as the server orders them: busy, idle, stale, breaker, offline.
   */
  display: 'busy' | 'idle' | 'stale' | 'breaker' | 'offline';
  archived: boolean;
  breaker: string;
  tokens: number;
  usd: number;
  /**
   * The agent's spending caps, read from `cost_limit_usd_per_day` /
   * `cost_limit_usd_per_month` -- the exact fields hive/lib/llm/client.ts builds its
   * cap from on every LLM request.
   *
   * Declared because the server sends them and this interface did not, which
   * webContract.test.js reports as "Agent omits fields the server sends". It only
   * fails where a hive is real: with an empty local hive the contract check skips, so
   * the gap would have merged on the laptop and surfaced on the mini. That is the F10
   * finding on the type side.
   *
   * Null means no cap is set for that agent, which is the measured state of all 66
   * agents in registry.json -- and is not the same claim as a cap of zero.
   */
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
  /**
   * Which host owns this agent's process, and whether that host's report is
   * fresh. A local agent reports the HUD's own host with host_stale=false; a
   * remote agent names the machine it actually runs on. This is what separates
   * "alive here" from "alive there" -- a PID alone cannot, because the HUD
   * cannot verify a process it does not own.
   */
  host?: string | null;
  host_stale?: boolean;
  /**
   * What backs the status/display labels above, so a panel can show its
   * reasoning instead of asking the reader to trust a colour.
   *
   * This was missing from the canonical type even though the server has emitted
   * it on every agent since it was added. GodPanel worked around that by
   * declaring a private duplicate of the whole agent shape, which is how the
   * canonical type stayed wrong while the component that needed the field
   * type-checked fine.
   *
   * `processLiveness` keeps three states apart on purpose: a live process, a dead
   * one, and no pid reported at all are different facts, and collapsing them
   * into one "unverified" reads as a problem when nothing is wrong.
   */
  evidence: {
    hasSession: boolean;
    sessionFresh: boolean;
    hasTask: boolean;
    taskStatus: string | null;
    heartbeatAgeSec: number | null;
    processId: number | null;
    // 'remote-verified' means the agent's OWNING host checked the PID directly
    // (os.kill on that machine), which is the only trusted reading for a process
    // that does not run here. 'remote-unverified' is a remote report the local
    // HUD cannot corroborate -- reported as such rather than as alive or dead.
    processLiveness: 'alive' | 'dead' | 'no-pid' | 'remote-verified' | 'remote-unverified' | null;
    processVerified: boolean;
    // Which host owns the session, when it is not this one. Null for a local
    // agent. Lets the UI say "alive on the mini" instead of guessing from a PID.
    remoteHost?: string | null;
  };
}

/**
 * Probe-grade floor state from GET /api/floors.
 *
 * Distinct from `Summary.floors`, which rolls the agent roster up by floor and
 * answers "who is on f3". This answers "is f3's manager alive and is its status
 * file fresh", which the roster cannot know. Neither replaces the other.
 */
export interface FloorsPayload {
  floors: Array<{
    floor: string;
    manager: string;
    state: string;
    reason: string | null;
    manager_alive: boolean;
    task_counts: Record<string, number>;
    current_task?: string | null;
    last_activity?: string | null;
  }>;
  /** Same read as `floors`, so a badge can never contradict the row beside it. */
  counts: Record<string, {
    state: string;
    manager_alive: boolean;
    reason: string | null;
    current_task: string | null;
    last_activity: string | null;
    tasks: Record<string, number>;
    workers: number;
    failed_workers: number;
    stalled: number;
    degraded: boolean;
  }>;
  summary: Record<string, number>;
  /** 'unavailable' when the hive has no probe, 'error' when it failed. */
  source: string;
  /**
   * True when the probe could not be consulted. Every floor is then UNKNOWN and
   * this flag must be surfaced: twelve grey rows read as measurements unless the
   * caller says they are not.
   */
  not_verified: boolean;
  at: number;
}

/**
 * GET /api/terminals -- what every machine in the hive is running.
 *
 * Declared here because the fleet floor renders it and no exported type covered
 * it. Three details are load-bearing and were read off the live payload rather
 * than assumed:
 *
 *  - `stale` is per HOST, not per row. A host that has gone quiet is still
 *    listed, with its rows, flagged -- it is never dropped. Absence of a host
 *    would read as "this machine does not exist", which is a different claim.
 *  - `age_sec` is how long since that host was collected. On the mini it was 34
 *    seconds; on the laptop it was 56244 -- fifteen and a half hours. A stale
 *    host's rows are a record of the past, not a measurement of now.
 *  - identity and health are NULLABLE per row. The laptop's 33 rows carry
 *    process_id, project_id and health all null, because the collector that
 *    supplies them has not reported. So a row with a null process_id is NOT
 *    REPORTED, not an unnamed healthy process.
 */
export interface HostProcessRow {
  process_id: string | null;
  project_id: string | null;
  command?: string;
  status?: string | null;
  health?: string | null;
  pid?: number | null;
  started_at?: string | null;
  last_seen?: string | null;
  restart_count?: number | null;
}

export interface TerminalHost {
  host: string;
  /** True for the machine serving this HUD, so a reader can orient themselves. */
  local: boolean;
  collected_at: string;
  age_sec: number;
  /** The host has gone quiet. Its rows describe the past, not now. */
  stale: boolean;
  processes: HostProcessRow[];
}

/**
 * Whether the HUD can start a terminal on the machine serving it.
 *
 * Reported because the alternative is invisible. The policy file travels with the
 * hive, so its `cwdPrefixes` are absolute paths on whichever machine wrote them,
 * and a policy synced to a machine it does not describe refuses every spawn while
 * looking identical to "spawning is disabled". The audit is read-only and loosens
 * nothing.
 */
export interface SpawnPolicyAudit {
  source: string;
  policy_path: string;
  policy_file_present: boolean;
  readable?: boolean;
  error?: string | null;
  this_machine: string;
  home: string;
  permitted_trees: string[];
  missing_trees: string[];
  /** Trees that exist but sit outside this machine's home: legal, and named apart. */
  foreign_trees?: string[];
  /** The only field a UI should branch on. */
  effect: 'permitted' | 'partial' | 'none_permitted' | 'no_policy_file' | 'unreadable_policy';
  summary: string;
}

export interface TerminalsPayload {
  hosts: TerminalHost[];
  /** Hosts currently flagged stale, by name. */
  stale_hosts: string[];
  terminals: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  spawn_policy?: SpawnPolicyAudit;
}

/**
 * GET /api/trading/ops -- the jobs this machine runs under launchd.
 *
 * `available: false` means the listing could not be read, which is different
 * from "no jobs are loaded". The fleet floor has to say which of the two it is,
 * because the first is a gap in what we can see and the second is a fact about
 * the machine.
 */
export interface TradingOpsPayload {
  launchdState?: {
    available: boolean;
    counts?: Record<string, number>;
    error?: string | null;
    services?: FleetLaunchdEntry[];
  };
  [k: string]: unknown;
}

export interface Summary {
  hive: string;
  label: string;
  present: boolean;
  godId: string | null;
  agents: Agent[];
  /**
   * `floors` is emitted as an empty array on this deployment, which is the
   * truthful shape of "no floor rollup was produced".
   *
   * Typed as a `FloorRollup[]` covering every member FloorTable's own
   * `FloorRow` declares, so the `Summary & { floors?: FloorRow[] }` intersection
   * it uses resolves to a readable type. Leaving it undeclared did NOT fail:
   * an intersection with an absent optional property silently collapses to
   * `never[]`, so `floors.length === 0` type-checked and the panel rendered its
   * empty state forever with no error to explain why. It is now genuinely empty
   * on this deployment, so the panel honestly says so rather than pretending
   * the field is missing.
   */
  floors?: Array<{
    floor: string;
    lead: string | null;
    leadIsLive: boolean;
    agents: number;
    running: number;
    working: number;
    idle: number;
    stale: number;
    failed: number;
    offline: number;
    breaker: number;
    health: string;
  }>;
  /** A second copy of the agent list with the time it was collected. */
  fleet?: { ts?: number; agents?: Agent[] };
}

/**
 * A process row from /api/processes, as collected into the hive's processes.json.
 *
 * This shape previously declared `pid`, `name`, `kind` and `observed_at`, none
 * of which the server ever sent. It type-checked cleanly, so a consumer reading
 * `process.pid` would render `undefined` with no error anywhere — a declared
 * field that does not exist is worse than an absent one, because it reads as a
 * guarantee.
 *
 * `pid` and `process_id` are both optional because the collectors disagree: rows
 * sourced from the hive carry `pid`, engine probes carry only `process_id`.
 * `command` arrives already redacted server-side.
 */
export interface ProcessRecord {
  status?: string;
  /**
   * What the observation concluded, and what was actually written down. These
   * are not the same value and the difference is the point: a process recorded
   * RUNNING whose last observation is hours old reports status STALE while
   * stored_status stays RUNNING. The live hive shows exactly that pair
   * ('RUNNING' / 'STALE'), so a view that renders only `status` is claiming
   * more liveness than it measured. Both fields come from processTruth.js and
   * neither was declared here, so nothing could render the distinction.
   */
  stored_status?: string | null;
  /** Age of the observation `status` was derived from; null when unknown. */
  observation_age_seconds?: number | null;
  command?: string;
  pid?: number;
  process_id?: string;
  project_id?: string;
  started_at?: string;
  last_seen?: string;
  health?: string;
  restart_count?: number;
}

/**
 * A project row from /api/projects.
 *
 * `branch`, `health`, `last_seen` and `metadata` were declared here and are
 * never emitted by projects.json, so they resolved to undefined at runtime while
 * type-checking cleanly. Replaced with the fields that are actually sent, plus
 * the timestamps the collector records.
 */
export interface ProjectRecord {
  project_id: string;
  name?: string;
  status?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
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
  /**
   * COMPLETE is a status the executor writes, so it is a claim rather than
   * proof. `verifiedComplete` is the subset carrying durable recorded output and
   * `unverifiedComplete` is the residue; they and `completedButFailed` partition
   * `complete`. None of these are inferred from the absence of a failure marker.
   */
  completedButFailed?: number;
  verifiedComplete?: number;
  unverifiedComplete?: number;
  blocked?: number;
  /**
   * A task parked on an unmet dependency.
   *
   * `blocked_since` is what the server actually sends. This shape previously
   * declared `waiting_on` and `blocked_at`, which the server has never emitted —
   * so both resolved to undefined at runtime while type-checking cleanly, which
   * is worse than not having declared them. `reason` is derived server-side and
   * is honest about its own limits: when the record carries no cause it says
   * "blocked with no reason recorded" rather than inventing one.
   */
  blockedTasks?: Array<{
    task_id: string;
    title: string;
    assigned_agent: string | null;
    reason: string;
    blocked_since: string | null;
  }>;
  staleInProgress: number;
  byStatus: Record<string, number>;
  inProgressTasks: Array<TaskRecord & { heartbeat_age_sec: number | null }>;
  completionsLastHour: number;
  /**
   * True when the count is a floor rather than the rate: the log exceeded the
   * window that was read, so older completions exist that this cannot see.
   */
  completionsLastHourLowerBound?: boolean;
  /** Bytes of events.log the rate and the chart were computed from. */
  completionsWindowBytes?: number | null;
  /** Why the throughput read failed, if it did. Null means it succeeded. */
  completionsError?: string | null;
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
  /**
   * The read outcome, added alongside the events so an empty list can be told
   * apart from a log that was never read.
   *
   * Measured off the live mini: `status: "ok"` with `count: 0`, `scanned: 375`, and
   * a window that read 524288 of 15755023 bytes with `truncated: true`. Those fields
   * were on the wire while the web type still declared only `events`, which is the
   * type-side version of the F10 finding: the payload grew and the interface did
   * not, so nothing in the build could have complained. A console reading `events`
   * alone would have rendered "0 commands" from a partially-read log and had no
   * field available to stop it.
   */
  ok?: boolean;
  status?: 'ok' | 'unreadable' | 'unparsed' | string | null;
  error?: string | null;
  /** Events returned, after the limit. Not the number searched for. */
  count?: number;
  limit?: number;
  /** Events parsed out of the window, before filtering to commands. */
  scanned?: number;
  source?: string | null;
  /** False when the log is larger than any window this route reads. */
  reachable_window?: boolean;
  window?: {
    source_bytes?: number;
    read_bytes?: number;
    limit_bytes?: number;
    truncated?: boolean;
    unparsed_lines?: number;
  } | null;
  checkedAt?: string | null;
}

export interface JarvisTasksResponse {
  tasks: JarvisTask[];
}

/**
 * The server's answer to "what would this command do?", from POST
 * /api/jarvis/preview. It writes nothing.
 *
 * The point of asking rather than deriving: the browser used to keep its own
 * narrower copy of the danger rule and guess the risk tier from it. The two
 * disagreed often enough that the console would show a command as OPS TASK and
 * the server would then refuse it with 428. `risk` and `requires_type_confirmation`
 * come from the same function the write path uses, so they cannot be wrong here
 * and right there.
 *
 * `dispatch.available` is false whenever the request did not arrive on the HUD
 * host's own loopback interface -- which is the normal state when the HUD is
 * being read from a laptop over a tunnel. It is reported rather than discovered
 * by pressing the button, because the alternative is a control that looks live
 * and answers 403.
 */
export interface JarvisPreview {
  ok: boolean;
  reason: string | null;
  field_status: number | null;
  prompt: string | null;
  priority: string | null;
  target: string | null;
  risk: 'destructive' | 'normal' | null;
  requires_type_confirmation: boolean | null;
  assigned_agent: string | null;
  routing: JarvisRouting | null;
  would_accept: boolean;
  /** Why it would not be queued: fields, queue_unavailable, not_local, confirmation. */
  blocked_by: 'fields' | 'queue_unavailable' | 'not_local' | 'confirmation' | null;
  blocked_reason: string | null;
  dispatch: {
    available: boolean;
    host: string;
    requirement: string;
  };
  queue_available: boolean;
}

export interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
}

/**
 * Runtime status of the managed Polymarket engine, from /api/polymarket/status.
 *
 * This payload had no TypeScript type at all, so it was fetched as an untyped
 * blob. Every field below is required because the server builds them from a
 * single object literal with no conditional spread — all thirteen are present on
 * every response, whether or not the engine is installed. Optionality would be a
 * lie here in the other direction: it would let a consumer treat "the engine is
 * not installed" as "the server did not tell me".
 *
 * Nullability is not optionality. `paper_only`, `managed`, `running` and
 * `execution_allowed` are required booleans, never null: the server derives them
 * from `plistValid && !configResult.error && ...`, which always yields a boolean.
 * A consumer gating on them is gating on a fact, not on missing data.
 *
 * The three error/identity fields that CAN be null are typed `| null` because the
 * server genuinely sends null: a missing launchd service has no pid and no path,
 * and an unreadable config reports `error: null` rather than omitting itself.
 *
 * `paper_only` and `execution_allowed` are the paper/testnet boundary. The server
 * requires paper_only before it will start anything
 * (`POST /api/polymarket/start` returns paper_only_required otherwise) and
 * execution_allowed is only true when the plist, config and loaded state all
 * hold. Both are typed as plain required booleans so that fact cannot be lost in
 * an optional chain.
 */
export interface PolymarketStatus {
  /** ISO timestamp of the probe. */
  checked_at: string;
  /** Absolute path the server expects the engine script at. */
  engine_path: string;
  /** Same path, reported separately so a mismatch is visible rather than inferred. */
  expected_engine_path: string;
  /** The plist the server expects to be loaded from. */
  expected_plist_path: string;
  /**
   * True only when the plist is valid, carries `--paper`, has no unsafe
   * (--live/--real/--mainnet/--testnet) argument, and the config agrees.
   */
  paper_only: boolean;
  /** The engine has a valid plist and a readable config. */
  managed: boolean;
  /** A process matching the engine path was found. */
  running: boolean;
  /** PID of the first matching process, or null when not running. */
  pid: number | null;
  /** Every matching pid and its command line. Empty when not running. */
  process: {
    pids: number[];
    commands: (string | null)[];
  };
  /** What launchctl reports for the managed label, plus what was expected. */
  launchd: {
    loaded: boolean;
    state: string;
    pid: number | null;
    path: string | null;
    error: string | null;
    expected_path: string;
    expected_loaded: boolean;
  };
  /** polymarket_config.json as read, if any. */
  config: {
    present: boolean;
    path: string;
    error: string | null;
  };
  /** The installed plist, validated against the expected shape. */
  plist: {
    valid: boolean;
    error: string | null;
    path: string;
  };
  /**
   * True only when paper-only is satisfied AND the expected plist is loaded.
   * False here means no live order path is authorised.
   */
  execution_allowed: boolean;
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

/**
 * The market-exclusion list and whether it could be read at all.
 *
 * `present`, `valid` and `error` were missing here while the server sends all
 * three, and `count` is null whenever `valid` is false. That combination is the
 * hazard: the type said `count: number` (always a number) and said nothing about
 * validity, so a consumer could render a count while the file behind it was
 * unreadable or malformed. `count` is nullable precisely because "no count" is
 * a distinct, reportable state rather than a zero.
 */
export interface PolymarketExclusionSet {
  path: string;
  present?: boolean;
  valid?: boolean;
  count: number | null;
  items: PolymarketExclusion[];
  error?: string | null;
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

/**
 * A summary of the local polymarket engine's own state.
 *
 * The seven optional fields this previously declared (`open_trades`,
 * `closed_trades`, `trade_sides`, `signal_decisions`, `order_statuses`,
 * `performance_metrics`, `portfolio`) are not emitted by the summariser, so a
 * consumer reading them got `undefined` where the honest answer is "this engine
 * does not report that". Declared-but-absent reads as a guarantee that nothing
 * needs checking.
 */
export interface PolymarketMarketSummary {
  trades: number;
  /**
   * The server emits these seven; the type declared only the counts above, so a
   * contract test reading the live payload found every one of them undeclared.
   * The counts alone cannot answer the only questions anyone asks of a summary:
   * how much of that activity is still open, how the trades were split, and what
   * the money currently looks like.
   */
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
  /**
   * Providers that are configured but not currently serving. Empty is the healthy
   * case and is a real measurement, not missing data.
   *
   * This was absent from the canonical type while Overview read it. That worked
   * only because Overview declares a private copy of HarnessHealth with the field
   * included — the second component-local duplicate of a type that api.ts already
   * exports, and the same pattern that hid Agent.evidence from the canonical
   * Agent.
   */
  degradedProviders?: string[];
}

/**
 * One probed service from /api/services/health.
 *
 * `attempts` is sent by the collector (how many times it tried before recording
 * a status) and was previously undeclared.
 */
export interface ServicePort {
  name: string;
  port: number;
  role: string;
  status: 'online' | 'offline';
  latencyMs: number;
  error: string | null;
  attempts?: number;
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
  verdict_tally_total?: number;
  requeued?: Array<[string, string]>;
  quarantined?: Array<[string, string]>;
  /** Fraction of scanned verdicts that were OK. Measures output quality only. */
  outputQualityRatePct?: number | null;
  /**
   * Verified work is not measured by this pipeline and is published as null.
   * 0 would claim nothing was verified and a number would claim a measurement
   * that never happened, so the honest value is "not measured" plus a reason.
     */
  verifiedWork?: number | null;
  verifiedWorkDenominator?: number | null;
  verificationCoverage?: number | null;
  verificationBasis?: string;
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

/**
 * Ceiling on one poll. `fetch` never times out on its own, so a route that
 * accepts the connection and does not answer leaves the request open and the
 * panel stuck on its previous value with no error to show. See the same guard
 * in live/store.ts.
 */
const FETCH_TIMEOUT_MS = 10000;

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
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, FETCH_TIMEOUT_MS);
    fetch(path, { headers: { Accept: 'application/json' }, signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<T>;
      })
      .then((json) => { if (alive.current) { setData(json); setError(null); } })
      .catch((e: unknown) => {
        if (!alive.current) return;
        setError(controller.signal.aborted
          ? `no response within ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`
          : (e instanceof Error ? e.message : String(e)));
      })
      .finally(() => { clearTimeout(timer); if (alive.current) setLoading(false); });
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
