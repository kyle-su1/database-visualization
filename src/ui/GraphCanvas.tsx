import { useEffect, useRef } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import type { GraphNode, PillNode } from '../graph/session';
import type { ViewEdge } from '../graph/view';

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
  pills: PillNode[];
  edges: ViewEdge[];
  selectedId: string | null;
  isExpanded: (node: GraphNode) => boolean;
  colorFor: (table: string) => string;
  onNodeClick: (node: GraphNode) => void;
  onNodeDoubleClick: (node: GraphNode) => void;
  onPillClick: (pill: PillNode) => void;
}

export function GraphCanvas({
  nodes,
  pills,
  edges,
  selectedId,
  isExpanded,
  colorFor,
  onNodeClick,
  onNodeDoubleClick,
  onPillClick,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const panRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simNodesRef = useRef(new Map<string, SimNode>());
  const simLinksRef = useRef<SimLink[]>([]);
  const nodeElsRef = useRef(new Map<string, SVGGElement>());
  const edgeElsRef = useRef(new Map<string, SVGLineElement>());
  const dragRef = useRef<{ id: string; moved: boolean; startX: number; startY: number } | null>(
    null,
  );

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
        // distanceMax bounds repulsion range so disconnected clusters don't
        // shove each other across the canvas.
        .force('charge', forceManyBody().strength(-350).distanceMax(300))
        .force('center', forceCenter(W / 2, H / 2))
        // Per-node gravity toward center keeps disconnected components from
        // drifting apart (forceCenter only recenters the center of mass).
        .force('x', forceX(W / 2).strength(0.05))
        .force('y', forceY(H / 2).strength(0.05))
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

    const ids = new Set([...nodes.map((n) => n.id), ...pills.map((p) => p.id)]);
    for (const id of [...simNodes.keys()]) {
      if (!ids.has(id)) simNodes.delete(id);
    }
    // Spawn new elements next to an already-placed neighbor so expansions
    // grow outward instead of flying in from the center.
    const spawn = (id: string, nearId?: string) => {
      if (simNodes.has(id)) return;
      let x = W / 2;
      let y = H / 2;
      const candidates = nearId ? [nearId] : [];
      for (const e of edges) {
        if (e.source === id) candidates.push(e.target);
        else if (e.target === id) candidates.push(e.source);
      }
      for (const otherId of candidates) {
        const other = simNodes.get(otherId);
        if (other && other.x != null && other.y != null) {
          x = other.x;
          y = other.y;
          break;
        }
      }
      simNodes.set(id, {
        id,
        x: x + (Math.random() - 0.5) * 60,
        y: y + (Math.random() - 0.5) * 60,
      });
    };
    for (const n of nodes) spawn(n.id);
    for (const p of pills) spawn(p.id, p.parentNodeId);

    simLinksRef.current = edges
      .filter((e) => simNodes.has(e.source) && simNodes.has(e.target))
      .map((e) => ({ id: e.id, source: e.source, target: e.target }));

    sim.nodes([...simNodes.values()]);
    (sim.force('link') as ForceLink<SimNode, SimLink>).links(simLinksRef.current);
    sim.alpha(0.9).restart();
    applyPositions();
  }, [nodes, pills, edges]);

  useEffect(
    () => () => {
      simRef.current?.stop();
    },
    [],
  );

  // ------------------------------------------------------------- pan + zoom

  const applyView = () => {
    const v = viewRef.current;
    viewportRef.current?.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.k})`);
  };

  /** Client coords -> untransformed viewBox coords (for panning/zooming math). */
  const toViewBoxPoint = (clientX: number, clientY: number) => {
    const ctm = svgRef.current!.getScreenCTM();
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm!.inverse());
    return { x: p.x, y: p.y };
  };

  const startPan = (e: React.PointerEvent<SVGSVGElement>) => {
    // Node/pill drags run first (bubbling) and set dragRef — skip those.
    if (dragRef.current || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toViewBoxPoint(e.clientX, e.clientY);
    const v = viewRef.current;
    panRef.current = { startX: p.x, startY: p.y, origX: v.x, origY: v.y };
    svgRef.current!.style.cursor = 'grabbing';
  };

  const movePan = (e: React.PointerEvent<SVGSVGElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    const p = toViewBoxPoint(e.clientX, e.clientY);
    viewRef.current.x = pan.origX + (p.x - pan.startX);
    viewRef.current.y = pan.origY + (p.y - pan.startY);
    applyView();
  };

  const endPan = () => {
    panRef.current = null;
    if (svgRef.current) svgRef.current.style.cursor = '';
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // Native listener: React's onWheel is passive, so preventDefault (to stop
    // page scroll) requires attaching with { passive: false }.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const k = Math.min(4, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.002)));
      const p = toViewBoxPoint(e.clientX, e.clientY);
      // Keep the graph point under the cursor fixed while scaling.
      v.x = p.x - ((p.x - v.x) * k) / v.k;
      v.y = p.y - ((p.y - v.y) * k) / v.k;
      v.k = k;
      applyView();
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  // ------------------------------------------------------------ drag + click

  /** Client coords -> simulation coords (inside the pan/zoom viewport). */
  const toSvgPoint = (e: React.PointerEvent) => {
    const ctm = viewportRef.current!.getScreenCTM();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm!.inverse());
    return { x: p.x, y: p.y };
  };

  const startDrag = (id: string) => (e: React.PointerEvent<SVGGElement>) => {
    const sn = simNodesRef.current.get(id);
    if (!sn) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toSvgPoint(e);
    dragRef.current = { id, moved: false, startX: p.x, startY: p.y };
    sn.fx = sn.x;
    sn.fy = sn.y;
    // Don't reheat the simulation here — a click to select shouldn't jiggle
    // the graph. Heating happens in moveDrag once an actual drag begins.
  };

  const moveDrag = (id: string) => (e: React.PointerEvent<SVGGElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== id) return;
    const p = toSvgPoint(e);
    if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) > 4) {
      d.moved = true;
      getSim().alphaTarget(0.25).restart();
    }
    if (!d.moved) return;
    const sn = simNodesRef.current.get(id);
    if (sn) {
      sn.fx = p.x;
      sn.fy = p.y;
    }
  };

  const endDrag = (id: string, onClick: () => void) => (e: React.PointerEvent<SVGGElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== id) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    getSim().alphaTarget(0);
    const sn = simNodesRef.current.get(id);
    if (sn) {
      sn.fx = null;
      sn.fy = null;
    }
    if (!d.moved) onClick();
  };

  const registerEl = (id: string) => (el: SVGGElement | null) => {
    if (el) nodeElsRef.current.set(id, el);
    else nodeElsRef.current.delete(id);
  };

  return (
    <svg
      ref={svgRef}
      className="graph-canvas"
      viewBox={`0 0 ${W} ${H}`}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
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
      <g ref={viewportRef}>
      <g>
        {edges.map((e) => (
          <line
            key={e.id}
            ref={(el) => {
              if (el) edgeElsRef.current.set(e.id, el);
              else edgeElsRef.current.delete(e.id);
            }}
            className={'edge' + (e.dissolved ? ' dissolved' : '')}
            markerEnd={e.dissolved ? undefined : 'url(#arrow)'}
          >
            <title>{e.label}</title>
          </line>
        ))}
      </g>
      <g>
        {nodes.map((n) => (
          <g
            key={n.id}
            ref={registerEl(n.id)}
            className={
              'node' +
              (isExpanded(n) ? ' expanded' : '') +
              (n.id === selectedId ? ' selected' : '')
            }
            onPointerDown={startDrag(n.id)}
            onPointerMove={moveDrag(n.id)}
            onPointerUp={endDrag(n.id, () => onNodeClick(n))}
            onDoubleClick={() => onNodeDoubleClick(n)}
          >
            <title>
              {`${n.table}\n` +
                Object.entries(n.pk)
                  .map(([k, v]) => `${k} = ${String(v)}`)
                  .join('\n') +
                '\nclick to inspect · double-click to expand all'}
            </title>
            <circle r={NODE_R} fill={colorFor(n.table)} />
            <text dy={NODE_R + 14}>{n.label}</text>
          </g>
        ))}
        {pills.map((p) => {
          const label = `+${p.total - p.fetched} more ${p.childTable}`;
          const w = label.length * 6.2 + 16;
          return (
            <g
              key={p.id}
              ref={registerEl(p.id)}
              className="pill"
              onPointerDown={startDrag(p.id)}
              onPointerMove={moveDrag(p.id)}
              onPointerUp={endDrag(p.id, () => onPillClick(p))}
            >
              <title>{`${p.fetched} of ${p.total} ${p.childTable} rows loaded\nclick to load ${Math.min(
                p.total - p.fetched,
                25,
              )} more`}</title>
              <rect x={-w / 2} y={-11} width={w} height={22} rx={11} />
              <text dy={4}>{label}</text>
            </g>
          );
        })}
      </g>
      </g>
    </svg>
  );
}
