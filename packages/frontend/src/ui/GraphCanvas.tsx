import { useEffect, useRef } from 'react';
import {
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

/** Sub-pixel movement isn't visible; skip the DOM write. */
const MOVE_EPSILON = 0.4;
/** Settle threshold — see alphaMin below. */
const ALPHA_MIN = 0.02;
/** Reheat for new arrivals: enough to place them, not to relaunch the graph. */
const REHEAT_ALPHA = 0.3;
/** Full re-layout (everything unpinned) gets a proper shake. */
const RELAYOUT_ALPHA = 0.9;
/** How far from a change nodes are unpinned so they can make room for it. */
const RELAX_RADIUS = 220;
/** Energy injected when a drag starts, so neighbours react immediately. */
const DRAG_ALPHA = 0.4;
/** Keeps the freed neighbourhood live while a drag is in progress. */
const DRAG_ALPHA_TARGET = 0.2;

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
  /** Changing this unpins every node and re-runs the layout from scratch. */
  relayoutKey: number;
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
  relayoutKey,
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
  /** Last position written to the DOM per node, for dirty-checking ticks. */
  const writtenRef = useRef(new Map<string, { x: number; y: number }>());
  const dragRef = useRef<{ id: string; moved: boolean; startX: number; startY: number } | null>(
    null,
  );

  // d3-force owns positions; React owns membership. Positions are applied
  // directly to DOM attributes on each tick so React never re-renders per frame.
  //
  // Only what actually moved gets written: past a few hundred nodes the
  // per-tick DOM writes, not the force math, are what makes the canvas feel
  // heavy, and once the layout is pinned most nodes are stationary every tick.
  const applyPositions = (force = false) => {
    const written = writtenRef.current;
    const moved = new Set<string>();
    for (const n of simNodesRef.current.values()) {
      const x = n.x ?? W / 2;
      const y = n.y ?? H / 2;
      const prev = written.get(n.id);
      if (!force && prev && Math.abs(prev.x - x) < MOVE_EPSILON && Math.abs(prev.y - y) < MOVE_EPSILON) {
        continue;
      }
      written.set(n.id, { x, y });
      moved.add(n.id);
      nodeElsRef.current.get(n.id)?.setAttribute('transform', `translate(${x},${y})`);
    }
    if (!force && moved.size === 0) return; // nothing shifted: skip the edge pass
    for (const l of simLinksRef.current) {
      const s = l.source as SimNode;
      const t = l.target as SimNode;
      if (typeof s !== 'object' || typeof t !== 'object') continue;
      if (!force && !moved.has(s.id) && !moved.has(t.id)) continue;
      const el = edgeElsRef.current.get(l.id);
      if (!el) continue;
      el.setAttribute('x1', String(s.x ?? 0));
      el.setAttribute('y1', String(s.y ?? 0));
      el.setAttribute('x2', String(t.x ?? 0));
      el.setAttribute('y2', String(t.y ?? 0));
    }
  };

  /**
   * Free the neighbourhood around `seedIds` so it can reorganise: the seeds
   * themselves, anything linked to them, and anything sitting close enough to
   * be in the way. The rest of the graph stays pinned — so a local change
   * (new rows, a drag) stays local instead of relaunching the whole layout,
   * while still letting nodes push each other apart.
   */
  const relaxAround = (seedIds: Set<string>) => {
    if (seedIds.size === 0) return;
    const free = new Set(seedIds);
    for (const l of simLinksRef.current) {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      if (seedIds.has(s)) free.add(t);
      if (seedIds.has(t)) free.add(s);
    }
    const anchors = [...seedIds]
      .map((id) => simNodesRef.current.get(id))
      .filter((n): n is SimNode => n?.x != null && n?.y != null);
    for (const n of simNodesRef.current.values()) {
      if (free.has(n.id) || n.x == null || n.y == null) continue;
      for (const a of anchors) {
        if (Math.hypot(n.x - a.x!, n.y - a.y!) < RELAX_RADIUS) {
          free.add(n.id);
          break;
        }
      }
    }
    for (const id of free) {
      const n = simNodesRef.current.get(id);
      if (n) {
        n.fx = null;
        n.fy = null;
      }
    }
  };

  /** Freeze every placed node where it sits, so later arrivals can't shove it. */
  const pinSettled = () => {
    for (const n of simNodesRef.current.values()) {
      if (n.x != null && n.y != null) {
        n.fx = n.x;
        n.fy = n.y;
      }
    }
  };

  const getSim = () => {
    if (!simRef.current) {
      simRef.current = forceSimulation<SimNode>([])
        // distanceMax bounds repulsion range so disconnected clusters don't
        // shove each other across the canvas.
        .force('charge', forceManyBody().strength(-350).distanceMax(300))
        // NO forceCenter here. It re-centres the whole graph by rewriting every
        // node's position each tick, at full strength. With most of the layout
        // pinned those nodes snap straight back to their fx/fy, so the centroid
        // never converges and the entire correction lands on the handful of
        // unpinned nodes — which visibly teleport away on the first tick after
        // an expansion. Gentle per-node gravity does the same job safely, since
        // it acts through velocity and only on nodes that are free to move.
        .force('x', forceX(W / 2).strength(0.02))
        .force('y', forceY(H / 2).strength(0.02))
        .force('collide', forceCollide(NODE_R * 2.2))
        .force(
          'link',
          forceLink<SimNode, SimLink>([]).id((d) => d.id).distance(90),
        )
        // Stop early rather than crawling to the default 0.001: the last
        // stretch is imperceptible motion that costs a tick over every node.
        .alphaMin(ALPHA_MIN)
        .on('tick', () => applyPositions())
        // d3 fires 'end' once alpha falls below alphaMin — the layout has
        // settled, so lock it in.
        .on('end', pinSettled);
    }
    return simRef.current;
  };

  useEffect(() => {
    const sim = getSim();
    const simNodes = simNodesRef.current;

    const ids = new Set([...nodes.map((n) => n.id), ...pills.map((p) => p.id)]);
    for (const id of [...simNodes.keys()]) {
      if (!ids.has(id)) {
        simNodes.delete(id);
        writtenRef.current.delete(id);
      }
    }
    const arrived = new Set<string>();
    // Spawn new elements next to an already-placed neighbor so expansions
    // grow outward instead of flying in from the center.
    const spawn = (id: string, nearId?: string) => {
      if (simNodes.has(id)) return;
      arrived.add(id);
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
    // Only reheat when something actually arrived, and only around where it
    // landed: newcomers and their immediate surroundings are freed so they can
    // spread out, while the rest of the graph holds its shape.
    if (arrived.size > 0) {
      relaxAround(arrived);
      sim.alpha(REHEAT_ALPHA).restart();
    }
    applyPositions(true);
  }, [nodes, pills, edges]);

  // Full re-layout: unpin everything and let the graph find a fresh shape.
  const firstRelayout = useRef(true);
  useEffect(() => {
    if (firstRelayout.current) {
      firstRelayout.current = false;
      return;
    }
    for (const n of simNodesRef.current.values()) {
      n.fx = null;
      n.fy = null;
    }
    getSim().alpha(RELAYOUT_ALPHA).restart();
  }, [relayoutKey]);

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
      // Free what this node is attached to, so the local graph follows the drag
      // instead of the node tearing away from a frozen picture. Distant nodes
      // stay pinned, so the cost is the neighbourhood, not the whole graph.
      relaxAround(new Set([id]));
      // alpha() must be set explicitly: restart() only restarts the timer, so
      // resuming a cooled simulation would ramp up from ~alphaMin at a couple
      // of percent per tick — the neighbourhood would barely react. alphaTarget
      // then holds that energy for as long as the drag lasts.
      getSim().alpha(DRAG_ALPHA).alphaTarget(DRAG_ALPHA_TARGET).restart();
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
    // Let the neighbourhood settle, then 'end' re-pins everything. The dragged
    // node keeps its fx/fy: you put it there deliberately, so it stays.
    getSim().alphaTarget(0);
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
