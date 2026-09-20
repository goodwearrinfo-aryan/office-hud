import { useCallback, useEffect, useState } from 'react';

export interface Agent {
  id: string;
  name: string;
  role: string;
  isGod: boolean;
  provider: string | null;
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

export interface AgentDetail {
  agent: Agent;
  identity: string | null;
  memory: string | null;
  inbox: Message[];
  outbox: Message[];
}

export interface LedgerEvent {
  ts?: number;
  kind?: string;
  [k: string]: unknown;
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
