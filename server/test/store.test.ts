// Tests for the live store: the most intricate client code in the HUD, and the
// piece that decides whether a panel is showing live data or a fossil.
//
// The store takes its whole environment (storage, clock, timers, socket) as an
// injectable object, so these run under node:test with no browser and no mocks
// of the module under test.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LiveStore,
  OPEN,
  resetPendingWrites,
  type StoreEnvironment,
  type WebSocketLike,
} from '../../web/src/live/store.ts';

// ------------------------------------------------------------------ fakes

class FakeStorage {
  private map = new Map<string, string>();
  public failWrites = false;

  get length() { return this.map.size; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('quota exceeded');
    this.map.set(key, value);
  }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
  [Symbol.iterator]() { return this.map[Symbol.iterator](); }
}

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = OPEN;
    this.onopen?.();
  }

  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }

  /** Deliver a server frame. */
  emit(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Simulate the socket dropping. */
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }

  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((line) => JSON.parse(line));
  }
}

interface Harness {
  store: LiveStore;
  storage: FakeStorage;
  timers: Array<{ fn: () => void; ms: number }>;
  runTimer(index: number): void;
  clock: { now: number };
  fetchCalls: Array<{ url: string; seq: number }>;
  setResponse(url: string, payload: unknown, ok?: boolean): void;
}

function harness(options: { storage?: FakeStorage | null; fetchImpl?: (url: string) => Promise<unknown> } = {}): Harness {
  const storage = options.storage === null ? null : (options.storage ?? new FakeStorage());
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const clock = { now: 1_700_000_000_000 };
  const fetchCalls: Array<{ url: string; seq: number }> = [];
  let seq = 0;
  const responses = new Map<string, unknown>();

  const env: StoreEnvironment = {
    storage: storage as unknown as Storage | null,
    now: () => clock.now,
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocketLike,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimeout: (handle) => { timers[handle as number] = { fn: () => {}, ms: 0 }; },
    location: { protocol: 'http:', host: '127.0.0.1:4747' },
  };

  const globalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    fetchCalls.push({ url, seq: seq++ });
    if (options.fetchImpl) return options.fetchImpl(url) as never;
    const payload = responses.get(url);
    if (payload === undefined) throw new Error(`no stub for ${url}`);
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      headers: { get: () => 'application/json' },
    } as never;
  }) as typeof fetch;

  const h: Harness = {
    store: new LiveStore(env),
    storage: storage as FakeStorage,
    timers,
    runTimer: (index) => timers[index]?.fn(),
    clock,
    fetchCalls,
    setResponse: (url, payload) => { responses.set(url, payload); },
  };
  h.restore = () => { globalThis.fetch = globalFetch; };
  return h;
}

/**
 * Cache writes are debounced through module-level state, so each test starts
 * from a clean slate. Timers are dropped rather than run.
 */
function resetDebounceState(): void {
  resetPendingWrites(() => {});
}

const harnesses: Harness[] = [];
function makeHarness(options?: Parameters<typeof harness>[0]): Harness {
  const h = harness(options);
  harnesses.push(h);
  return h;
}
test.after(() => { for (const h of harnesses) (h as Harness & { restore?: () => void }).restore?.(); });

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------------ tests

test('acquiring the same resource twice subscribes once', async () => {
  const h = makeHarness();
  h.setResponse('/api/live/queue', { total: 1 });
  const releaseA = h.store.acquire('queue');
  const releaseB = h.store.acquire('queue');
  await tick();

  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  const subscribes = socket.parsed().filter((m) => m.type === 'subscribe');
  assert.equal(subscribes.length, 1, 'one subscribe for two holders');
  assert.deepEqual(subscribes[0].keys, ['queue']);

  releaseA();
  assert.equal(
    socket.parsed().filter((m) => m.type === 'unsubscribe').length,
    0,
    'still subscribed while one holder remains'
  );
  releaseB();
  const unsubscribes = socket.parsed().filter((m) => m.type === 'unsubscribe');
  assert.equal(unsubscribes.length, 1, 'unsubscribes when the last holder leaves');
  assert.deepEqual(unsubscribes[0].keys, ['queue']);
});

test('releasing twice is harmless', async () => {
  const h = makeHarness();
  h.setResponse('/api/live/queue', { total: 1 });
  const release = h.store.acquire('queue');
  await tick();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  release();
  release();
  assert.equal(socket.parsed().filter((m) => m.type === 'unsubscribe').length, 1);
});

