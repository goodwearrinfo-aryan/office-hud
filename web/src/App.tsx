import { useEffect, useState } from 'react';
import { useLive, type Summary, type Agent } from './api';
import FloorNav from './components/FloorNav';
import OfficeScene from './components/OfficeScene';
import AgentDrawer from './components/AgentDrawer';
import LedgerTimeline from './components/LedgerTimeline';
import JarvisConsole from './components/JarvisConsole';
import SessionsPanel from './components/SessionsPanel';
import ProjectsBoard from './components/ProjectsBoard';
import TradingLab from './components/TradingLab';
import StrategyLab from './components/StrategyLab';
import LiveTrading from './components/LiveTrading';
import OpsFloor from './components/OpsFloor';
import KnowledgeFloor from './components/KnowledgeFloor';
import RiskMetrics from './components/RiskMetrics';
import KnowledgeGraph from './components/KnowledgeGraph';
import CommandPalette from './components/CommandPalette';
import AlertRail from './components/AlertRail';
import OfflineBanner from './components/OfflineBanner';
import TimeMachine from './components/TimeMachine';
import ValidationFloor from './components/ValidationFloor';
import CombinedPortfolioPanel from './components/CombinedPortfolioPanel';
import Overview from './components/Overview';
import { markNative, onShellCommand, parseDeepLink } from './native';
import NativeTitleStrip from './components/NativeTitleStrip';

type FloorId = 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12' | 'f13' | 'f14' | 'f15' | 'f16';

