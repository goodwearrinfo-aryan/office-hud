import { useLive } from '../api';

export default function KnowledgeFloor() {
  return (
    <div className="h-full overflow-auto p-4">
      <h2 className="font-mono text-hud-amber text-lg mb-4">F10 · KNOWLEDGE FLOOR</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">GRAPHIFY EXPLORER</h3>
          <div className="space-y-2">
            <div className="panel p-3">
              <div className="font-mono text-xs text-hud-dim">Nodes: 0 | Links: 0</div>
              <div className="text-xs text-hud-dim">Run graphify to build knowledge graph</div>
            </div>
            <button className="btn btn-primary w-full mt-2">Build Graph</button>
          </div>
        </div>
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">DOCUMENT SEARCH</h3>
          <input type="text" className="input mb-3" placeholder="Search docs, code, memory..." />
          <div className="text-hud-dim text-xs">Results will appear here</div>
        </div>
      </div>
      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">SEMANTIC SEARCH</h3>
        <input type="text" className="input mb-3" placeholder="Ask a question about the codebase..." />
        <div className="text-hud-dim text-xs">Embeddings not yet built</div>
      </div>
    </div>
  );
}