test('a pushed payload lands in the store and in the cache', async () => {
  resetDebounceState();
  const h = makeHarness();
  h.setResponse('/api/live/queue', { total: 1 });
  h.store.acquire('queue');
  await tick();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  await tick();

  socket.emit({ type: 'resource', key: 'queue', payload: { total: 42, queued: 7 } });
  const state = h.store.getState().resources.queue!;
  assert.deepEqual(state.data, { total: 42, queued: 7 });
  assert.equal(state.stale, false);
  assert.equal(state.error, null);
  assert.equal(state.loading, false);

  // Cache writes are debounced so a burst of frames serializes once.
  h.runTimer(h.timers.findIndex((t) => t.ms === 5000));
  const cached = JSON.parse(h.storage.getItem('office-hud:last-good:queue')!);
  assert.equal(cached.data.total, 42);
});

test('a burst of pushes writes the cache once, with the newest payload', async () => {
  resetDebounceState();
  const h = makeHarness();
  h.setResponse('/api/live/queue', { total: 1 });
  h.store.acquire('queue');
  await tick();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  await tick();

  // The acquire() fetch above already scheduled a pending write, so the burst
  // must reuse that timer rather than adding one per frame.
  const pendingIndex = h.timers.findIndex((t) => t.ms === 5000);
  const timersBeforeBurst = h.timers.length;
  for (let i = 1; i <= 5; i += 1) {
    socket.emit({ type: 'resource', key: 'queue', payload: { total: i } });
  }
  assert.equal(
    h.timers.length,
    timersBeforeBurst,
    'a burst must not schedule one write per frame',
  );

  h.runTimer(pendingIndex);
  const cached = JSON.parse(h.storage.getItem('office-hud:last-good:queue')!);
  assert.equal(cached.data.total, 5, 'the flushed payload must be the newest');
});

test('a cached payload renders immediately and is flagged stale until live data lands', async () => {
  const h = makeHarness();
  h.storage.setItem('office-hud:last-good:queue', JSON.stringify({ data: { total: 99 }, updatedAt: h.clock.now - 60000 }));

  // The fetch never resolves, as during a hive outage.
  h.store.acquire('queue');
  await tick();
  const state = h.store.getState().resources.queue!;
  assert.deepEqual(state.data, { total: 99 }, 'shows the last known value');
  assert.equal(state.stale, true, 'and says so');
  assert.equal(state.loading, false);
});

test('concurrent loads of one resource issue a single fetch', async () => {
  let resolveFetch: (value: unknown) => void = () => {};

  const pending = new Promise((resolve) => { resolveFetch = resolve; });
  const h = makeHarness({
    fetchImpl: async () => {
      await pending;
      return { ok: true, status: 200, json: async () => ({ total: 5 }), headers: { get: () => 'application/json' } };
    },
  });
  h.store.acquire('queue');
  h.store.acquire('queue');
  h.store.acquire('queue');
  await tick();
  assert.equal(h.fetchCalls.filter((c) => c.url === '/api/live/queue').length, 1);
  resolveFetch(undefined);
  await tick();
  await tick();
  assert.equal(h.store.getState().resources.queue!.data !== null, true);
});

test('a failed fetch surfaces the error and keeps the cached data', async () => {
  const h = makeHarness({ fetchImpl: () => { throw new Error('offline'); } });
  h.store.acquire('queue');
  await tick();
  const state = h.store.getState().resources.queue!;
  assert.equal(state.error, 'offline');
  assert.equal(state.loading, false);
});

test('an error frame does not wipe the last good payload', async () => {
  const h = makeHarness();
  h.setResponse('/api/live/queue', { total: 42 });
  h.store.acquire('queue');
  await tick();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  await tick();

  socket.emit({ type: 'resource', key: 'queue', error: 'producer exploded' });
  const state = h.store.getState().resources.queue!;
  assert.equal(state.error, 'producer exploded');
  assert.deepEqual(state.data, { total: 42 }, 'previous data is kept');
});

test('reconnect backoff doubles and is capped at 30s', async () => {
  const h = makeHarness();
  h.setResponse('/api/live/queue', { total: 1 });
  h.store.acquire('queue');
  await tick();
  const first = FakeSocket.instances.at(-1)!;
  first.open();

  const delays: number[] = [];
  for (let round = 0; round < 8; round += 1) {
    const socket = FakeSocket.instances.at(-1)!;
    socket.drop();
    const timer = h.timers.at(-1)!;
    delays.push(timer.ms);
    h.runTimer(h.timers.length - 1);
    await tick();
  }
  assert.ok(delays[0] < delays[1], `backoff should grow: ${delays.join(',')}`);
  assert.ok(Math.max(...delays) <= 30000, `capped at 30s, saw ${Math.max(...delays)}`);
  assert.ok(FakeSocket.instances.length >= 3, 'it reconnects');
});

