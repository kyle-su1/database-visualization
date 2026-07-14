import type {
  DataSource,
  DatabaseSchema,
  PkValue,
  Row,
  SqlValue,
  TableSchema,
} from '../datasource/types';
import { relationshipsFor, tableByName } from '../schema/relationships';
import { rowLabel } from '../schema/display';

export interface GraphNode {
  /** Deterministic identity: table + PK values. Re-expanding converges, never duplicates. */
  id: string;
  table: string;
  pk: PkValue;
  values: Record<string, SqlValue>;
  label: string;
}

export interface GraphEdge {
  id: string;
  /** Child node id (FK owner). */
  source: string;
  /** Parent node id (FK target). */
  target: string;
  /** e.g. "Album.ArtistId" */
  label: string;
}

export interface GraphState {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  /** Node ids whose neighbors have already been fetched. */
  expanded: Set<string>;
}

/** How many children one reverse expansion may pull in (v1 hub guardrail). */
export const REVERSE_EXPAND_LIMIT = 25;

export function emptyGraph(): GraphState {
  return { nodes: new Map(), edges: new Map(), expanded: new Set() };
}

export function nodeIdFor(t: TableSchema, pk: PkValue): string {
  return t.name + '|' + t.pk.map((c) => JSON.stringify(String(pk[c]))).join(',');
}

export function makeNode(t: TableSchema, row: Row): GraphNode {
  return {
    id: nodeIdFor(t, row.pk),
    table: t.name,
    pk: row.pk,
    values: row.values,
    label: rowLabel(t, row),
  };
}

export function addSeed(state: GraphState, t: TableSchema, row: Row): GraphState {
  const node = makeNode(t, row);
  const nodes = new Map(state.nodes);
  nodes.set(node.id, node);
  return { ...state, nodes };
}

export interface ExpandResult {
  state: GraphState;
  addedNodes: number;
  addedEdges: number;
  /** Reverse relationships that hit REVERSE_EXPAND_LIMIT: "Track (25 of 214)". */
  truncated: string[];
}

/**
 * Expand a node one hop in both directions:
 * - forward: follow each FK on this row to its single parent row
 * - reverse: fetch rows in other tables whose FK points back at this row
 *
 * Pure graph logic over the DataSource interface; no sql.js here.
 */
export async function expandNode(
  ds: DataSource,
  schema: DatabaseSchema,
  state: GraphState,
  node: GraphNode,
): Promise<ExpandResult> {
  const nodes = new Map(state.nodes);
  const edges = new Map(state.edges);
  const expanded = new Set(state.expanded);
  let addedNodes = 0;
  let addedEdges = 0;
  const truncated: string[] = [];

  const addNode = (n: GraphNode) => {
    if (!nodes.has(n.id)) {
      nodes.set(n.id, n);
      addedNodes++;
    }
  };
  const addEdge = (childId: string, fkLabel: string, parentId: string) => {
    const id = `${childId} -${fkLabel}-> ${parentId}`;
    if (!edges.has(id)) {
      edges.set(id, { id, source: childId, target: parentId, label: fkLabel });
      addedEdges++;
    }
  };

  for (const rel of relationshipsFor(schema, node.table)) {
    const fkLabel = `${rel.childTable}.${rel.fk.columns.join('+')}`;

    if (rel.kind === 'forward') {
      // child (this node) -> one parent row
      const key: PkValue = {};
      let hasNull = false;
      rel.fk.columns.forEach((c, i) => {
        const v = node.values[c];
        if (v == null) hasNull = true;
        else key[rel.fk.refColumns[i]] = v;
      });
      if (hasNull) continue; // nullable FK not set on this row
      const parentT = tableByName(schema, rel.parentTable);
      const row = await ds.getRow(rel.parentTable, key);
      if (!row) continue; // dangling FK
      const parent = makeNode(parentT, row);
      addNode(parent);
      addEdge(node.id, fkLabel, parent.id);
    } else {
      // parent (this node) <- many child rows
      const refValues: PkValue = {};
      let hasNull = false;
      rel.fk.columns.forEach((c, i) => {
        const v = node.values[rel.fk.refColumns[i]];
        if (v == null) hasNull = true;
        else refValues[c] = v;
      });
      if (hasNull) continue;
      const childT = tableByName(schema, rel.childTable);
      const { rows, totalCount } = await ds.getReferencingRows(
        rel.childTable,
        rel.fk.id,
        refValues,
        { limit: REVERSE_EXPAND_LIMIT },
      );
      if (totalCount > rows.length) {
        truncated.push(`${rel.childTable} (${rows.length} of ${totalCount})`);
      }
      for (const row of rows) {
        const child = makeNode(childT, row);
        addNode(child);
        addEdge(child.id, fkLabel, node.id);
      }
    }
  }

  expanded.add(node.id);
  return { state: { nodes, edges, expanded }, addedNodes, addedEdges, truncated };
}
