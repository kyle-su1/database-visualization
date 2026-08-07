import { useEffect, useMemo, useRef } from 'react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type ForceX,
  type ForceY,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import type { GraphNode, PillNode } from '../graph/session';
import type { ViewEdge } from '../graph/view';

const W = 1200;
const H = 800;
/** Node radius scales with how many edges a row has, so hubs read as hubs. */
const NODE_R_MIN = 10;
const NODE_R_MAX = 26;
/** Reference count at which a node reaches full size; beyond this it stops. */
const DEGREE_FOR_MAX = 16;
/** Breathing room forceCollide keeps around each node, on top of its radius. */
const COLLIDE_PAD = 13;
/** Gap between an arrowhead and the circle it points at. */
const ARROW_GAP = 3;
/** Marker geometry: the path tip sits at x = ARROW_LEN. */
const ARROW_LEN = 12;

/**
 * Area — not radius — grows with degree, so a node with four times the
 * connections looks twice as wide rather than four times, which is how people
 * actually read circle sizes.
 */
function radiusForDegree(degree: number): number {
  const t = Math.min(1, Math.sqrt(degree / DEGREE_FOR_MAX));
  return NODE_R_MIN + (NODE_R_MAX - NODE_R_MIN) * t;
}

/** Sub-pixel movement isn't visible; skip the DOM write. */
const MOVE_EPSILON = 0.4;
/** Settle threshold — see alphaMin below. */
const ALPHA_MIN = 0.02;
/** Reheat for new arrivals: enough to place them, not to relaunch the graph. */
const REHEAT_ALPHA = 0.3;
/** Full re-layout (everything unpinned) gets a proper shake. */
const RELAYOUT_ALPHA = 0.9;
/** Centering pull, applied only during a full re-layout. */
const RELAYOUT_GRAVITY = 0.05;
/** Ring radius new rows are placed on around their parent. */
const SPAWN_RADIUS = 70;
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

  // Edge count per node drives its radius. Derived during render so the circles
  // resize in the same paint the new edges appear in; mirrored into a ref so
  // the force and the tick handler (which live outside React) can read it too.
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    const bump = (id: string) => d.set(id, (d.get(id) ?? 0) + 1);
    for (const e of edges) {
      // Count references INTO a row, not out of it. How many FKs a row points
      // out along is fixed by its table's schema, so counting those would size
      // rows by which table they came from rather than by how central they are.
      bump(e.target);
      // A dissolved junction edge stands for a many-to-many association and its
      // direction is arbitrary (whichever forward edge deriveView saw first),
      // so it counts for both partners.
      if (e.dissolved) bump(e.source);
    }
    return d;
  }, [edges]);
  const degreeRef = useRef(degree);
  degreeRef.current = degree;

  const radiusOf = (id: string) => radiusForDegree(degreeRef.current.get(id) ?? 0);
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
      const sx = s.x ?? 0;
      const sy = s.y ?? 0;
      const tx = t.x ?? 0;
      const ty = t.y ?? 0;
      // Stop the line just short of the target circle. Node radii now vary, so
      // the arrowhead can't be offset by a constant in the marker — it would
      // sink inside big nodes and float away from small ones.
      const dx = tx - sx;
      const dy = ty - sy;
      const len = Math.hypot(dx, dy) || 1;
      const back = radiusOf(t.id) + ARROW_GAP;
      el.setAttribute('x1', String(sx));
      el.setAttribute('y1', String(sy));
      el.setAttribute('x2', String(tx - (dx / len) * back));
      el.setAttribute('y2', String(ty - (dy / len) * back));
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

  /**
   * Centering gravity: wanted while a full re-layout compacts the whole graph,
   * unwanted during incremental growth (it would tug freshly-unpinned nodes,
   * including the one just expanded, back toward the middle of the canvas).
   */
  const setGravity = (strength: number) => {
    const sim = simRef.current;
    if (!sim) return;
    (sim.force('x') as ForceX<SimNode>).strength(strength);
    (sim.force('y') as ForceY<SimNode>).strength(strength);
  };

  /** Freeze every placed node where it sits, so later arrivals can't shove it. */
  const pinSettled = () => {
    setGravity(0); // a re-layout is over by the time we settle
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
        // an expansion.
        //
        // Centering gravity starts at zero for the same reason: it pulls
        // whatever is currently unpinned toward the middle, which drags the
        // node you just expanded away from where you left it. It is switched on
        // only for a full re-layout (see setGravity).
        .force('x', forceX(W / 2).strength(0))
        .force('y', forceY(H / 2).strength(0))
        .force(
          'collide',
          forceCollide<SimNode>().radius((d) => radiusOf(d.id) + COLLIDE_PAD),
        )
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
    // Count of rows already placed around each parent this pass, so a batch
    // fans out around it instead of landing in one pile.
    const placedNear = new Map<string, number>();
    // Spawn new elements next to an already-placed neighbor so expansions
    // grow outward instead of flying in from the center.
    const spawn = (id: string, nearId?: string) => {
      if (simNodes.has(id)) return;
      arrived.add(id);
      let x = W / 2;
      let y = H / 2;
      let anchor = '';
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
          anchor = otherId;
          break;
        }
      }
      // Lay the batch out on a spiral around the parent rather than dropping 25
      // rows on the same point: piled-up nodes repel each other hard enough to
      // shove the parent (and its neighbourhood) across the canvas before the
      // layout untangles.
      const i = placedNear.get(anchor) ?? 0;
      placedNear.set(anchor, i + 1);
      const angle = i * 2.39996; // golden angle: successive rows land apart
      const radius = SPAWN_RADIUS * Math.sqrt(1 + i * 0.5);
      simNodes.set(id, {
        id,
        x: x + Math.cos(angle) * radius,
        y: y + Math.sin(angle) * radius,
      });
    };
    for (const n of nodes) spawn(n.id);
    for (const p of pills) spawn(p.id, p.parentNodeId);

    simLinksRef.current = edges
      .filter((e) => simNodes.has(e.source) && simNodes.has(e.target))
      .map((e) => ({ id: e.id, source: e.source, target: e.target }));

    sim.nodes([...simNodes.values()]);
    (sim.force('link') as ForceLink<SimNode, SimLink>).links(simLinksRef.current);
    // Reheat only when something actually arrived — and deliberately DON'T
    // unpin anything already on screen. Freeing the expanded node would let its
    // existing links haul it back toward its neighbours (and out of wherever
    // you put it) before the new rows even appear. New nodes are unpinned by
    // construction, they spawn spread around their parent, and collision
    // resolves against pinned nodes one-sidedly — so the newcomers find their
    // own space while the map you've built stays exactly as it is.
    if (arrived.size > 0) sim.alpha(REHEAT_ALPHA).restart();
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
    // Everything is free now, so centering gravity is safe and wanted: it pulls
    // the graph back into a compact shape. pinSettled turns it off again.
    getSim();
    setGravity(RELAYOUT_GRAVITY);
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
        {/* refX puts the path's tip at the line's end point, which
            applyPositions has already pulled back to the target circle's edge. */}
        <marker
          id="arrow"
          markerUnits="userSpaceOnUse"
          markerWidth="12"
          markerHeight="12"
          refX={ARROW_LEN}
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
        {nodes.map((n) => {
          const deg = degree.get(n.id) ?? 0;
          const r = radiusForDegree(deg);
          return (
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
            >
              <title>
                {`${n.table}\n` +
                  Object.entries(n.pk)
                    .map(([k, v]) => `${k} = ${String(v)}`)
                    .join('\n') +
                  `\nreferenced by ${deg} shown ${deg === 1 ? 'row' : 'rows'}` +
                  '\nclick to inspect'}
              </title>
              <circle r={r} fill={colorFor(n.table)} />
              <text dy={r + 14}>{n.label}</text>
            </g>
          );
        })}
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