test('polling is suppressed while the socket is live and resumes when it drops', async () => {
  const h = makeHarness();
  h.setResponse('/api/live/queue', { total: 1 });
  h.store.acquire('queue');
  await tick();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  await tick();
  const afterSubscribe = h.fetchCalls.length;

  // The safety-net timer fires while connected: no extra request.
  h.runTimer(h.timers.findIndex((t) => t.ms === 20000));
  await tick();
  assert.equal(h.fetchCalls.length, afterSubscribe, 'no refetch while pushes are arriving');

  socket.drop();
  h.runTimer(h.timers.findIndex((t) => t.ms === 20000));
  await tick();
  assert.ok(h.fetchCalls.length > afterSubscribe, 'falls back to polling when the socket is down');
});

test('telemetry is polled and never treated as a push target', async () => {
  const h = makeHarness();
  h.setResponse('/api/live/streamStatus', { clients: 2, sequence: 9 });
  h.store.acquire('streamStatus');
  await tick();
  assert.equal(h.fetchCalls.filter((c) => c.url === '/api/live/streamStatus').length, 1);
  assert.equal(h.store.getState().resources.streamStatus!.data !== null, true);

  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  const subscribes = socket.parsed().filter((m) => m.type === 'subscribe');
  assert.ok(
    !subscribes.some((m) => (m.keys as string[]).includes('streamStatus')),
    'telemetry must not be subscribed to as a push resource'
  );
});

test('an alert frame is folded into the alerts summary', async () => {
  const h = makeHarness();
  h.setResponse('/api/live/alerts', { alerts: [], counts: { critical: 0, warn: 0, info: 0 }, unacknowledged: 0, history: [] });
  h.store.acquire('alerts');
  await tick();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  await tick();

  socket.emit({
    type: 'alerts',
    alerts: [
      { fingerprint: 'a', severity: 'critical', title: 'one', acknowledged: false },
      { fingerprint: 'b', severity: 'warn', title: 'two', acknowledged: true },
    ],
  });
  const summary = h.store.getState().resources.alerts!.data as {
    alerts: Array<{ acknowledged: boolean }>;
    counts: Record<string, number>;
    unacknowledged: number;
  };
  assert.equal(summary.alerts.length, 2);
  assert.equal(summary.counts.critical, 1);
  assert.equal(summary.counts.warn, 1);
  assert.equal(summary.unacknowledged, 1);
});

test('presence updates the viewer list', async () => {
  const h = makeHarness();
  h.setResponse('/api/live/queue', { total: 1 });
  h.store.acquire('queue');
  await tick();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  await tick();

  socket.emit({ type: 'presence', viewers: [{ id: 'c1', floor: 'f5', label: 'tab', keys: ['queue'] }] });
  assert.equal(h.store.getViewers().length, 1);
  assert.equal(h.store.getViewers()[0].floor, 'f5');
});

test('a malformed frame is ignored without breaking the socket', async () => {
  const h = makeHarness();
  h.setResponse('/api/live/queue', { total: 1 });
  h.store.acquire('queue');
  await tick();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  await tick();

  socket.onmessage?.({ data: 'not json at all' });
  assert.equal(socket.closed, false);
  assert.equal(h.store.getStatus().state, 'live');
});

test('everything works with no storage available', async () => {
  const h = makeHarness({ storage: null });
  h.setResponse('/api/live/queue', { total: 7 });
  h.store.acquire('queue');
  await tick();
  assert.deepEqual(h.store.getState().resources.queue!.data, { total: 7 });
});

test('a storage that throws on write does not break the store', async () => {
  const h = makeHarness();
  h.storage.failWrites = true;
  h.setResponse('/api/live/queue', { total: 7 });
  h.store.acquire('queue');
  await tick();
  assert.deepEqual(h.store.getState().resources.queue!.data, { total: 7 });
});

test('acquire before the socket is open still loads the resource', async () => {
  const h = makeHarness();
  h.setResponse('/api/live/queue', { total: 3 });
  h.store.acquire('queue');
  await tick();
  // No socket opened at all.
  assert.deepEqual(h.store.getState().resources.queue!.data, { total: 3 });
});

test.after(() => { setImmediate(() => process.exit(process.exitCode ?? 0)); });