export default function App() {
  const [floor, setFloor] = useState<FloorId>('f5');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [showHelp, setShowHelp] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  const { data: summary, error: summaryError, refresh: refreshSummary } = useLive<Summary>('/api/summary');
  const agents: Agent[] = summary?.agents ?? [];

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Native shell: enable the titlebar drag region and route the menu's
  // commands into the same state the keyboard handlers below already drive.
  useEffect(() => {
    if (!markNative()) return;
    return onShellCommand((command, payload) => {
      if (command === 'navigate' || command === 'focus-floor') {
        const floor = (payload as { floor?: string } | null)?.floor;
        if (floor) setFloor(floor as FloorId);
        return;
      }
      if (command === 'command-palette') { setShowCommandPalette(true); return; }
      if (command === 'toggle-theme') { setTheme(prev => prev === 'dark' ? 'light' : 'dark'); return; }
      if (command === 'help') { setShowHelp(true); return; }
      if (command === 'deep-link') {
        const link = parseDeepLink(String(payload));
        if (link?.floor) setFloor(link.floor as FloorId);
        if (link?.agentId) setDrawerId(link.agentId);
      }
    });
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target?.isContentEditable) return;

      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setShowCommandPalette(true);
        return;
      }

      const map: Record<string, FloorId> = {
        '1': 'f1', '2': 'f2', '3': 'f3', '4': 'f4', '5': 'f5',
        '6': 'f6', '7': 'f7', '8': 'f8', '9': 'f9', '0': 'f10',
        '-': 'f11', '=': 'f12', 'Backspace': 'f13', '.': 'f14', ',': 'f15',
      };
      if (event.key in map) setFloor(map[event.key]);

      if (event.key === '?' || (event.key === '/' && !event.ctrlKey && !event.metaKey)) {
        event.preventDefault();
        setShowHelp(true);
      }
      if (event.key === 'Escape') {
        setShowHelp(false);
        setShowCommandPalette(false);
        setDrawerId(null);
      }
      if (event.key === 't' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setTheme(prev => prev === 'dark' ? 'light' : 'dark');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const [clock, setClock] = useState(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  useEffect(() => {
    const interval = setInterval(() => setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), 1000);
    return () => clearInterval(interval);
  }, []);

  const totalCost = agents.reduce((sum, agent) => sum + (agent.usd ?? 0), 0);
  const activeCount = agents.filter(agent => agent.display === 'busy' || agent.display === 'idle').length;
  const connectionTone = summaryError
    ? 'is-error'
    : !summary
      ? 'is-connecting'
      : summary.present
        ? 'is-live'
        : 'is-offline';
  const connectionLabel = summaryError
    ? 'FEED ERROR'
    : !summary
      ? 'CONNECTING'
      : summary.present
        ? 'LIVE'
        : 'HIVE OFFLINE';
  const connectionState = summaryError
    ? { kind: 'error' as const, title: 'Live summary unavailable', detail: `The summary feed returned ${summaryError}. Floors remain available while reconnection is attempted.` }
    : !summary
      ? { kind: 'loading' as const, title: 'Connecting to hive', detail: 'Waiting for the live summary feed. Floors remain available while the connection initializes.' }
      : !summary.present
        ? { kind: 'warning' as const, title: 'Hive not detected', detail: 'The HUD is connected, but no active hive was reported by the summary feed.' }
        : null;

  const floorContent = (
    <div className="hud-floor-content flex-1 overflow-auto p-4">
      {floor === 'f1' && <SessionsPanel onSelect={setDrawerId} />}
      {floor === 'f2' && <LedgerTimeline />}
      {floor === 'f3' && (
        <div className="h-full">
          <OfficeScene
            agents={agents}
            onSelect={id => setDrawerId(id)}
            selectedId={drawerId}
          />
        </div>
      )}
      {floor === 'f4' && <ProjectsBoard onSelect={id => setDrawerId(id)} />}
      {floor === 'f5' && <JarvisConsole onSelectAgent={setDrawerId} onNavigate={setFloor} />}
      {floor === 'f6' && <TradingLab />}
      {floor === 'f7' && <StrategyLab />}
      {floor === 'f8' && <LiveTrading />}
      {floor === 'f9' && <OpsFloor />}
      {floor === 'f10' && <KnowledgeFloor />}
      {floor === 'f11' && <RiskMetrics />}
      {floor === 'f12' && <KnowledgeGraph />}
      {floor === 'f13' && <TimeMachine />}
      {floor === 'f14' && <ValidationFloor />}
      {floor === 'f15' && <CombinedPortfolioPanel />}
      {floor === 'f16' && <Overview onNavigate={setFloor} />}
    </div>
  );

  return (
    <div className="hud-app flex flex-col bg-hud-bg text-hud-text font-ui" aria-busy={!summary && !summaryError}>
      <NativeTitleStrip label={summary?.label} tone={connectionTone} connectionLabel={connectionLabel} />
      <header className="hud-topbar">
        <div className="hud-brand">
          <span className="hud-brand-mark" aria-hidden="true">OF</span>
          <span className="hud-brand-copy">
            <span className="hud-brand-title">JARVIS</span>
            <span className="hud-brand-subtitle">Personal Operations Core</span>
          </span>
        </div>

        <div className="hud-context">
          <div className="hud-context-primary">
            <span className="hud-context-label">{summary?.label ?? (summaryError ? 'Summary unavailable' : 'Awaiting summary')}</span>
            {summary?.hive && (
              <>
                <span className="hud-context-divider">/</span>
                <span className="hud-context-location" title={summary.hive}>{summary.hive.replace(/^\/Users\/[^/]+\//, '~/')}</span>
              </>
            )}
          </div>
          <div className="hud-context-secondary">
            <span className="hud-clock">{clock}</span>
            <span className={`hud-connection ${connectionTone}`} role="status" aria-label={`Connection status: ${connectionLabel}`}>
              <span className="hud-connection-dot" aria-hidden="true" />
              {connectionLabel}
            </span>
            <span className="hud-context-cost">{summary ? `$${totalCost.toFixed(2)}` : '—'}</span>
          </div>
        </div>

        <div className="hud-header-actions">
          <span className="hud-header-stats">
            <strong>{summary ? activeCount : '—'}</strong> active / {summary ? agents.length : '—'} total
          </span>
          <div className="hud-control-group">
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              aria-pressed={theme === 'dark'}
              title="Toggle theme (⌘T / Ctrl+T)"
            >
              <span className="hud-theme-mark" aria-hidden="true">{theme === 'dark' ? 'D' : 'L'}</span>
              <span className="hud-control-label">{theme === 'dark' ? 'Dark' : 'Light'}</span>
            </button>
            <button type="button" className="theme-toggle" onClick={() => setShowCommandPalette(true)} title="Command palette (⌘K / Ctrl+K)">
              <span className="hud-control-key">⌘K</span>
              <span className="hud-control-label">Search</span>
            </button>
            <button type="button" className="theme-toggle" onClick={() => setShowHelp(true)} title="Keyboard shortcuts (?)">
              <span className="hud-control-key">?</span>
              <span className="hud-control-label">Help</span>
            </button>
          </div>
        </div>
      </header>

      <OfflineBanner />

      {connectionState && (
        <section
          className={`hud-connection-banner is-${connectionState.kind}`}
          role={connectionState.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="hud-banner-icon" aria-hidden="true">{connectionState.kind === 'loading' ? '…' : '!'}</span>
          <span className="hud-banner-copy">
            <span className="hud-banner-title">{connectionState.title}</span>
            <span className="hud-banner-detail">{connectionState.detail}</span>
          </span>
          <button type="button" className="btn btn-ghost hud-banner-action" onClick={refreshSummary}>Retry now</button>
        </section>
      )}

      <div className="hud-main" role="main">
        <FloorNav current={floor} onChange={setFloor} summary={summary} />
        <div className="hud-content">
          {floorContent}
          <AlertRail />
        </div>
      </div>

      {drawerId && (
        <AgentDrawer
          agentId={drawerId}
          summary={agents.find(agent => agent.id === drawerId)}
          onClose={() => setDrawerId(null)}
        />
      )}

      {showCommandPalette && (
        <CommandPalette onClose={() => setShowCommandPalette(false)} agents={agents} />
      )}

      {showHelp && (
        <div className="help-modal" onClick={() => setShowHelp(false)}>
          <section
            className="help-modal-content"
            role="dialog"
            aria-modal="true"
            aria-labelledby="keyboard-shortcuts-title"
            onClick={event => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="keyboard-shortcuts-title" className="font-mono text-hud-amber text-lg">Keyboard Shortcuts</h2>
              <button type="button" className="btn btn-ghost modal-close" onClick={() => setShowHelp(false)} aria-label="Close keyboard shortcuts">×</button>
            </div>
            <div className="hud-help-grid">
              <div className="hud-shortcut"><kbd>1–0</kbd><span>Floors F1–F10</span></div>
              <div className="hud-shortcut"><kbd>- / =</kbd><span>F11 Risk · F12 Graph</span></div>
              <div className="hud-shortcut"><kbd>Backspace</kbd><span>Floor F13 · Time Machine</span></div>
              <div className="hud-shortcut"><kbd>. / ,</kbd><span>F14 Validation · F15 Combined</span></div>
              <div className="hud-shortcut"><kbd>?</kbd><span>Open this help</span></div>
              <div className="hud-shortcut"><kbd>Esc</kbd><span>Close modal or drawer</span></div>
              <div className="hud-shortcut"><kbd>⌘T</kbd><span>Toggle theme</span></div>
              <div className="hud-shortcut"><kbd>⌘K</kbd><span>Command palette</span></div>
            </div>
            <div className="hud-help-footer">
              Floors: F1 Sessions · F2 Ledger · F3 Agents · F4 Projects · F5 HQ · F6 Trading Lab · F7 Strategy Lab · F8 Live Trading · F9 24x7 Ops · F10 Knowledge · F11 Risk Metrics · F12 Knowledge Graph · F13 Time Machine · F14 Validation · F15 Combined
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
