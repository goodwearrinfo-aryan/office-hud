import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useLive } from '../api';

export default function KnowledgeGraph() {
  const [graphData, setGraphData] = useState<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] });
  const svgRef = useRef<SVGSVGElement>(null);

  const { data } = useLive<{ nodes: any[]; links: any[] }>('/api/knowledge/graphify/data');

  useEffect(() => {
    if (data) setGraphData(data);
  }, [data]);

  useEffect(() => {
    if (!svgRef.current || graphData.nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;

    const simulation = d3.forceSimulation(graphData.nodes)
      .force('link', d3.forceLink(graphData.links).id((d: any) => d.id).distance(80))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(20));

    const link = svg.append('g')
      .attr('stroke', '#232a38')
      .attr('stroke-opacity', 0.3)
      .attr('stroke-width', 1)
      .selectAll('line')
      .data(graphData.links)
      .join('line');

    const node = svg.append('g')
      .selectAll('circle')
      .data(graphData.nodes)
      .join('circle')
      .attr('r', 8)
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

    function drag(simulation: any) {
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

    return () => { simulation.stop(); };
  }, [graphData]);

  return (
    <div className="h-full p-4">
      <h2 className="font-mono text-hud-amber text-lg mb-4">F12 · KNOWLEDGE GRAPH</h2>
      <div className="panel h-[calc(100vh-200px)] relative">
        <svg ref={svgRef} className="w-full h-full" />
        {graphData.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-hud-dim">
            <div className="text-center">
              <div className="text-4xl mb-2">🧠</div>
              <div className="font-mono text-hud-dim">No graph data</div>
              <div className="text-xs text-hud-dim mt-2">Run graphify to build knowledge graph</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}