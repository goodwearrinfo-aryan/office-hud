import { useMemo, useState } from 'react';
import type { Agent } from '../api';
import { DISPLAY_STATES, describeRoster, isKnownDisplay, statusColorFor } from '../displayStates';

interface Props {
  agents: Agent[];
  onSelect: (id: string) => void;
  selectedId?: string | null;
}


function groupAgents(agents: Agent[]) {
  const groups = new Map<string, Agent[]>();
  for (const agent of agents) {
    let label = 'Other';
    if (agent.isGod || ['office-manager', 'mainbot'].includes(agent.id)) label = 'Leadership';
    else if (/^F\d+$/i.test(agent.id)) label = 'Floor Managers';
    else if (/^pm-/i.test(agent.id)) label = 'PM Desk';
    else if (/^specialist-/i.test(agent.id)) label = 'Specialists';
    else if (/^worker-/i.test(agent.id)) label = 'Workers';
    groups.set(label, [...(groups.get(label) || []), agent]);
  }
  const order = ['Leadership', 'Floor Managers', 'PM Desk', 'Specialists', 'Workers', 'Other'];
  return order.filter(label => groups.has(label)).map(label => ({ label, agents: groups.get(label) || [] }));
}

function ageLabel(seconds: number | null) {
  if (seconds == null) return 'offline';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function ModelBadge({ agent }: { agent: Agent }) {
  if (!agent.provider && !agent.model) return null;
  return (
    <span className="text-[9px] font-mono text-hud-dim px-1.5 py-0.5 rounded bg-hud-edge truncate max-w-full">
      {agent.provider || 'auto'}:{(agent.model || 'auto').split('/').pop()}
    </span>
  );
}

function AgentPod({ agent, selected, onSelect }: { agent: Agent; selected: boolean; onSelect: () => void }) {
  // statusColor(), not STATUS_COLORS[...]: an unrecognised state must not read
  // as undefined and leave the pod unlit with no explanation.
  const color = statusColorFor(agent.display);
  return (
    <button
      onClick={onSelect}
      className={`text-left rounded-lg border p-3 transition-colors ${selected ? 'border-hud-amber bg-hud-amber/10' : 'border-hud-edge bg-hud-panel hover:border-hud-dim'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-xs text-hud-text truncate">{agent.name}</div>
          <div className="text-[9px] text-hud-dim truncate">{agent.id}</div>
        </div>
        <div className="w-10 h-7 rounded bg-black/30 border border-hud-edge p-1 shrink-0">
          <div className="w-full h-full rounded-sm" style={{ background: color, boxShadow: `0 0 8px ${color}99` }} />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[9px] font-mono uppercase" style={{ color }}>{agent.display}</span>
        <ModelBadge agent={agent} />
      </div>
      {agent.currentTaskTitle && <div className="mt-2 text-[10px] text-hud-dim truncate">{agent.currentTaskTitle}</div>}
    </button>
  );
}

export default function OfficeScene({ agents, onSelect, selectedId }: Props) {
  const [activeOnly, setActiveOnly] = useState(false);
  const god = agents.find(agent => agent.isGod);
  const workers = agents.filter(agent => !agent.isGod);
  const visibleWorkers = activeOnly ? workers.filter(agent => agent.display === 'busy' || agent.display === 'idle') : workers;
  const groups = useMemo(() => groupAgents(visibleWorkers), [visibleWorkers]);

  return (
    <div className="h-full overflow-auto panel">
      <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-2.5 border-b border-hud-edge bg-hud-panel">
        <div>
          <div className="font-mono text-xs tracking-widest text-hud-dim">FLOOR F3 · THE OFFICE</div>
          <div className="text-[10px] text-hud-dim mt-0.5">{describeRoster(workers)}</div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex gap-3 text-[10px] font-mono text-hud-dim">
            {/* Driven by DISPLAY_STATES, not by the colour map's keys, so the
                legend cannot fall behind the states the server can emit. */}
            {DISPLAY_STATES.map(status => (
              <span key={status} className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full inline-block" style={{ background: statusColorFor(status) }} />{status}</span>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[10px] font-mono text-hud-dim">
            <input type="checkbox" checked={activeOnly} onChange={event => setActiveOnly(event.target.checked)} />
            active only (hides stale, breaker, offline)
          </label>
        </div>
      </div>

      <div className="p-4 space-y-5">
        {god && (
          <section>
            <div className="font-mono text-[10px] tracking-widest text-hud-dim mb-2">CORNER OFFICE</div>
            <div className="max-w-sm">
              <AgentPod agent={god} selected={selectedId === god.id} onSelect={() => onSelect(god.id)} />
            </div>
          </section>
        )}

        {groups.map(group => (
          <section key={group.label}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[10px] tracking-widest text-hud-dim">{group.label.toUpperCase()}</span>
              <span className="text-[10px] font-mono text-hud-dim">{group.agents.length}</span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(165px,1fr))] gap-2">
              {group.agents.map(agent => (
                <AgentPod key={agent.id} agent={agent} selected={selectedId === agent.id} onSelect={() => onSelect(agent.id)} />
              ))}
            </div>
          </section>
        ))}

        {groups.length === 0 && <div className="py-8 text-center text-hud-dim text-sm">No live agents</div>}

        <section className="pt-2">
          <div className="font-mono text-[10px] tracking-widest text-hud-dim mb-2">AGENT LIST</div>
          <div className="table-container rounded-lg border border-hud-edge">
            <table className="table">
              <thead>
                <tr><th>Agent</th><th>Status</th><th>Task</th><th>Heartbeat</th><th>Provider</th></tr>
              </thead>
              <tbody>
                {(activeOnly ? workers.filter(agent => agent.display === 'busy' || agent.display === 'idle') : workers).map(agent => (
                  <tr
                    key={agent.id}
                    className="cursor-pointer"
                    onClick={() => onSelect(agent.id)}
                    /* Reachable by keyboard: the row is the primary nav for F3. */
                    tabIndex={0}
                    role="button"
                    aria-label={`Open ${agent.name} (${agent.display})`}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelect(agent.id);
                      }
                    }}
                  >
                    <td className="text-hud-text">{agent.name}</td>
                    <td style={{ color: statusColorFor(agent.display) }}>
                      {agent.display}
                      {!isKnownDisplay(agent.display) && (
                        <span className="ml-1 text-[9px] text-hud-amber">NOT RECOGNISED</span>
                      )}
                    </td>
                    <td className="max-w-[300px] truncate">{agent.currentTaskTitle || agent.currentTaskId || '—'}</td>
                    <td>{ageLabel(agent.heartbeatAgeSec)}</td>
                    <td>{agent.provider || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
