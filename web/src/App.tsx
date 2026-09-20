import { useEffect, useState } from 'react';
import { useLive, type Summary, type Agent } from './api';
import FloorNav from './components/FloorNav';
import OfficeScene from './components/OfficeScene';
import AgentDrawer from './components/AgentDrawer';
import LedgerTimeline from './components/LedgerTimeline';
import ExecutiveHQ from './components/ExecutiveHQ';
import SessionsPanel from './components/SessionsPanel';
import ProjectsBoard from './components/ProjectsBoard';

type FloorId = 'f1' | 'f2' | 'f3' | 'f4' | 'f5';

export default function App() {
  const [floor, setFloor] = useState<FloorId>('f3');
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const { data: summary } = useLive<Summary>('/api/summary');
  const agents: Agent[] = summary?.agents ?? [];

  // keyboard 1-5
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const map: Record<string, FloorId> = { '1': 'f1', '2': 'f2', '3': 'f3', '4': 'f4', '5': 'f5' };
      if (e.key in map) setFloor(map[e.key]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const totalCost = agents.reduce((n, a) => n + (a.usd ?? 0), 0);
  const activeCount = agents.filter((a) => !a.archived).length;

  const floorContent = (
    <div className="flex-1 overflow-auto p-4">
      {floor === 'f1' && <SessionsPanel />}
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
    </div>
  );

  return (
    <div className="h-screen w-screen flex flex-col">
      {/* top bar */}
      <header className="h-12 flex items-center justify-between px-4 border-b border-hud-edge bg-hud-panel">
        <div className="flex items-center gap-3">
          <span className="text-lg font-mono text-hud-amber">OF▦</span>
          <span className="font-semibold tracking-tight">Office HUD</span>
        </div>
        <div className="flex-1 flex items-center justify-center gap-4 text-xs text-hud-dim">
          <span className="font-mono font-mono text-hud-dim max-w-xs truncate">
            {summary?.hive?.replace(/^\/Users\/[^/]+\//, '~/') ?? 'no hive'}
          </span>
          <span className="font-mono tabular-nums">{clock}</span>
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${summary?.present ? 'bg-hud-green live-dot' : 'bg-hud-red'}`} />
            {summary?.present ? 'LIVE' : 'HIVE MISSING'}
          </span>
          <span className="font-mono text-hud-amber">${totalCost.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-hud-dim">
          <span className="font-mono text-hud-dim">{activeCount} active / {agents.length} total</span>
        </div>
      </header>

      {/* main */}
      <div className="flex-1 flex overflow-hidden">
        <FloorNav current={floor} onChange={setFloor} summary={summary} />
        {floorContent}
      </div>

      {/* drawer */}
      {drawerId && (
        <AgentDrawer
          agentId={drawerId}
          summary={agents.find((a) => a.id === drawerId)}
          onClose={() => setDrawerId(null)}
        />
      )}
    </div>
  );
}