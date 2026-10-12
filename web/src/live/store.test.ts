import { describe, expect, it, vi } from 'vitest';
import type { StoreEnvironment, WebSocketLike } from './store';

// vitest.setup.ts mocks the store module for the component tests, which would
// replace the class under test with a stub whose load() resolves immediately --
// the shape of test that passes because it tested nothing. importActual reads
// the real file off disk.
const { LiveStore } = await vi.importActual<typeof import('./store')>('./store');

// The store used to have no test of its own, and every read it makes was
// unprotected: `fetch` has no default timeout, so a route that accepts the
// connection and never answers left `loading` true forever with no error to
// show. That is indistinguishable in the UI from a hive that has nothing to
// say, which is how a server bug turns into a permanently blank dashboard.
//
// The deadline is driven through the injected environment, so these tests own
// the clock: no fake timers, no waiting ten seconds, no dependence on jsdom's
// AbortSignal implementation.

type TimerMap = Map<number, () => void>;

function makeEnv(timers: TimerMap): StoreEnvironment {
  let next = 1;
  const socket: WebSocketLike = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => {},
    close: () => {},
  };
  return {
    storage: null,
    now: () => 1000,
    createSocket: () => socket,
    setTimeout: (handler) => {
      const handle = next;
      next += 1;
      timers.set(handle, handler);
      return handle;
    },
    clearTimeout: (handle) => { timers.delete(handle as number); },
    location: { protocol: 'http:', host: '127.0.0.1:4747' },
  };
}

/** Resolve the pending microtasks the load chain leaves behind. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

function abortingFetch(): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    // Real fetch behaviour: an abort rejects the pending promise.
    return new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => {
        reject(new DOMException('The user aborted a request.', 'AbortError'));
      });
    });
  });
  return { calls };
}

describe('request deadline', () => {
  it('reports a request the server never answers instead of loading forever', async () => {
    const timers: TimerMap = new Map();
    const { calls } = abortingFetch();
    try {
      const store = new LiveStore(makeEnv(timers));
      const pending = store.load('agents');
      expect(store.getState().resources.agents?.loading).toBe(true);

      calls.forEach((call) => {
        expect(call.init.signal).toBeInstanceOf(AbortSignal);
      });

      [...timers.values()].forEach((fire) => { fire(); });
      await pending;

      const state = store.getState().resources.agents;
      expect(state?.loading).toBe(false);
      expect(state?.error).toMatch(/no response within 10s/);
      expect(state?.data).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a normal answer disarms the deadline so it cannot fail a live panel', async () => {
    const timers: TimerMap = new Map();
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ agents: [{ id: 'F4' }] }),
    }));
    try {
      const store = new LiveStore(makeEnv(timers));
      await store.load('agents');

      const state = store.getState().resources.agents;
      expect(state?.error).toBeNull();
      expect(state?.loading).toBe(false);
      expect(state?.stale).toBe(false);
      expect(state?.data).toEqual({ agents: [{ id: 'F4' }] });
      // The point of the finally: a satisfied request must not leave an armed
      // timer that would abort the next one sharing this controller.
      expect(timers.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('an HTTP error is reported as the status the server returned', async () => {
    const timers: TimerMap = new Map();
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 503 }));
    try {
      const store = new LiveStore(makeEnv(timers));
      await store.load('agents');
      expect(store.getState().resources.agents?.error).toBe('HTTP 503');
      expect(timers.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the fallback poll carries the same deadline as the first read', async () => {
    const timers: TimerMap = new Map();
    const { calls } = abortingFetch();
    try {
      const store = new LiveStore(makeEnv(timers));
      const pending = store.load('streamStatus'); // polled telemetry, no push machinery
      [...timers.values()].forEach((fire) => { fire(); });
      await pending;
      await settle();
      expect(store.getState().resources.streamStatus?.error).toMatch(/no response within 10s/);
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe('/api/live/streamStatus');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
