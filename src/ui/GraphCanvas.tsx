import { useEffect, useRef } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type ForceLink,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import type { GraphEdge, GraphNode } from '../graph/session';

const W = 1200;
const H = 800;
const NODE_R = 16;

interface SimNode extends SimulationNodeDatum {
  id: string;
}
interface SimLink {
  id: string;
  source: string | SimNode;
  target: string | SimNode;
}

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  expandedIds: Set<string>;
  colorFor: (table: string) => string;
  onNodeClick: (node: GraphNode) => void;
}

export function GraphCanvas({ nodes, edges, expandedIds, colorFor, onNodeClick }: Props) {
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simNodesRef = useRef(new Map<string, SimNode>());
  const simLinksRef = useRef<SimLink[]>([]);
  const nodeElsRef = useRef(new Map<string, SVGGElement>());
  const edgeElsRef = useRef(new Map<string, SVGLineElement>());

  // d3-force owns positions; React owns membership. Positions are applied
  // directly to DOM attributes on each tick so React never re-renders per frame.
  const applyPositions = () => {
    for (const n of simNodesRef.current.values()) {
      const el = nodeElsRef.current.get(n.id);
      if (el) el.setAttribute('transform', `translate(${n.x ?? W / 2},${n.y ?? H / 2})`);
    }
    for (const l of simLinksRef.current) {
      const el = edgeElsRef.current.get(l.id);
      const s = l.source as SimNode;
      const t = l.target as SimNode;
      if (el && typeof s === 'object' && typeof t === 'object') {
        el.setAttribute('x1', String(s.x ?? 0));
        el.setAttribute('y1', String(s.y ?? 0));
        el.setAttribute('x2', String(t.x ?? 0));
        el.setAttribute('y2', String(t.y ?? 0));
      }
    }
  };

  const getSim = () => {
    if (!simRef.current) {
      simRef.current = forceSimulation<SimNode>([])
        .force('charge', forceManyBody().strength(-350))
        .force('center', forceCenter(W / 2, H / 2))
        .force('collide', forceCollide(NODE_R * 2.2))
        .force(
          'link',
          forceLink<SimNode, SimLink>([]).id((d) => d.id).distance(90),
        )
        .on('tick', applyPositions);
    }
    return simRef.current;
  };

  useEffect(() => {
    const sim = getSim();
    const simNodes = simNodesRef.current;

    const ids = new Set(nodes.map((n) => n.id));
    for (const id of [...simNodes.keys()]) {
      if (!ids.has(id)) simNodes.delete(id);
    }
    // Spawn new nodes next to an already-placed neighbor so expansions grow
    // outward instead of flying in from the center.
    for (const n of nodes) {
      if (simNodes.has(n.id)) continue;
      let x = W / 2;
      let y = H / 2;
      for (const e of edges) {
        const otherId = e.source === n.id ? e.target : e.target === n.id ? e.source : null;
        if (!otherId) continue;
        const other = simNodes.get(otherId);
        if (other && other.x != null && other.y != null) {
          x = other.x;
          y = other.y;
          break;
        }
      }
      simNodes.set(n.id, {
        id: n.id,
        x: x + (Math.random() - 0.5) * 60,
        y: y + (Math.random() - 0.5) * 60,
      });
    }

    simLinksRef.current = edges
      .filter((e) => simNodes.has(e.source) && simNodes.has(e.target))
      .map((e) => ({ id: e.id, source: e.source, target: e.target }));

    sim.nodes([...simNodes.values()]);
    (sim.force('link') as ForceLink<SimNode, SimLink>).links(simLinksRef.current);
    sim.alpha(0.9).restart();
    applyPositions();
  }, [nodes, edges]);

  useEffect(
    () => () => {
      simRef.current?.stop();
    },
    [],
  );

  return (
    <svg className="graph-canvas" viewBox={`0 0 ${W} ${H}`}>
      <defs>
        <marker
          id="arrow"
          markerUnits="userSpaceOnUse"
          markerWidth="12"
          markerHeight="12"
          refX={NODE_R + 11}
          refY="6"
          orient="auto"
        >
          <path d="M0,0 L12,6 L0,12 z" fill="#94a3b8" />
        </marker>
      </defs>
      <g>
        {edges.map((e) => (
          <line
            key={e.id}
            ref={(el) => {
              if (el) edgeElsRef.current.set(e.id, el);
              else edgeElsRef.current.delete(e.id);
            }}
            className="edge"
            markerEnd="url(#arrow)"
          >
            <title>{e.label}</title>
          </line>
        ))}
      </g>
      <g>
        {nodes.map((n) => (
          <g
            key={n.id}
            ref={(el) => {
              if (el) nodeElsRef.current.set(n.id, el);
              else nodeElsRef.current.delete(n.id);
            }}
            className={'node' + (expandedIds.has(n.id) ? ' expanded' : '')}
            onClick={() => onNodeClick(n)}
          >
            <title>
              {`${n.table}\n` +
                Object.entries(n.pk)
                  .map(([k, v]) => `${k} = ${String(v)}`)
                  .join('\n') +
                (expandedIds.has(n.id) ? '\n(expanded)' : '\nclick to expand')}
            </title>
            <circle r={NODE_R} fill={colorFor(n.table)} />
            <text dy={NODE_R + 14}>{n.label}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
