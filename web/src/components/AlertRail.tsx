import { useMemo, useState } from 'react';
import {
  acknowledgeAlert,
  acknowledgeAllAlerts,
  useResource,
  type Alert,
  type AlertSummary,
  type ResolvedAlert,
} from '../api';
import StreamStatus from './StreamStatus';
import AutonomyPanel from './AutonomyPanel';

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'CRIT',
  warn: 'WARN',
  info: 'INFO',
};

function ago(ms: number | null | undefined): string {
  if (!ms) return '--';
  const diff = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Always-visible anomaly rail. Rides the socket, so a new alert appears without
 * a refetch, and acknowledgement round-trips to the server (which owns the ack
 * set, so it survives a reload).
 */
export default function AlertRail() {
  const { data, error, updatedAt } = useResource<AlertSummary>('alerts');
  const [filter, setFilter] = useState<'unacked' | 'all'>('unacked');
  const [expanded, setExpanded] = useState<string | null>(null);

  const alerts = data?.alerts ?? [];
  const visible = useMemo(
    () => (filter === 'unacked' ? alerts.filter((alert) => !alert.acknowledged) : alerts),
    [alerts, filter]
  );
  const counts = data?.counts ?? { critical: 0, warn: 0, info: 0 };
  const unacknowledged = data?.unacknowledged ?? 0;

  return (
    <aside className="alert-rail" aria-label="Anomaly alerts">
      <div className="alert-rail__head">
        <span className="alert-rail__title">ALERTS</span>
        <span className="alert-rail__counts">
          <span className={`chip chip--critical ${counts.critical ? '' : 'chip--zero'}`}>{counts.critical}</span>
          <span className={`chip chip--warn ${counts.warn ? '' : 'chip--zero'}`}>{counts.warn}</span>
          <span className={`chip chip--info ${counts.info ? '' : 'chip--zero'}`}>{counts.info}</span>
        </span>
        <span className="alert-rail__spacer" />
        <button
          type="button"
          className="alert-rail__toggle"
          onClick={() => setFilter((current) => (current === 'unacked' ? 'all' : 'unacked'))}
          aria-pressed={filter === 'all'}
        >
          {filter === 'unacked' ? `showing ${unacknowledged} unacked` : `showing all ${alerts.length}`}
        </button>
        {unacknowledged > 0 && (
          <button type="button" className="alert-rail__ackall" onClick={() => { void acknowledgeAllAlerts(); }}>
            ack all
          </button>
        )}
      </div>

      <AutonomyPanel />
      <StreamStatus />

      {error && <p className="alert-rail__error">{error}</p>}

      <ul className="alert-rail__list">
        {visible.length === 0 && (
          <li className="alert-rail__empty">
            {alerts.length === 0 ? 'No anomalies detected.' : 'Everything acknowledged.'}
          </li>
        )}
        {visible.map((alert) => (
          <AlertRow
            key={alert.fingerprint}
            alert={alert}
            open={expanded === alert.fingerprint}
            onToggle={() => setExpanded((current) => (current === alert.fingerprint ? null : alert.fingerprint))}
          />
        ))}
      </ul>

      {data?.history && data.history.length > 0 && (
        <details className="alert-rail__history">
          <summary>{data.history.length} recently resolved</summary>
          <ul>
            {data.history.slice(0, 6).map((alert: ResolvedAlert) => (
              <li key={`${alert.fingerprint}-${alert.resolvedAt}`}>
                <span className="text-hud-dim">{ago(alert.resolvedAt)}</span> {alert.title}
              </li>
            ))}
          </ul>
        </details>
      )}

      {updatedAt && <p className="alert-rail__stamp">checked {clockTime(updatedAt)}</p>}
    </aside>
  );
}

function AlertRow({ alert, open, onToggle }: { alert: Alert; open: boolean; onToggle: () => void }) {
  const active = !alert.acknowledged;
  return (
    <li className={`alert alert--${alert.severity} ${active ? '' : 'alert--acked'}`}>
      <button type="button" className="alert__head" onClick={onToggle} aria-expanded={open}>
        <span className={`alert__sev alert__sev--${alert.severity}`}>{SEVERITY_LABEL[alert.severity]}</span>
        <span className="alert__title">{alert.title}</span>
        <span className="alert__age">{ago(active ? alert.lastSeen : alert.acknowledgedAt)}</span>
      </button>
      {open && (
        <div className="alert__body">
          <p>{alert.detail}</p>
          <p className="alert__meta">
            {alert.analyzer}
            {alert.metric ? ` · ${alert.metric}=${alert.value}` : ''}
            {' · first seen '}{ago(alert.firstSeen)}
            {' · last seen '}{clockTime(alert.lastSeen)}
          </p>
          <button
            type="button"
            className="alert__ack"
            onClick={() => { void acknowledgeAlert(alert.fingerprint, !alert.acknowledged); }}
          >
            {alert.acknowledged ? 'unacknowledge' : 'acknowledge'}
          </button>
        </div>
      )}
    </li>
  );
}
