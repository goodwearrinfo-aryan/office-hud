import { useEffect, useState } from 'react';
import { useConnectionStatus } from './api';

/**
 * Registers the service worker and reports reachability. Three states, because
 * they need different wording: live, reconnecting, and serving cached data
 * because the server is unreachable.
 */
export default function OfflineBanner() {
  const status = useConnectionStatus();
  const [cached, setCached] = useState(false);
  const [navigatorOffline, setNavigatorOffline] = useState(!navigator.onLine);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);

  useEffect(() => {
    const goOnline = () => setNavigatorOffline(false);
    const goOffline = () => setNavigatorOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    if (status.state !== 'live' && !navigatorOffline) setCached(true);
    if (status.state === 'live') setCached(false);
  }, [status.state, navigatorOffline]);

  if (status.state === 'live' && !navigatorOffline) return null;

  const hard = navigatorOffline || (cached && status.state === 'offline');
  const label = navigatorOffline
    ? 'NO NETWORK — showing cached data'
    : status.state === 'connecting'
      ? 'RECONNECTING to the HUD server…'
      : 'SERVER UNREACHABLE — showing cached data';

  return (
    <div className={`offline-banner ${hard ? 'offline-banner--hard' : ''}`} role="status">
      <span>{label}</span>
      <button type="button" onClick={() => window.location.reload()}>reload</button>
    </div>
  );
}
