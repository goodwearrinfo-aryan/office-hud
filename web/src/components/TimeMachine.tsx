import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ReplayWindow {
  earliest: number;
  latest: number;
  now: number;
  eventsAvailable: number;
  defaultHours: number;
  maxHours: number;
  stepMs: number;
}

export interface ReplaySnapshot {
  at: number;
  generatedAt: number;
  isLive: boolean;
  window: { from: number; to: number; hours: number; earliestEventAt: number | null; eventsConsidered: number };
  queue: {
    total: number;
    byStatus: Record<string, number>;
    perAgent: Array<{ agent: string; queued?: number; inProgress?: number; complete?: number; quarantined?: number }>;
  };
  throughput: Array<{ hour: number; count: number }>;
  agents: { tracked: number; aliveCount: number; alive: Array<{ agent: string; lastSeen: number; ageMs: number }> };
  transitions: Array<{ at: number; type: string; agent: string | null; taskId: string | null; reason: string | null }>;
}

function useReplayWindow() {
  const [bounds, setBounds] = useState<ReplayWindow | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch('/api/replay/window')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((json: ReplayWindow) => { if (alive) { setBounds(json); setError(null); } })
        .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    };
    load();
    const timer = setInterval(load, 60000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return { bounds, error };
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const stampFmt = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Time machine: scrub the fleet's past. The server reconstructs queue state from
 * each task's own timestamps and agent liveness from the heartbeat stream, so
 * this is history, not an estimate.
 */
export default function TimeMachine() {
  const { bounds, error: windowError } = useReplayWindow();
  const [at, setAt] = useState<number | null>(null);      // null = live
  const [hours, setHours] = useState(6);
  const [snapshot, setSnapshot] = useState<ReplaySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const playTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const isLive = at === null;
  const target = at ?? bounds?.now ?? Date.now();

  useEffect(() => {
    if (isLive) { setSnapshot(null); setError(null); return; }
    let alive = true;
    const query = `?at=${Math.round(target)}&hours=${hours}`;
    fetch(`/api/replay${query}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: ReplaySnapshot) => { if (alive) { setSnapshot(json); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [target, hours, isLive]);

  // Playback walks backwards through the window at the server's suggested step.
  useEffect(() => {
    if (!playing || !bounds) return undefined;
    playTimer.current = setInterval(() => {
      setAt((current) => {
        const next = (current ?? bounds.now) - bounds.stepMs;
        if (next <= bounds.earliest) { setPlaying(false); return bounds.earliest; }
        return next;
      });
    }, 400);
    return () => { if (playTimer.current) clearInterval(playTimer.current); };
  }, [playing, bounds]);

  const maxThroughput = useMemo(
    () => Math.max(1, ...(snapshot?.throughput.map((point) => point.count) ?? [1])),
    [snapshot]
  );

  const nudge = useCallback((deltaMs: number) => {
    setPlaying(false);
    setAt((current) => {
      const base = current ?? bounds?.now ?? Date.now();
      const next = Math.min(bounds?.latest ?? base, Math.max(bounds?.earliest ?? base, base + deltaMs));
      return next;
    });
  }, [bounds]);

  if (!bounds) {
    return (
      <div className="hud-floor">
        <h2>F13 · TIME MACHINE</h2>
        <p className="text-hud-dim">{windowError ? `Cannot read the event window: ${windowError}` : 'Loading event window…'}</p>
      </div>
    );
  }


  return (
    <div className="hud-floor time-machine">
      <div className="time-machine__head">
        <h2>F13 · TIME MACHINE</h2>
        <span className="badge badge-info">RECONSTRUCTED</span>
        <div className="time-machine__clock">
          {isLive ? 'LIVE' : stampFmt.format(new Date(target))}
        </div>
      </div>

      <div className="time-machine__controls">
        <button type="button" onClick={() => setAt(null)} disabled={isLive} className={isLive ? 'is-active' : ''}>
          live
        </button>
        <button type="button" onClick={() => nudge(15 * 60000)}>−15m</button>
        <button type="button" onClick={() => nudge(60 * 60000)}>−1h</button>
        <button type="button" onClick={() => nudge(6 * 3600000)}>−6h</button>
        <button
          type="button"
          onClick={() => { if (isLive) setAt(bounds.latest - bounds.stepMs); setPlaying((p) => !p); }}
          disabled={bounds.latest - bounds.earliest < bounds.stepMs}
        >
          {playing ? 'pause' : 'play'}
        </button>
        <label className="time-machine__hours">
          window
          <select value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            {[1, 3, 6, 12, 24, 48].map((value) => (
              <option key={value} value={value}>{value}h</option>
            ))}
          </select>
        </label>
      </div>

      <input
        className="time-machine__scrub"
        type="range"
        min={bounds.earliest}
        max={bounds.latest}
        step={bounds.stepMs}
        value={Math.round(target)}
        onChange={(event) => { setPlaying(false); setAt(Number(event.target.value)); }}
        aria-label="Scrub through fleet history"
      />
      <div className="time-machine__scale">
        <span>{stampFmt.format(new Date(bounds.earliest))}</span>
        <span>{isLive ? 'now' : `${Math.round(((bounds.latest - target) / 3600000) * 10) / 10}h ago`}</span>
        <span>{stampFmt.format(new Date(bounds.latest))}</span>
      </div>

      {error && <p className="text-hud-red">{error}</p>}

      {isLive && (
        <p className="text-hud-dim">
          Showing live. Drag the scrubber to reconstruct the office as it was.
          {bounds.eventsAvailable > 0 && ` ${bounds.eventsAvailable.toLocaleString()} events retained.`}
        </p>
      )}

      {snapshot && !isLive && (
        <>
          <div className="time-machine__stats">
            <Stat label="TASKS" value={snapshot.queue.total} />
            <Stat label="QUEUED" value={snapshot.queue.byStatus.queued ?? 0} />
            <Stat label="RUNNING" value={snapshot.queue.byStatus.inProgress ?? 0} tone="text-hud-amber" />
            <Stat label="DONE" value={snapshot.queue.byStatus.complete ?? 0} tone="text-hud-green" />
            <Stat label="QUARANTINED" value={snapshot.queue.byStatus.quarantined ?? 0} tone="text-hud-red" />
            <Stat label="AGENTS ALIVE" value={snapshot.agents.aliveCount} tone="text-hud-blue" />
          </div>

          <section className="time-machine__panel">
            <h3>COMPLETIONS PER HOUR</h3>
            <div className="time-machine__bars">
              {snapshot.throughput.map((point) => (
                <div key={point.hour} className="time-machine__bar" title={`${stampFmt.format(new Date(point.hour))} — ${point.count}`}>
                  <span style={{ height: `${(point.count / maxThroughput) * 100}%` }} />
                  <em>{stampFmt.format(new Date(point.hour)).split(' ')[0]}</em>
                </div>
              ))}
            </div>
          </section>

          <div className="time-machine__grid">
            <section className="time-machine__panel">
              <h3>WORK PER AGENT</h3>
              <table className="table">
                <thead><tr><th>Agent</th><th>Run</th><th>Queued</th><th>Done</th></tr></thead>
                <tbody>
                  {snapshot.queue.perAgent.slice(0, 10).map((entry) => (
                    <tr key={entry.agent}>
                      <td className="font-mono text-xs">{entry.agent}</td>
                      <td>{entry.inProgress ?? 0}</td>
                      <td>{entry.queued ?? 0}</td>
                      <td>{entry.complete ?? 0}</td>
                    </tr>
                  ))}
                  {snapshot.queue.perAgent.length === 0 && (
                    <tr><td colSpan={4} className="py-6 text-center text-hud-dim">No agent had work at {timeFmt.format(new Date(snapshot.at))}</td></tr>
                  )}
                </tbody>
              </table>
            </section>

            <section className="time-machine__panel">
              <h3>TRANSITIONS</h3>
              <ul className="time-machine__transitions">
                {snapshot.transitions.slice(0, 12).map((transition, index) => (
                  <li key={`${transition.at}-${index}`}>
                    <time>{timeFmt.format(new Date(transition.at))}</time>
                    <span className={`tag tag--${transition.type}`}>{transition.type.replace('task_', '')}</span>
                    <span className="truncate">{transition.agent ?? '—'}</span>
                    {transition.reason && <span className="text-hud-dim truncate">{transition.reason}</span>}
                  </li>
                ))}
                {snapshot.transitions.length === 0 && (
                  <li className="text-hud-dim">No task transitions in this window.</li>
                )}
              </ul>
            </section>
          </div>

          <p className="text-hud-dim">
            Reconstructed from {snapshot.window.eventsConsidered.toLocaleString()} retained events
            {snapshot.window.earliestEventAt
              ? ` covering back to ${stampFmt.format(new Date(snapshot.window.earliestEventAt))}`
              : ''}
            . A task&apos;s status comes from its own created/started/completed stamps, and liveness
            from heartbeats within 5 minutes of the scrubbed time.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone = 'text-hud-text' }: { label: string; value: number; tone?: string }) {
  return (
    <div className="panel-surface px-3 py-2">
      <div className="text-[10px] font-mono text-hud-dim">{label}</div>
      <div className={`mt-1 font-mono text-lg ${tone}`}>{value}</div>
    </div>
  );
}
