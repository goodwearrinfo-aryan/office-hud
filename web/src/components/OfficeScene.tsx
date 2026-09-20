import type { Agent } from '../api';

// The hero: an SVG office floor. God sits in the corner office; workers at pods.
// Click any desk -> drawer. Monitor color = live status.

interface Props {
  agents: Agent[];
  onSelect: (id: string) => void;
  selectedId?: string | null;
}

const WORKER_SLOTS = [
  { x: 90, y: 300 }, { x: 260, y: 300 }, { x: 430, y: 300 }, { x: 600, y: 300 },
  { x: 175, y: 465 }, { x: 345, y: 465 }, { x: 515, y: 465 },
];

function WorkerDesk({ a, x, y, onSelect }: { a: Agent; x: number; y: number; onSelect: (id: string) => void }) {
  return (
    <g className="desk" transform={`translate(${x},${y})`} onClick={() => onSelect(a.id)}>
      <title>{`${a.name} — ${a.display}${a.inboxBacklog ? ` · ${a.inboxBacklog} unread` : ''}`}</title>
      {/* shadow */}
      <ellipse cx={65} cy={92} rx={72} ry={12} fill="rgba(0,0,0,0.35)" />
      {/* desk */}
      <rect x={0} y={0} width={130} height={56} rx={10} fill="#222839" stroke="#36405a" strokeWidth={1.5} />
      <rect x={0} y={0} width={130} height={7} rx={3.5} fill="#2d3550" />
      {/* monitor */}
      <rect x={52} y={10} width={26} height={16} rx={3} className={`mon-${a.display}`} />
      <rect x={63} y={26} width={4} height={8} fill="#36405a" />
      {/* keyboard */}
      <rect x={48} y={40} width={36} height={8} rx={2} fill="#2f3a55" />
      {/* coffee */}
      <circle cx={16} cy={18} r={4} fill="#1a2030" stroke="#36507a" strokeWidth={1} />
      {/* chair */}
      <circle cx={65} cy={86} r={13} fill="#1d2434" stroke="#2c3650" strokeWidth={1.5} />
      <rect x={58} y={74} width={14} height={4} rx={2} fill="#2c3650" />
      {/* inbox backlog badge */}
      {a.inboxBacklog > 0 && (
        <g>
          <rect x={104} y={4} width={20} height={13} rx={6.5} fill="#1a2030" stroke="#f5a623" strokeWidth={1} />
          <text x={114} y={14} textAnchor="middle" fontSize={9} fill="#f5a623" fontFamily="SF Mono, monospace" className="badge-dot">
            {a.inboxBacklog > 9 ? '9+' : a.inboxBacklog}
          </text>
        </g>
      )}
      {/* nameplate */}
      <text x={65} y={118} textAnchor="middle" fontSize={12} fill={a.archived ? '#566073' : '#8b93a7'} fontFamily="SF Mono, monospace">
        {a.name}
      </text>
    </g>
  );
}

function GodOffice({ a, onSelect }: { a?: Agent; onSelect: (id: string) => void }) {
  const display = a?.display ?? 'offline';
  return (
    <g className="desk" onClick={() => a && onSelect(a.id)}>
      <title>{a ? `${a.name} — ${a.role}` : 'corner office'}</title>
      {/* corner office zone */}
      <rect x={640} y={48} width={290} height={200} rx={14} fill="#161b28" stroke="#2c3550" strokeDasharray="6 5" strokeWidth={1.5} />
      <text x={650} y={68} fontSize={10} fill="#3d4a6e" fontFamily="SF Mono, monospace" letterSpacing={2}>CORNER OFFICE</text>
      {/* shadow */}
      <ellipse cx={760} cy={212} rx={110} ry={14} fill="rgba(0,0,0,0.4)" />
      {/* big desk */}
      <rect x={680} y={110} width={180} height={64} rx={10} fill="#262e45" stroke="#414b66" strokeWidth={1.5} />
      <rect x={680} y={110} width={180} height={8} rx={4} fill="#333d5c" />
      {/* dual monitors */}
      <rect x={742} y={120} width={26} height={16} rx={3} className={`mon-${display}`} />
      <rect x={772} y={120} width={26} height={16} rx={3} className={`mon-${display}`} style={{ animationDelay: '0.4s' }} />
      <rect x={768} y={136} width={5} height={10} fill="#414b66" />
      {/* mug */}
      <rect x={700} y={148} width={10} height={9} rx={2} fill="#1a2030" stroke="#f5a623" strokeWidth={1} />
      {/* chair */}
      <circle cx={770} cy={196} r={15} fill="#1d2434" stroke="#2c3650" strokeWidth={1.5} />
      <rect x={761} y={180} width={18} height={5} rx={2.5} fill="#2c3650" />
      {/* nameplate */}
      <text x={770} y={236} textAnchor="middle" fontSize={13} fill="#e7eaf0" fontFamily="SF Mono, monospace" fontWeight={600}>
        {a?.name ?? '—'}
      </text>
      <text x={770} y={250} textAnchor="middle" fontSize={9} fill="#f5a623" fontFamily="SF Mono, monospace" letterSpacing={1.5}>
        GOD · RUNS THE FLOOR
      </text>
    </g>
  );
}

