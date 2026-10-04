import { useCallback, useEffect, useState } from 'react';

// Live data layer.
//
// One WebSocket carries every panel's data. Components declare which resources
// they need; the store fetches anything the socket has not delivered yet and
// falls back to per-resource polling only when the socket is down. Nothing
// refetches "everything" any more.

export type Severity = 'info' | 'warn' | 'critical';

export interface Alert {
  analyzer: string;
  severity: Severity;
  fingerprint: string;
  title: string;
  detail: string;
  at: number;
  firstSeen: number;
  lastSeen: number;
  acknowledged: boolean;
  acknowledgedAt: number | null;
  agentId?: string;
  metric?: string;
  value?: number | string;
}

export interface ResolvedAlert extends Alert {
  resolvedAt: number;
  durationMs: number;
}

export interface AlertSummary {
  alerts: Alert[];
  counts: Record<Severity, number>;
  unacknowledged: number;
  history: ResolvedAlert[];
  lastEvaluatedAt: number | null;
  intervalMs?: number;
  runs?: number;
}

export interface Viewer {
  id: string;
  floor: string | null;
  label: string | null;
  keys: string[];
}

export interface ResourceState<T = unknown> {
  data: T | null;
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
  /** True when the payload came from cache and no live value has arrived yet. */
  stale: boolean;
}

type Listener = () => void;

const SOCKET_PATH = '/api/live/socket';
const STORAGE_PREFIX = 'office-hud:last-good:';
const STORAGE_LIMIT = 24;
const POLL_FALLBACK_MS = 20000;
const STALE_AFTER_MS = 120000;
/**
 * Trailing debounce for localStorage writes. The socket delivers every
 * resource on a shared 1/60s tick, and `sessions` serializes to several MB,
 * so writing on each message re-serialized the same megabytes dozens of times
 * a minute. Safari backs localStorage with SQLite in WAL mode and never
 * checkpoints that log, so the repeated writes grew a 58 GB WAL against 4 MB
 * of real data. Coalescing to one write per window keeps the cache fresh while
 * bounding how fast the log can grow.
 */
const STORAGE_WRITE_DEBOUNCE_MS = 5000;

// ---------------------------------------------------------------- persistence

function readCached<T>(key: string, storage: Storage | null): { data: T; updatedAt: number } | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: T; updatedAt: number };
    if (typeof parsed?.updatedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedNow(key: string, data: unknown, updatedAt: number, storage: Storage | null): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_PREFIX + key, JSON.stringify({ data, updatedAt }));
  } catch {
    // Quota or private mode: the app still works, just without offline state.
  }
}

/**
 * Pending debounced writes, keyed by resource. Each entry holds the latest
 * value plus the timer that will flush it, so a burst of socket messages
 * collapses into one serialization of the newest payload.
 */
const pendingWrites = new Map<
  string,
  { data: unknown; updatedAt: number; storage: Storage; timer: unknown; schedule: (fn: () => void, ms: number) => unknown }
>();

function flushCached(key: string): void {
  const pending = pendingWrites.get(key);
  if (!pending) return;
  pendingWrites.delete(key);
  writeCachedNow(key, pending.data, pending.updatedAt, pending.storage);
}

function writeCached(
  key: string,
  data: unknown,
  updatedAt: number,
  storage: Storage | null,
  schedule: (fn: () => void, ms: number) => unknown,
): void {
  if (!storage) return;
  const existing = pendingWrites.get(key);
  if (existing) {
    // Keep the newest payload; the pending timer will serialize it once.
    existing.data = data;
    existing.updatedAt = updatedAt;
    return;
  }
  const timer = schedule(() => flushCached(key), STORAGE_WRITE_DEBOUNCE_MS);
  pendingWrites.set(key, { data, updatedAt, storage, timer, schedule });
}

/** Drop any pending debounced writes without writing them. Used by tests. */
export function resetPendingWrites(cancel: (handle: unknown) => void = clearTimeout): void {
  for (const pending of pendingWrites.values()) cancel(pending.timer);
  pendingWrites.clear();
}

