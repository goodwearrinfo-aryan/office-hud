import { useMemo, useState } from 'react';
import { useLive, type DocsData, type GraphifyCommunities, type GraphifyStats } from '../api';

function Metric({ label, value, tone = 'text-hud-text' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="panel-surface px-3 py-2">
      <div className="text-[10px] font-mono text-hud-dim">{label}</div>
      <div className={`mt-1 font-mono text-sm ${tone}`}>{value}</div>
    </div>
  );
}

export default function KnowledgeFloor() {
  const [query, setQuery] = useState('');
  const { data: stats } = useLive<GraphifyStats>('/api/knowledge/graphify');
  // The counts endpoint returns a few hundred bytes; /graphify/data is ~770KB.
  const { data: graph, error: graphError } = useLive<GraphifyCommunities>('/api/knowledge/graphify/communities');
  const { data: docsData } = useLive<DocsData>('/api/knowledge/docs');

  const nodes = graph?.nodes ?? 0;
  const links = graph?.links ?? 0;
  const docs = docsData?.docs ?? [];
  const communities = graph?.communities ?? [];
  const filteredDocs = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = normalized
      ? docs.filter(doc => `${doc.file} ${doc.path}`.toLowerCase().includes(normalized))
      : docs;
    return matches.slice(0, 50);
  }, [docs, query]);

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F10 · KNOWLEDGE FLOOR</h2>
        <span className="badge badge-info">READ ONLY</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
        <Metric label="GRAPH NODES" value={stats?.exists ? String(nodes) : 'NO GRAPH'} tone={stats?.exists && nodes ? 'text-hud-green' : 'text-hud-dim'} />
        <Metric label="GRAPH LINKS" value={String(links)} tone={links ? 'text-hud-green' : 'text-hud-dim'} />
        <Metric label="DOCUMENTS" value={String(docs.length)} />
        <Metric label="BUILT AT" value={graph?.built_at_commit ? graph.built_at_commit.slice(0, 10) : 'UNKNOWN'} tone="text-hud-dim" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">GRAPHIFY EXPLORER</h3>
          <div className="space-y-2">
            {communities.map(community => (
              <div key={community.label} className="panel-surface px-3 py-2 flex items-center justify-between gap-3">
                <span className="text-xs truncate" title={community.label}>{community.label}</span>
                <span className="font-mono text-xs text-hud-blue">{community.count}</span>
              </div>
            ))}
            {graphError && <div className="text-hud-red text-xs py-4">Graph unavailable: {graphError}</div>}
            {!graphError && communities.length === 0 && <div className="text-hud-dim text-xs py-4">No graph communities available</div>}
          </div>
          <div className="mt-3 text-[10px] text-hud-dim">Graph rebuild is not exposed on this read-only floor.</div>
        </div>

        <div className="panel p-4 min-w-0">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-mono text-hud-amber text-sm">DOCUMENT SEARCH</h3>
            <span className="text-[10px] font-mono text-hud-dim">{filteredDocs.length}/{docs.length}</span>
          </div>
          <input
            type="search"
            className="input mb-3 w-full"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Filter documents by name or path..."
          />
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {filteredDocs.map(doc => (
              <div key={doc.path} className="panel-surface px-3 py-2">
                <div className="font-mono text-xs">{doc.file}</div>
                <div className="text-[10px] text-hud-dim truncate mt-1" title={doc.path}>{doc.path}</div>
              </div>
            ))}
            {filteredDocs.length === 0 && <div className="text-hud-dim text-xs py-4">No matching documents</div>}
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">SEMANTIC SEARCH</h3>
        <div className="panel-surface p-4 text-xs text-hud-dim leading-5">
          No semantic index endpoint is connected. The document filter above is exact-text only; this floor does not generate embeddings or modify the knowledge graph.
        </div>
      </div>
    </div>
  );
}
