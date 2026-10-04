import React from 'react';
import { useEffect, useState } from 'react';
import { useLive, type Summary, type Agent } from './api';
import FloorNav from './components/FloorNav';
import AutopilotPanel from './components/AutopilotPanel';
import FleetPerformancePanel from './components/FleetPerformancePanel';
import GodPanel from './components/GodPanel';
import FleetFloor from './components/FleetFloor';
import FloorTable from './components/FloorTable';
import FloorProbeStatus from './components/FloorProbeStatus';
import OfficeScene from './components/OfficeScene';
import AgentDrawer from './components/AgentDrawer';
import LedgerTimeline from './components/LedgerTimeline';
import ExecutiveHQ from './components/ExecutiveHQ';
import SessionsPanel from './components/SessionsPanel';
import ProjectsBoard from './components/ProjectsBoard';
import TradingLab from './components/TradingLab';
import StrategyLab from './components/StrategyLab';
import LiveTrading from './components/LiveTrading';
import OpsFloor from './components/OpsFloor';
import KnowledgeFloor from './components/KnowledgeFloor';
import RiskMetrics from './components/RiskMetrics';
import KnowledgeGraph from './components/KnowledgeGraph';
import GodConsole from './components/GodConsole';
import CommandPalette from './components/CommandPalette';
import TimeMachine from './components/TimeMachine';
import ValidationFloor from './components/ValidationFloor';
import CombinedPortfolioPanel from './components/CombinedPortfolioPanel';
import Overview from './components/Overview';
import OfflineBanner from './components/OfflineBanner';
import StreamStatus from './components/StreamStatus';
import GlobalSearch from './components/GlobalSearch';
import AlphaInsiderPanel from './components/AlphaInsiderPanel';
import AutonomyPanel from './components/AutonomyPanel';
import JarvisConsole from './components/JarvisConsole';
import AlertRail from './components/AlertRail';
import ExportButton from './components/ExportButton';
import NativeTitleStrip, { type NativeConnectionTone } from './components/NativeTitleStrip';
import { markNative, onShellCommand, parseDeepLink } from './native';
import { useConnectionStatus } from './api';

class ErrorBoundary extends React.Component<any, { hasError: boolean }> {
      constructor(props: any) {
       super(props);
       this.state = { hasError: false };
     }
     public static getDerivedStateFromError(_error: unknown): { hasError: true } {
       return { hasError: true };
     }

     public componentDidCatch(_error: unknown, errorInfo: React.ErrorInfo) {
       console.error('Error caught by boundary:', _error, errorInfo);
     }

     public render() {
       if (this.state.hasError) {
         return <div className="panel p-4 text-hud-red">Something went wrong with this floor.</div>;
       }

       return this.props.children;
     }
   }

type FloorId = 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12' | 'f13' | 'f14' | 'f15' | 'f16' | 'f17';