/**
 * Keep the cache bounded. The number of resource names is fixed and small, but
 * a renamed resource would otherwise leave an orphan behind forever.
 */
function pruneCache(storage: Storage | null): void {
  if (!storage) return;
  try {
    const keys = Object.keys(storage).filter((key) => key.startsWith(STORAGE_PREFIX));
    if (keys.length <= STORAGE_LIMIT) return;
    const stamped = keys
      .map((key) => {
        try {
          const parsed = JSON.parse(storage.getItem(key) || '{}') as { updatedAt?: number };
          return { key, at: parsed.updatedAt ?? 0 };
        } catch {
          return { key, at: 0 };
        }
      })
      .sort((a, b) => a.at - b.at);
    for (const entry of stamped.slice(0, keys.length - STORAGE_LIMIT)) storage.removeItem(entry.key);
  } catch { /* storage unavailable */ }
}

// ------------------------------------------------------------------- the store

type ResourceMap = Record<string, ResourceState>;

export interface StoreEnvironment {
  storage: Storage | null;
  now: () => number;
  createSocket: (url: string) => WebSocketLike;
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  location: { protocol: string; host: string };
}

/** The slice of WebSocket the store uses, so a fake can stand in. */
export interface WebSocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send: (data: string) => void;
  close: () => void;
}

export const OPEN = 1;

/**
 * Built on first use, not at import time: touching `location` or `localStorage`
 * while the module loads breaks importing this file outside a browser (which is
 * exactly what the test suite does).
 */
function browserEnvironment(): StoreEnvironment {
  return {
    storage: typeof localStorage !== 'undefined' ? localStorage : null,
    now: () => Date.now(),
    createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    location: {
      protocol: typeof location !== 'undefined' ? location.protocol : 'http:',
      host: typeof location !== 'undefined' ? location.host : '127.0.0.1',
    },
  };
}

export class LiveStore {
  readonly env: StoreEnvironment;
  private resources: ResourceMap = {};
  private listeners = new Set<Listener>();
  private socket: WebSocketLike | null = null;
  private subscriptions = new Map<string, number>();
  private reconnectTimer: unknown = null;
  private reconnectDelay = 1000;
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private presenceListeners = new Set<(viewers: Viewer[]) => void>();
  private viewers: Viewer[] = [];
  private status: ConnectionStatus;
  private inflight = new Map<string, Promise<unknown>>();
  private pollers = new Map<string, unknown>();
  private label: string | null = null;

  constructor(env?: StoreEnvironment) {
    this.env = env ?? browserEnvironment();
    this.status = { state: 'connecting', since: this.env.now() };
  }

