import type { GraphEdge, GraphNode, GraphState, PillNode } from './session';

export interface ViewEdge extends GraphEdge {
  /** True for a synthetic edge standing in for a hidden junction row. */
  dissolved?: boolean;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: ViewEdge[];
  pills: PillNode[];
}

/**
 * Pure view transform: junction-table rows whose BOTH forward edges are
 * present are hidden and replaced with a single dashed edge connecting the
 * two referenced rows. The underlying GraphState is untouched — toggling
 * dissolution is instant and lossless.
 */
export function deriveView(state: GraphState, dissolve: Set<string>): GraphView {
  const allNodes = [...state.nodes.values()];
  const allEdges = [...state.edges.values()];
  const pills = [...state.pills.values()];
  if (dissolve.size === 0) return { nodes: allNodes, edges: allEdges, pills };

  const incident = new Map<string, GraphEdge[]>();
  for (const e of allEdges) {
    for (const id of [e.source, e.target]) {
      const list = incident.get(id);
      if (list) list.push(e);
      else incident.set(id, [e]);
    }
  }
  const pillParents = new Set(pills.map((p) => p.parentNodeId));

  const hidden = new Set<string>();
  const removedEdges = new Set<string>();
  const synthetic: ViewEdge[] = [];
  for (const n of allNodes) {
    if (!dissolve.has(n.table)) continue;
    const inc = incident.get(n.id) ?? [];
    const fwd = inc.filter((e) => e.source === n.id);
    // Only dissolve when the row's whole neighborhood is its two forward
    // edges — otherwise (partner not fetched yet, or something references
    // the junction row) keep it visible rather than hide information.
    if (fwd.length !== 2 || inc.length !== 2 || pillParents.has(n.id)) continue;
    hidden.add(n.id);
    removedEdges.add(fwd[0].id);
    removedEdges.add(fwd[1].id);
    synthetic.push({
      id: `dissolved|${n.id}`,
      source: fwd[0].target,
      target: fwd[1].target,
      label: `${n.table}: ${n.label}`,
      dissolved: true,
    });
  }

  return {
    nodes: allNodes.filter((n) => !hidden.has(n.id)),
    edges: [...allEdges.filter((e) => !removedEdges.has(e.id)), ...synthetic],
    pills,
  };
}
