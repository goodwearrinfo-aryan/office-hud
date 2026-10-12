import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useLive, type GraphifyGraph, type GraphNode } from '../api';

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
  // The element and datum generics must be pinned to the same types the circle
  // selection is built with. Left implicit, d3-drag widens GElement to Element
  // while selectAll('circle') yields `BaseType | SVGCircleElement` (BaseType
  // admits null), and selection.call() then rejects the behaviour.
  return d3.drag<SVGCircleElement, GraphNode>().on('start', dragstarted).on('drag', dragged).on('end', dragended);
}

type RenderGraph = { nodes: any[]; links: any[]; totalNodes: number; totalLinks: number; builtAt?: string };

export default function KnowledgeGraph() {
  const [graph, setGraph] = useState<RenderGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
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
      .selectAll<SVGCircleElement, GraphNode>('circle')
      .data(nodes)
      .join('circle')
      .attr('r', 7)
      .attr('fill', (d: any) => d.file_type === 'py' ? '#60a5fa' : d.file_type === 'js' ? '#f5a623' : '#34d399')
      .attr('stroke', '#0b0e14')
      .attr('stroke-width', 2)
      .call(drag(simulation));

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
  }, [graph]);

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

  return (
    <div className="h-full p-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F12 · KNOWLEDGE GRAPH</h2>
        <span className="badge badge-info">READ ONLY</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-[10px] font-mono text-hud-dim">
        <span>NODES {graph ? graph.nodes.length : 0}{truncated ? ` / ${graph?.totalNodes}` : ''}</span>
        <span>LINKS {graph ? graph.links.length : 0}{graph && graph.links.length < graph.totalLinks ? ` / ${graph.totalLinks}` : ''}</span>
        <span>BUILT {graph?.builtAt ? graph.builtAt.slice(0, 10) : '—'}</span>
        {truncated && <span>render capped at {MAX_NODES} nodes for responsiveness</span>}
      </div>
      <div ref={wrapRef} className="panel h-[calc(100vh-220px)] relative">
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
    </div>
  );
}