  getState(): { resources: ResourceMap; status: ConnectionStatus; viewers: Viewer[] } {
    return { resources: this.resources, status: this.status, viewers: this.viewers };
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  subscribeStatus = (listener: (status: ConnectionStatus) => void): (() => void) => {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => { this.statusListeners.delete(listener); };
  };

  subscribeViewers = (listener: (viewers: Viewer[]) => void): (() => void) => {
    this.presenceListeners.add(listener);
    listener(this.viewers);
    return () => { this.presenceListeners.delete(listener); };
  };

  getStatus(): ConnectionStatus { return this.status; }
  getViewers(): Viewer[] { return this.viewers; }

  setLabel(label: string | null): void {
    this.label = label;
    this.send({ type: 'presence', label });
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  private setStatus(state: ConnectionStatus['state'], detail?: string): void {
    this.status = { state, since: this.env.now(), detail };
    this.statusListeners.forEach((listener) => listener(this.status));
    this.emit();
  }

  /** Merge a patch into one resource and notify subscribers. */
  patch(key: string, patch: Partial<ResourceState>): void {
    const current = this.resources[key] ?? { data: null, error: null, loading: true, updatedAt: null, stale: false };
    this.resources = { ...this.resources, [key]: { ...current, ...patch } };
    this.emit();
  }

  // ------------------------------------------------------------ subscriptions

  /** Reference-counted: the socket only carries what a mounted panel needs. */
  acquire(key: string): () => void {
    // An empty key means "this panel is not pushed"; it must not appear in the
    // subscription set or the server's resource list.
    if (!key) return () => {};
    const count = (this.subscriptions.get(key) ?? 0) + 1;
    this.subscriptions.set(key, count);
    if (count === 1) {
      // The socket is opened here, not lazily: send() is a no-op without one, so
      // a panel would otherwise fetch once and then only ever poll.
      this.connect();
      this.send({ type: 'subscribe', keys: this.pushKeys(), label: this.label });
      void this.load(key);                 // covers the socket-not-yet-ready case
      this.startPolling(key);              // fallback if pushes stop arriving
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.subscriptions.get(key) ?? 1) - 1;
      if (next <= 0) {
        this.subscriptions.delete(key);
        this.stopPolling(key);
        this.send({ type: 'unsubscribe', keys: [key], label: this.label });
        if (this.subscriptions.size === 0) this.closeSocket();
      } else {
        this.subscriptions.set(key, next);
      }
    };
  }

  // ------------------------------------------------------------------ loading

  async load(key: string): Promise<void> {
    // Hub telemetry is a slow-moving read the server never pushes.
    if (key === 'streamStatus') return this.loadOnce(key);
    const cached = readCached<unknown>(key, this.env.storage);
    if (cached && !this.resources[key]?.data) {
      // Show the last known value immediately, flagged as stale, so a cold start
      // or a hive outage still renders something real.
      this.patch(key, { data: cached.data as never, updatedAt: cached.updatedAt, stale: true, loading: false });
    }
    if (!this.resources[key]) this.patch(key, { loading: true });

    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<void>;

    const request = (async () => {
      try {
        const response = await fetch(`/api/live/${key}`, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        // env.now(), not Date.now(): isStale() and the test harness both
        // compare against the injected clock.
        const updatedAt = this.env.now();
        this.patch(key, { data: payload as never, error: null, loading: false, updatedAt, stale: false });
        writeCached(key, payload, updatedAt, this.env.storage, this.env.setTimeout);
        pruneCache(this.env.storage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.patch(key, { error: message, loading: false });
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, request);
    return request;
  }

  /** Fetch without the push/merge machinery, used for telemetry reads. */
  private async loadOnce(key: string): Promise<void> {
    try {
      const response = await fetch(`/api/live/${key}`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      this.patch(key, { data: payload as never, error: null, loading: false, updatedAt: this.env.now(), stale: false });
    } catch (error) {
      this.patch(key, { error: error instanceof Error ? error.message : String(error), loading: false });
    }
  }

  private startPolling(key: string): void {
    if (this.pollers.has(key)) return;
    if (key === 'streamStatus') {
      // Telemetry: acquire() has already fetched it once, so only the slow poll
      // is scheduled here. Never a push target.
      const slow = this.env.setTimeout(function tick(this: LiveStore) {
        void this.loadOnce(key);
        this.pollers.set(key, this.env.setTimeout(tick.bind(this), 5000));
      }.bind(this), 5000);
      this.pollers.set(key, slow);
      return;
    }
    // One self-rescheduling timer, and the status check belongs on the tick
    // that actually re-arms. An earlier version kept the guarded timer in a
    // local and stored the unguarded one, so every subscribed resource was
    // refetched every 20s even while the socket was live, and the orphaned
    // guarded timer survived release() and fired once after unmount.
    this.pollers.set(key, this.env.setTimeout(function tick(this: LiveStore) {
      // A live socket already pushes; polling is only a safety net.
      if (this.status.state !== 'live') void this.load(key);
      this.pollers.set(key, this.env.setTimeout(tick.bind(this), POLL_FALLBACK_MS));
    }.bind(this), POLL_FALLBACK_MS));
  }

  private stopPolling(key: string): void {
    const handle = this.pollers.get(key);
    if (handle !== undefined) this.env.clearTimeout(handle);
    this.pollers.delete(key);
  }

  // ------------------------------------------------------------------- socket

  private connect(): void {
    if (this.socket) return;
    if (this.subscriptions.size === 0) return;
    // Availability is the environment's business, not a global check: a page
    // without WebSocket should be handled by whoever builds the environment.

    const protocol = this.env.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocketLike;
    try {
      socket = this.env.createSocket(`${protocol}//${this.env.location.host}${SOCKET_PATH}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.setStatus('connecting');

    socket.onopen = () => {
      this.reconnectDelay = 1000;
      this.setStatus('live');
      // Re-assert the full subscription set; the server holds none until told.
      socket.send(JSON.stringify({ type: 'subscribe', keys: this.pushKeys(), label: this.label }));
      void Promise.all(this.pushKeys().map((key) => this.load(key)));
    };

    socket.onmessage = (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handle(message);
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.setStatus('offline');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows; reconnect is handled there.
    };
  }

  private handle(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'hello':
        this.setStatus('live');
        return;
      case 'resource': {
        const key = message.key as string;
        if (typeof key !== 'string') return;
        const updatedAt = this.env.now();
        if (message.error) {
          this.patch(key, { error: String(message.error), loading: false });
          return;
        }
        this.patch(key, { data: message.payload as never, error: null, loading: false, updatedAt, stale: false });
        writeCached(key, message.payload, updatedAt, this.env.storage, this.env.setTimeout);
        return;
      }
      case 'alerts': {
        const payload = message.alerts as Alert[] | undefined;
        if (!Array.isArray(payload)) return;
        const summary: AlertSummary = {
          alerts: payload,
          counts: countBySeverity(payload),
          unacknowledged: payload.filter((alert) => !alert.acknowledged).length,
          history: (this.resources.alerts?.data as AlertSummary | null)?.history ?? [],
          lastEvaluatedAt: this.env.now(),
        };
        this.patch('alerts', { data: summary as never, error: null, loading: false, updatedAt: this.env.now(), stale: false });
        return;
      }
      case 'presence': {
        const viewers = (message.viewers as Viewer[] | undefined) ?? [];
        this.viewers = viewers;
        this.presenceListeners.forEach((listener) => listener(viewers));
        this.emit();
        return;
      }
      case 'subscribed':
      case 'pong':
        return;
      case 'error':
        this.setStatus('live', String(message.error ?? 'stream error'));
        return;
      default:
    }
  }

  /** Close the socket once nothing is subscribed, matching the server's cap. */
  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try { socket.close(); } catch { /* already closed */ }
    if (this.reconnectTimer !== null) {
      this.env.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelay = 1000;
    this.setStatus('offline');
  }

  /** Resources the socket carries. Telemetry is polled, never pushed. */
  private pushKeys(): string[] {
    return [...this.subscriptions.keys()].filter((key) => key !== 'streamStatus');
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = this.env.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  /** Force a refetch of one resource (used by the manual refresh button). */
  async refresh(key?: string): Promise<void> {
    if (key) return this.load(key);
    return Promise.all([...this.subscriptions.keys()].map((name) => this.load(name))).then(() => undefined);
  }

  isStale(key: string): boolean {
    const updatedAt = this.resources[key]?.updatedAt ?? 0;
    return !updatedAt || this.env.now() - updatedAt > STALE_AFTER_MS;
  }
}

function countBySeverity(alerts: Alert[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { info: 0, warn: 0, critical: 0 };
  for (const alert of alerts) counts[alert.severity] = (counts[alert.severity] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------- autonomy

export interface AutonomyPolicy {
  enabled: boolean;
  requireConfirmation: boolean;
  maxAdditionalAgents: number;
  cooldownMinutes: number;
  dailyBudgetUsd: number;
  minQueueToReact: number;
  targetDrainHours: number;
  rateWindowHours: number;
  proposalTtlMinutes: number;
  allowedTargets: string[];
}

export interface CapacityAssessment {
  reason: string;
  queued: number;
  inProgress: number;
  drainRatePerHour: number;
  /** null when the queue is not draining at all, never Infinity. */
  timeToDrainHours: number | null;
  agentsBusy: number;
  agentsIdle: number;
  agentsTotal: number;
  agentsNeeded: number;
  idleCapacity: number;
  deficitTasks: number;
  saturated: boolean;
}

export interface AutonomyProposal {
  id: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'accepted' | 'dismissed' | 'expired';
  target: string | null;
  requestedAgents: number;
  prompt: string;
  priority: string;
  assessment: CapacityAssessment;
  acceptedAt?: number;
  routed?: { task_id?: string };
}

export interface AutonomyAuditEntry {
  at: number;
  action: string;
  detail: string;
  taskId?: string | null;
  requestedAgents?: number;
}

export interface AutonomyState {
  policy: AutonomyPolicy | null;
  assessment: CapacityAssessment | null;
  proposals: AutonomyProposal[];
  pending: number;
  audit: AutonomyAuditEntry[];
  runs: number;
  spendToday: number;
  lastRoutedAt: number | null;
  error?: string;
}

/** Hub telemetry, served at /api/live/status and polled rarely. */
export interface LiveStatus {
  state: 'connecting' | 'live' | 'offline';
  socketPath: string;
  clients: number;
  sequence: number;
  stats: { publishes: number; pushes: number };
  viewers: Viewer[];
}

export interface ConnectionStatus {
  state: 'connecting' | 'live' | 'offline';
  since: number;
  detail?: string;
}

export const liveStore = new LiveStore();

// ------------------------------------------------------------------- the hooks

/** Subscribe a component to one resource. */
export function useResource<T>(key: string): ResourceState<T> & { refresh: () => void } {
  // Both are unconditional (hooks rules), so an empty key is inert by design.
  const [, force] = useState(0);
  useEffect(() => liveStore.subscribe(() => force((n) => n + 1)), []);
  useEffect(() => liveStore.acquire(key), [key]);

  const state = liveStore.getState().resources[key];
  return {
    data: (state?.data as T | null) ?? null,
    error: state?.error ?? null,
    loading: state?.loading ?? true,
    updatedAt: state?.updatedAt ?? null,
    stale: state?.stale ?? false,
    refresh: useCallback(() => { void liveStore.load(key); }, [key]),
  };
}

export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState(liveStore.getStatus());
  useEffect(() => liveStore.subscribeStatus(setStatus), []);
  return status;
}

export function useViewers(): Viewer[] {
  const [viewers, setViewers] = useState(liveStore.getViewers());
  useEffect(() => liveStore.subscribeViewers(setViewers), []);
  return viewers;
}

/** Acknowledge an alert; the server is the source of truth for the ack set. */
export async function acknowledgeAlert(fingerprint: string, acknowledge = true): Promise<boolean> {
  const verb = acknowledge ? 'ack' : 'unack';
  try {
    const response = await fetch(`/api/alerts/${encodeURIComponent(fingerprint)}/${verb}`, { method: 'POST' });
    if (!response.ok) return false;
    const summary = liveStore.getState().resources.alerts?.data as AlertSummary | null;
    if (summary) {
      const alerts = summary.alerts.map((alert) => (
        alert.fingerprint === fingerprint
          ? { ...alert, acknowledged: acknowledge, acknowledgedAt: Date.now() }
          : alert
      ));
      liveStore.patch('alerts', {
        data: { ...summary, alerts, unacknowledged: alerts.filter((alert) => !alert.acknowledged).length } as never,
      });
    }
    return true;
  } catch {
    return false;
  }
}

export async function acknowledgeAllAlerts(): Promise<boolean> {
  try {
    const response = await fetch('/api/alerts/ack-all', { method: 'POST' });
    if (!response.ok) return false;
    const summary = liveStore.getState().resources.alerts?.data as AlertSummary | null;
    if (summary) {
      const alerts = summary.alerts.map((alert) => ({ ...alert, acknowledged: true, acknowledgedAt: Date.now() }));
      liveStore.patch('alerts', {
        data: { ...summary, alerts, unacknowledged: 0 } as never,
      });
    }
    return true;
  } catch {
    return false;
  }
}
