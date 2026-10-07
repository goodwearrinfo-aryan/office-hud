import { useMemo, useState, useEffect } from 'react';
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
  const [searchResults, setSearchResults] = useState<{ fileMatches: any[]; contentMatches: any[]; total: number } | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedCommunity, setSelectedCommunity] = useState<string | null>(null);
  
  const { data: stats } = useLive<GraphifyStats>('/api/knowledge/graphify');
  const { data: graph, error: graphError } = useLive<GraphifyCommunities>('/api/knowledge/graphify/communities');
  const { data: docsData } = useLive<DocsData>('/api/knowledge/docs');

  const nodes = graph?.nodes ?? 0;
  const links = graph?.links ?? 0;
  const docs = docsData?.docs ?? [];
  const communities = graph?.communities ?? [];

  const filteredDocs = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const baseDocs = selectedCommunity 
      ? docs.filter(doc => doc.path.toLowerCase().includes(selectedCommunity.toLowerCase()))
      : docs;
    const matches = normalized
      ? baseDocs.filter(doc => `${doc.file} ${doc.path}`.toLowerCase().includes(normalized))
      : baseDocs;
    return matches.slice(0, 50);
  }, [docs, query, selectedCommunity]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!query.trim()) {
        setSearchResults(null);
        return;
      }
      setSearchLoading(true);
      try {
        const res = await fetch(`/api/knowledge/search?q=${encodeURIComponent(query)}&limit=50`);
        const data = await res.json();
        setSearchResults(data);
      } catch (e) {
        setSearchResults({ fileMatches: [], contentMatches: [], total: 0 });
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const handleCommunityClick = (communityLabel: string) => {
    setSelectedCommunity(selectedCommunity === communityLabel ? null : communityLabel);
    setQuery('');
  };

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
              <button
                key={community.label}
                onClick={() => handleCommunityClick(community.label)}
                className={`panel-surface px-3 py-2 flex items-center justify-between gap-3 w-full text-left ${
                  selectedCommunity === community.label ? 'border-hud-blue border' : 'hover:border-hud-edge'
                }`}
              >
                <span className="text-xs truncate" title={community.label}>{community.label}</span>
                <span className="font-mono text-xs text-hud-blue">{community.count}</span>
                {selectedCommunity === community.label && <span className="text-hud-blue">▸</span>}
              </button>
            ))}
            {graphError && <div className="text-hud-red text-xs py-4">Graph unavailable: {graphError}</div>}
            {!graphError && communities.length === 0 && <div className="text-hud-dim text-xs py-4">No graph communities available</div>}
          </div>
          <div className="mt-3 text-[10px] text-hud-dim">Click a community to filter documents and graph. Graph rebuild is not exposed on this read-only floor.</div>
        </div>

        <div className="panel p-4 min-w-0">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-mono text-hud-amber text-sm">DOCUMENT SEARCH</h3>
            <span className="text-[10px] font-mono text-hud-dim">
              {searchResults ? `${searchResults.total} results` : `${filteredDocs.length}/{docs.length}`}
            </span>
          </div>
          <input
            type="search"
            className="input mb-3 w-full"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={searchResults ? "Search all documents (semantic + content)..." : "Filter documents by name or path..."}
            disabled={searchLoading}
          />
          {searchLoading && <div className="text-hud-dim text-xs">Searching...</div>}
          
          {searchResults ? (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {searchResults.fileMatches.length > 0 && (
                <>
                  <div className="text-[10px] font-mono text-hud-dim mb-1">File Name Matches</div>
                  {searchResults.fileMatches.slice(0, 20).map(doc => (
                    <div key={doc.path} className="panel-surface px-3 py-2">
                      <div className="font-mono text-xs">{doc.file}</div>
                      <div className="text-[10px] text-hud-dim truncate mt-1" title={doc.path}>{doc.path}</div>
                    </div>
                  ))}
                </>
              )}
              {searchResults.contentMatches.length > 0 && (
                <>
                  <div className="text-[10px] font-mono text-hud-dim mb-1 mt-2">Content Matches</div>
                  {searchResults.contentMatches.slice(0, 10).map(doc => (
                    <div key={doc.path} className="panel-surface px-3 py-2">
                      <div className="font-mono text-xs">{doc.file}</div>
                      <div className="text-[10px] text-hud-dim truncate mt-1" title={doc.path}>{doc.path}</div>
                      <div className="text-[10px] text-hud-dim mt-1 italic">{doc.snippet}</div>
                    </div>
                  ))}
                </>
              )}
              {searchResults.total === 0 && <div className="text-hud-dim text-xs py-4">No matching documents</div>}
            </div>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {filteredDocs.map(doc => (
                <div key={doc.path} className="panel-surface px-3 py-2">
                  <div className="font-mono text-xs">{doc.file}</div>
                  <div className="text-[10px] text-hud-dim truncate mt-1" title={doc.path}>{doc.path}</div>
                </div>
              ))}
              {filteredDocs.length === 0 && <div className="text-hud-dim text-xs py-4">No matching documents</div>}
            </div>
          )}
        </div>
      </div>

      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">SEMANTIC SEARCH</h3>
        <div className="panel-surface p-4 text-xs text-hud-dim leading-5">
          Search now uses the <code className="font-mono">/api/knowledge/search</code> endpoint which supports both file name and content matching.
          The document filter above is exact-text only; this floor does not generate embeddings or modify the knowledge graph.
        </div>
      </div>

      {selectedCommunity && (
        <div className="panel p-4 mt-4 border-hud-blue border">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-mono text-hud-amber text-sm">COMMUNITY FILTER: {selectedCommunity}</h3>
            <button className="btn btn-ghost text-xs" onClick={() => setSelectedCommunity(null)}>Clear Filter</button>
          </div>
          <div className="text-[10px] text-hud-dim">
            Documents and graph on F12 are now filtered to this community. Navigate to F12 to explore the filtered graph.
          </div>
        </div>
      )}
    </div>
  );
}