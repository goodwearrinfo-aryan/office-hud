import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useLive, type GraphifyGraph } from '../api';

const MAX_NODES = 400;

function drag(simulation: d3.Simulation<any, any>) {
  function dragstarted(event: any, d: any) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }
  function dragged(event: any, d: any) {
    d.fx = event.x;
    d.fy = event.y;
  }
  function dragended(event: any, d: any) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }
  return d3.drag().on('start', dragstarted).on('drag', dragged).on('end', dragended);
}

type RenderGraph = { nodes: any[]; links: any[]; totalNodes: number; totalLinks: number; builtAt?: string; filters?: any };

export default function KnowledgeGraph() {
  const [graph, setGraph] = useState<RenderGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [selectedNode, setSelectedNode] = useState<any | null>(null);
  const [filters, setFilters] = useState({ community: '', file_type: '', min_degree: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const signatureRef = useRef<string | null>(null);
  const simulationRef = useRef<{ simulation: d3.Simulation<any, any>; center: d3.ForceCenter<any> } | null>(null);

  const { data, error: fetchError } = useLive<GraphifyGraph>('/api/knowledge/graphify/data');

  const signature = data
    ? `${data.built_at_commit ?? 'na'}:${data.nodes?.length ?? 0}:${data.links?.length ?? 0}`
    : null;

  const source = useMemo<RenderGraph | null>(() => {
    if (!data) return null;
    const allNodes = data.nodes ?? [];
    const allLinks = data.links ?? [];
    const nodes = allNodes.slice(0, MAX_NODES);
    const kept = new Set(nodes.map(node => String(node.id)));
    const links = allLinks.filter(link => kept.has(String(link.source)) && kept.has(String(link.target)));
    return { nodes, links, totalNodes: allNodes.length, totalLinks: allLinks.length, builtAt: data.built_at_commit };
  }, [data]);

  useEffect(() => { setError(fetchError ? String(fetchError) : null); }, [fetchError]);

  useEffect(() => {
    if (!source || !signature || signatureRef.current === signature) return;
    signatureRef.current = signature;
    setGraph(source);
  }, [source, signature]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: Math.round(box.width), height: Math.round(box.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fetch filtered graph when filters change
  useEffect(() => {
    const params = new URLSearchParams();
    if (filters.community) params.set('community', filters.community);
    if (filters.file_type) params.set('file_type', filters.file_type);
    if (filters.min_degree > 0) params.set('min_degree', String(filters.min_degree));
    params.set('limit', '400');
    
    fetch(`/api/knowledge/graphify/data?${params.toString()}`)
      .then(r => r.json())
      .then(data => {
        setGraph({
          nodes: data.nodes,
          links: data.links,
          totalNodes: data.totalNodes,
          totalLinks: data.totalLinks,
          builtAt: data.builtAt,
          filters: data.filters
        });
      })
      .catch(err => setError(String(err)));
  }, [filters]);

  // Build the force layout once per graph. Resizes only re-aim the center force,
  // so node positions survive a window resize instead of being recomputed.
  useEffect(() => {
    if (!svgRef.current || !graph || graph.nodes.length === 0) return;
    const width = size.width || svgRef.current.clientWidth;
    const height = size.height || svgRef.current.clientHeight;
    if (!width || !height) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const nodes = graph.nodes.map(node => ({ ...node }));
    const links = graph.links.map(link => ({ ...link }));

    const center = d3.forceCenter(width / 2, height / 2);
    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id((d: any) => d.id).distance(80).strength(0.4))
      .force('charge', d3.forceManyBody().strength(-260))
      .force('center', center)
      .force('collision', d3.forceCollide().radius(20));

    const link = svg.append('g')
      .attr('stroke', '#232a38')
      .attr('stroke-opacity', 0.3)
      .attr('stroke-width', 1)
      .selectAll('line')
      .data(links)
      .join('line');

    const node = svg.append('g')
      .selectAll('circle')
      .data(nodes)
      .join('circle')
      .attr('r', 7)
      .attr('fill', (d: any) => d.file_type === 'py' ? '#60a5fa' : d.file_type === 'js' ? '#f5a623' : '#34d399')
      .attr('stroke', (d: any) => d.id === selectedNode?.id ? '#f5a623' : '#0b0e14')
      .attr('stroke-width', (d: any) => d.id === selectedNode?.id ? 3 : 2)
      .call(drag(simulation))
      .on('click', (event: any, d: any) => {
        event.stopPropagation();
        setSelectedNode(d);
      });

    node.append('title').text((d: any) => d.label || d.id);

    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);

      node
        .attr('cx', (d: any) => d.x)
        .attr('cy', (d: any) => d.y);
    });

    simulationRef.current = { simulation, center };
    return () => {
      simulation.stop();
      simulationRef.current = null;
    };
  }, [graph, selectedNode]);

  useEffect(() => {
    const live = simulationRef.current;
    if (!live) return;
    const width = size.width;
    const height = size.height;
    if (!width || !height) return;
    live.center.x(width / 2);
    live.center.y(height / 2);
    live.simulation.alpha(0.3).restart();
  }, [size.width, size.height]);

  const truncated = graph ? graph.totalNodes > graph.nodes.length : false;

  // Get unique communities and file types for filter dropdowns
  const allNodes = graph?.nodes ?? [];
  const communities = useMemo(() => {
    const set = new Set<string>();
    for (const node of allNodes) {
      const label = node.community_name || (node.community != null ? `Community ${node.community}` : 'Unassigned');
      set.add(label);
    }
    return Array.from(set).sort();
  }, [allNodes]);

  const fileTypes = useMemo(() => {
    const set = new Set<string>();
    for (const node of allNodes) {
      if (node.file_type) set.add(node.file_type);
    }
    return Array.from(set).sort();
  }, [allNodes]);

  const handleBackgroundClick = () => {
    setSelectedNode(null);
  };

  return (
    <div className="h-full p-4" onClick={handleBackgroundClick}>
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F12 · KNOWLEDGE GRAPH</h2>
        <span className="badge badge-info">READ ONLY</span>
      </div>
      
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-mono text-hud-dim">Community:</label>
          <select
            className="input text-xs"
            value={filters.community}
            onChange={e => setFilters(f => ({ ...f, community: e.target.value }))}
          >
            <option value="">All</option>
            {communities.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-mono text-hud-dim">File Type:</label>
          <select
            className="input text-xs"
            value={filters.file_type}
            onChange={e => setFilters(f => ({ ...f, file_type: e.target.value }))}
          >
            <option value="">All</option>
            {fileTypes.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-mono text-hud-dim">Min Degree:</label>
          <input
            type="number"
            className="input text-xs w-16"
            value={filters.min_degree}
            onChange={e => setFilters(f => ({ ...f, min_degree: parseInt(e.target.value) || 0 }))}
            min="0"
          />
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <button
            className="btn btn-ghost text-xs"
            onClick={() => setFilters({ community: '', file_type: '', min_degree: 0 })}
          >
            Clear Filters
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-[10px] font-mono text-hud-dim">
        <span>NODES {graph ? graph.nodes.length : 0}{truncated ? ` / ${graph?.totalNodes}` : ''}</span>
        <span>LINKS {graph ? graph.links.length : 0}{graph && graph.links.length < graph.totalLinks ? ` / ${graph.totalLinks}` : ''}</span>
        <span>BUILT {graph?.builtAt ? graph.builtAt.slice(0, 10) : '--'}</span>
        {truncated && <span>render capped at {MAX_NODES} nodes for responsiveness</span>}
      </div>
      
      <div ref={wrapRef} className="panel h-[calc(100vh-320px)] relative">
        <svg ref={svgRef} className="w-full h-full" />
        {graph?.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-hud-dim">
            <div className="text-center px-4">
              <div className="font-mono">No graph data</div>
              <div className="text-xs mt-2">{error ? `Graph endpoint error: ${error}` : 'No graphify output is present on this host'}</div>
            </div>
          </div>
        )}
      </div>

      {/* Node Detail Drawer */}
      {selectedNode && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="w-full md:w-96 bg-hud-panel border-t border-hud-edge p-4 animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-mono text-hud-amber text-sm">NODE DETAIL</h3>
              <button className="btn btn-ghost text-xs" onClick={() => setSelectedNode(null)}>Close</button>
            </div>
            <div className="space-y-2 text-xs">
              <div className="panel-surface px-3 py-2">
                <div className="text-hud-dim">ID</div>
                <div className="font-mono truncate">{selectedNode.id}</div>
              </div>
              <div className="panel-surface px-3 py-2">
                <div className="text-hud-dim">LABEL</div>
                <div className="font-mono truncate">{selectedNode.label || selectedNode.id}</div>
              </div>
              <div className="panel-surface px-3 py-2">
                <div className="text-hud-dim">COMMUNITY</div>
                <div className="font-mono text-hud-blue">{selectedNode.community_name || (selectedNode.community != null ? `Community ${selectedNode.community}` : 'Unassigned')}</div>
              </div>
              <div className="panel-surface px-3 py-2">
                <div className="text-hud-dim">FILE TYPE</div>
                <div className="font-mono">{selectedNode.file_type || 'unknown'}</div>
              </div>
              <div className="panel-surface px-3 py-2">
                <div className="text-hud-dim">SOURCE FILE</div>
                <div className="font-mono truncate">{selectedNode.source_file || 'unknown'}</div>
              </div>
              <div className="panel-surface px-3 py-2">
                <div className="text-hud-dim">SOURCE LOCATION</div>
                <div className="font-mono truncate">{selectedNode.source_location || 'unknown'}</div>
              </div>
              {selectedNode.metadata && (
                <div className="panel-surface px-3 py-2">
                  <div className="text-hud-dim">METADATA</div>
                  <pre className="font-mono text-[10px] max-h-32 overflow-auto">{JSON.stringify(selectedNode.metadata, null, 2)}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}