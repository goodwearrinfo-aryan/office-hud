import { useResource, useConnectionStatus, useViewers, liveStore } from '../api';
import type { LiveStatus } from '../api';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function ago(ms: number | null): string {
  if (!ms) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/**
 * Makes the push layer observable. When a panel looks stale this says whether
 * the socket is up, whether anything else is watching, and when each resource
 * last changed -- which is the difference between "the hive is quiet" and "the
 * stream is broken".
 */
export default function StreamStatus() {
  const status = useConnectionStatus();
  const viewers = useViewers();
  const { data } = useResource<LiveStatus>('streamStatus');

  const state = data?.state ?? status.state;
  const stale = state !== 'live';

  return (
    <section className="stream-status" aria-label="Live stream status">
      <div className="stream-status__row">
        <span className={`stream-status__dot is-${state}`} aria-hidden="true" />
        <span className="stream-status__label">
          STREAM {state.toUpperCase()}
          {status.detail ? ` -- ${status.detail}` : ''}
        </span>
        <span className="stream-status__meta">
          {state === 'live' ? `connected ${ago(status.since)}` : `since ${timeFmt.format(new Date(status.since))}`}
        </span>
      </div>

      <div className="stream-status__row stream-status__row--meta">
        <span title="WebSocket messages pushed to this tab">
          pushed {data?.stats?.pushes ?? 0} · publishes {data?.stats?.publishes ?? 0}
        </span>
        <span title="seq is the server's push counter; it must advance while the hive moves">
          seq {data?.sequence ?? '--'}
        </span>
        <span title="Other tabs connected to the same server">
          viewers {viewers.length}
        </span>
        <span title="Resources this tab is subscribed to">
          keys {viewers.find((v) => v.label === liveStore.getStatus().detail)?.keys.length ?? '--'}
        </span>
      </div>

      {viewers.length > 1 && (
        <ul className="stream-status__viewers">
          {viewers.map((viewer) => (
            <li key={viewer.id}>
              {viewer.label || viewer.id}
              {viewer.floor ? ` · ${viewer.floor}` : ''}
              <span className="text-hud-dim"> ({viewer.keys.length} keys)</span>
            </li>
          ))}
        </ul>
      )}

      {stale && (
        <p className="stream-status__hint">
          Panels fall back to polling every 20s while the socket is down and keep showing the last
          known values. Reconnect attempts back off up to 30s.
        </p>
      )}
    </section>
  );
}