export default function App() {
  const [floor, setFloor] = useState<FloorId>('f3');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [showHelp, setShowHelp] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [godConsoleOpen, setGodConsoleOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [jarvisOpen, setJarvisOpen] = useState(false);

  const { data: summary } = useLive<Summary>('/api/summary');
  const agents: Agent[] = summary?.agents ?? [];

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Native shell: enable the titlebar drag region and route the menu's
  // commands into the same state the keyboard handlers below already drive.
  // Everything here is a no-op in a browser, where isNative() is false.
  const connection = useConnectionStatus();
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

  // The strip reports the push layer, not the last successful poll. A stale
  // payload and a dead socket look identical in the body, and they are exactly
  // the cases an operator serving the HUD locally needs to tell apart.
  const connectionTone: NativeConnectionTone =
    connection.state === 'live' ? 'is-live'
    : connection.state === 'connecting' ? 'is-connecting'
    : 'is-offline';
  const connectionLabel =
    connection.state === 'live' ? 'LIVE'
    : connection.state === 'connecting' ? 'CONNECTING'
    : 'OFFLINE';

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Command palette
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommandPalette(true);
        return;
      }

      // Floor navigation
      //
      // F1-F10 on the number row, F11-F12 on the only keys still free. F13-F16
      // get a two-key sequence rather than stealing a binding an operator
      // already uses: a floor reachable only by clicking the nav is reachable,
      // but a floor whose shortcut silently overrode an existing one would not
      // be. `[` then the digit, so `[3` is F13 and `[4` is F14.
      let pendingBracket = false;
      const map: Record<string, FloorId> = {
        '1': 'f1', '2': 'f2', '3': 'f3', '4': 'f4', '5': 'f5',
        '6': 'f6', '7': 'f7', '8': 'f8', '9': 'f9', '0': 'f10',
        '-': 'f11', '=': 'f11', 'Backspace': 'f12',
      };
      if (pendingBracket) {
        pendingBracket = false;
        const high: Record<string, FloorId> = { '3': 'f13', '4': 'f14', '5': 'f15', '6': 'f16', '7': 'f17' };
        if (e.key in high) { e.preventDefault(); setFloor(high[e.key]); return; }
      }
      if (e.key === '[') { pendingBracket = true; return; }
      if (e.key in map) setFloor(map[e.key]);

      // Special keys
      if (e.key === 'g' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setGodConsoleOpen(true); return; }
      if (e.key === 'j' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setJarvisOpen(true); return; }
      if (e.key === 'f' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setSearchOpen(true); return; }
      if (e.key === '?' || (e.key === '/' && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); setShowHelp(true); }
      if (e.key === 'Escape') { setShowHelp(false); setShowCommandPalette(false); setGodConsoleOpen(false); setSearchOpen(false); setJarvisOpen(false); setDrawerId(null); }
      if (e.key === 't' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setTheme(prev => prev === 'dark' ? 'light' : 'dark'); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Live clock
  const [clock, setClock] = useState(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  useEffect(() => {
    const iv = setInterval(() => setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), 1000);
    return () => clearInterval(iv);
  }, []);

  const totalCost = agents.reduce((n, a) => n + (a.usd ?? 0), 0);
  const activeCount = agents.filter((a) => a.display === 'busy' || a.display === 'idle').length;

  const floorContent = (
     <ErrorBoundary>
       <div className="flex-1 overflow-auto p-4">
      {floor === 'f1' && (
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0"><SessionsPanel onSelect={setDrawerId} /></div>
          <ExportButton type="agents" label="Export roster" agents={agents} summary={summary ?? undefined} />
        </div>
      )}
      {floor === 'f2' && <LedgerTimeline />}
      {floor === 'f3' && (
        <div className="h-full">
          <OfficeScene
            agents={agents}
            onSelect={(id) => setDrawerId(id)}
            selectedId={drawerId}
          />
        </div>
      )}
      {floor === 'f4' && <ProjectsBoard onSelect={(id) => setDrawerId(id)} />}
      {floor === 'f5' && <ExecutiveHQ />}
      {floor === 'f6' && <TradingLab />}
      {floor === 'f7' && <StrategyLab />}
      {floor === 'f8' && <LiveTrading />}
      {floor === 'f9' && (
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <OpsFloor />
            {/* The two floor views answer different questions and both belong on
                the ops floor: FloorTable is the roster rollup (who claims a
                floor), FloorProbeStatus is what the hive's own probe measured
                (is the manager alive, is the status file fresh). Neither
                substitutes for the other. */}
            <div className="mt-6"><FloorTable /></div>
            <div className="mt-4"><FloorProbeStatus /></div>
            {/* Was written against /api/autopilot/snapshot and mounted nowhere, so
                the proposals the autopilot raises had no surface at all. */}
            <div className="mt-4"><AutopilotPanel /></div>
          </div>
          <AlertRail />
        </div>
      )}
      {floor === 'f10' && <KnowledgeFloor />}
      {floor === 'f11' && <RiskMetrics />}
      {floor === 'f12' && <KnowledgeGraph />}
      {floor === 'f13' && <TimeMachine />}
      {floor === 'f14' && <ValidationFloor />}
      {floor === 'f15' && <CombinedPortfolioPanel />}
      {floor === 'f16' && <Overview onNavigate={setFloor} />}
      {floor === 'f17' && <FleetFloor />}
      {floor === 'f16' && (
        <div className="mt-6 grid grid-cols-1 xl:grid-cols-2 gap-4">
          <AlphaInsiderPanel />
          <AutonomyPanel />
          {/* Both read live payloads and were mounted nowhere. GodPanel is the
              leadership tile (the god agent's own detail); FleetPerformancePanel
              is the per-agent efficiency rollup. */}
          <GodPanel />
          <FleetPerformancePanel />
        </div>
      )}
    </div>
    </ErrorBoundary>
  );

  return (
    <div className="h-screen w-screen flex flex-col bg-hud-bg text-hud-text font-ui">
      {/* Reachability: unreachable server, or serving cache */}
      <OfflineBanner />

      {/* Native shell chrome. Null in a browser, so the web build is unchanged. */}
      <NativeTitleStrip
        label={summary?.label ?? null}
        tone={connectionTone}
        connectionLabel={connectionLabel}
      />

      {/* Top Bar */}
      <header className="h-12 flex items-center justify-between px-4 border-b border-hud-edge bg-hud-panel">
        <div className="flex items-center gap-3">
          <span className="text-lg font-mono text-hud-amber">OF▦</span>
          <span className="font-semibold tracking-tight">Office HUD</span>
          <StreamStatus />
        </div>
        <div className="flex-1 flex items-center justify-center gap-4 text-xs text-hud-dim">
          <span className="font-mono text-hud-dim max-w-xs truncate">
            {summary?.label ?? 'no hive'} · {summary?.hive?.replace(/^\/Users\/[^/]+\//, '~/') ?? '—'}
          </span>
          <span className="font-mono tabular-nums">{clock}</span>
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${summary?.present ? 'bg-hud-green live-dot' : 'bg-hud-red'}`} />
            {summary?.present ? 'LIVE' : 'HIVE MISSING'}
          </span>
          <span className="font-mono text-hud-amber">${totalCost.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-hud-dim">
          <span className="font-mono text-hud-dim">{activeCount} active / {agents.length} total</span>
          <button className="theme-toggle" onClick={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')} title="Toggle theme (⌘T)">
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button className="theme-toggle" onClick={() => setShowCommandPalette(true)} title="Command Palette (⌘K)">
            ⌘K
          </button>
          <button className="theme-toggle" onClick={() => setShowHelp(true)} title="Shortcuts (?)">
            ?
          </button>
          <button className="theme-toggle" onClick={() => setGodConsoleOpen(true)} title="God Console (⌘G)">
            ⌘G
          </button>
          <button className="theme-toggle" onClick={() => setJarvisOpen(true)} title="Jarvis console (⌘J)">
            ⌘J
          </button>
          <button className="theme-toggle" onClick={() => setSearchOpen(true)} title="Search everything (⌘F)">
            ⌘F
          </button>
        </div>
      </header>

      {/* Main */}
      <div className="flex-1 flex overflow-hidden">
        <FloorNav current={floor} onChange={setFloor} summary={summary} />
        {floorContent}
      </div>

      {/* Agent Drawer */}
      {drawerId && (
        <AgentDrawer
          agentId={drawerId}
          summary={agents.find((a) => a.id === drawerId)}
          onClose={() => setDrawerId(null)}
        />
      )}

      {/* God Console */}
      {godConsoleOpen && <GodConsole onClose={() => setGodConsoleOpen(false)} />}

      {/* Jarvis console */}
      {jarvisOpen && (
        <JarvisConsole
          onSelectAgent={(id) => { setJarvisOpen(false); setDrawerId(id); }}
          onNavigate={(f) => { setJarvisOpen(false); setFloor(f); }}
        />
      )}

      {/* Global search */}
      {searchOpen && (
        <GlobalSearch
          onSelectAgent={(id) => { setSearchOpen(false); setDrawerId(id); }}
        />
      )}

      {/* Command Palette */}
      {showCommandPalette && (
        <CommandPalette onClose={() => setShowCommandPalette(false)} agents={agents} />
      )}

      {/* Help modal */}
      {showHelp && (
        <div className="help-modal" onClick={() => setShowHelp(false)}>
          <div className="help-modal-content" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-mono text-hud-amber text-lg">Keyboard Shortcuts</h2>
              <button onClick={() => setShowHelp(false)} className="text-hud-dim hover:text-hud-text text-xl">×</button>
            </div>
            <div className="space-y-2 text-sm text-hud-dim font-mono">
              <div className="grid grid-cols-2 gap-4">
                <div><kbd className="bg-hud-edge px-2 py-0.5 rounded">1-0</kbd> Floors F1–F10</div>
                <div><kbd className="bg-hud-edge px-2 py-0.5 rounded">- / =</kbd> Floor F11 (Risk)</div>
                <div><kbd className="bg-hud-edge px-2 py-0.5 rounded">Backspace</kbd> Floor F12 (Graph)</div>
                <div><kbd className="bg-hud-edge px-2 py-0.5 rounded">[</kbd> then <kbd className="bg-hud-edge px-2 py-0.5 rounded">3</kbd>–<kbd className="bg-hud-edge px-2 py-0.5 rounded">6</kbd> Floors F13–F16</div>
                <div><kbd className="bg-hud-edge px-2 py-0.5 rounded">?</kbd> This help</div>
                <div><kbd className="bg-hud-edge px-2 py-0.5 rounded">Esc</kbd> Close modal/drawer</div>
                <div><kbd className="bg-hud-edge px-2 py-0.5 rounded">⌘T</kbd> Toggle theme</div>
                <div><kbd className="bg-hud-edge px-2 py-0.5 rounded">⌘K</kbd> Command palette</div>
                <div><kbd className="bg-hud-edge px-2 py-0.5 rounded">⌘G</kbd> God console</div>
                <div><kbd className="bg-hud-edge px-2 py-0.5 rounded">Click desk</kbd> Open agent drawer</div>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-hud-edge text-[10px] text-hud-dim">
              Floors: F1 Sessions · F2 Ledger · F3 Agents · F4 Projects · F5 HQ · F6 Trading Lab · F7 Strategy Lab · F8 Live Trading · F9 24x7 Ops · F10 Knowledge · F11 Risk Metrics · F12 Knowledge Graph · F13 Time Machine · F14 Validation · F15 Combined Portfolio · F16 Overview
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