export default function OfficeScene({ agents, onSelect }: Props) {
  const god = agents.find((a) => a.isGod);
  const workers = agents.filter((a) => !a.isGod);

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-hud-edge">
        <div className="font-mono text-xs tracking-widest text-hud-dim">FLOOR F3 · THE OFFICE</div>
        <div className="flex items-center gap-4 text-[10px] font-mono text-hud-dim">
          <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full inline-block" style={{ background: '#34d399' }} /> busy</span>
          <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full inline-block" style={{ background: '#f5a623' }} /> idle</span>
          <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full inline-block" style={{ background: '#f87171' }} /> breaker</span>
          <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full inline-block" style={{ background: '#475569' }} /> offline</span>
        </div>
      </div>
      <svg viewBox="0 0 960 640" className="office-scene w-full" style={{ maxHeight: '62vh' }}>
        <defs>
          <pattern id="carpet" width="34" height="34" patternUnits="userSpaceOnUse">
            <rect width="34" height="34" fill="#10141e" />
            <path d="M0 17 H34 M17 0 V34" stroke="#161c2a" strokeWidth="1" />
          </pattern>
        </defs>

        {/* room */}
        <rect x={20} y={20} width={920} height={600} rx={24} fill="url(#carpet)" stroke="#232a38" strokeWidth={2} />

        {/* whiteboard */}
        <rect x={70} y={60} width={180} height={100} rx={6} fill="#141a28" stroke="#2c3650" strokeWidth={1.5} />
        <text x={80} y={82} fontSize={11} fill="#5b6a8f" fontFamily="SF Mono, monospace">SPRINT BOARD</text>
        <line x1={80} y1={98} x2={230} y2={98} stroke="#2c3650" />
        <rect x={80} y={108} width={40} height={10} rx={2} fill="#34405e" />
        <rect x={80} y={122} width={70} height={10} rx={2} fill="#2c3650" />
        <rect x={80} y={136} width={55} height={10} rx={2} fill="#2c3650" />

        {/* plant */}
        <rect x={290} y={128} width={22} height={16} rx={3} fill="#1f2838" stroke="#36507a" strokeWidth={1} />
        <circle cx={301} cy={120} r={9} fill="#234030" />
        <circle cx={307} cy={112} r={7} fill="#2a5140" />

        {/* wall clock */}
        <circle cx={420} cy={105} r={14} fill="#141a28" stroke="#2c3650" strokeWidth={1.5} />
        <line x1={420} y1={105} x2={420} y2={95} stroke="#5b6a8f" strokeWidth={1.5} />
        <line x1={420} y1={105} x2={428} y2={108} stroke="#5b6a8f" strokeWidth={1.5} />

        {/* the god */}
        <GodOffice a={god} onSelect={onSelect} />

        {/* worker pods */}
        {workers.map((a, i) => {
          const slot = WORKER_SLOTS[i % WORKER_SLOTS.length];
          return <WorkerDesk key={a.id} a={a} x={slot.x} y={slot.y} onSelect={onSelect} />;
        })}

        {/* floor label */}
        <text x={40} y={606} fontSize={11} fill="#2c3650" fontFamily="SF Mono, monospace" letterSpacing={3}>
          OFFICE // HUD
        </text>
      </svg>
    </div>
  );
}
