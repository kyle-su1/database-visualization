import type {
  DataSource,
  DatabaseSchema,
  PkValue,
  Row,
  SqlValue,
  TableSchema,
} from '../datasource/types';
import { relationshipsFor, tableByName, type Relationship } from '../schema/relationships';
import { rowLabel } from '../schema/display';

export interface GraphNode {
  /** Deterministic identity: table + PK values. Re-expanding converges, never duplicates. */
  id: string;
  table: string;
  pk: PkValue;
  values: Record<string, SqlValue>;
  label: string;
}

/** Placeholder node for a truncated reverse expansion ("+N more"). */
export interface PillNode {
  id: string;
  parentNodeId: string;
  childTable: string;
  fkId: number;
  fkLabel: string;
  refValues: PkValue;
  /** Rows fetched so far for this relationship. */
  fetched: number;
  total: number;
}

export interface GraphEdge {
  id: string;
  /** Child node id (FK owner) — or a pill id. */
  source: string;
  /** Parent node id (FK target). */
  target: string;
  /** e.g. "Album.ArtistId" */
  label: string;
}

export interface GraphState {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  pills: Map<string, PillNode>;
  /** `${nodeId}::${relKey}` entries for relationships already fetched. */
  expandedRels: Set<string>;
}

/** How many children one reverse expansion may pull in (v1 hub guardrail). */
export const REVERSE_EXPAND_LIMIT = 25;

export function emptyGraph(): GraphState {
  return { nodes: new Map(), edges: new Map(), pills: new Map(), expandedRels: new Set() };
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

export function relKey(rel: Relationship): string {
  return `${rel.kind}:${rel.childTable}#${rel.fk.id}`;
}

export function isRelExpanded(state: GraphState, nodeId: string, rel: Relationship): boolean {
  return state.expandedRels.has(nodeId + '::' + relKey(rel));
}

export function isFullyExpanded(
  schema: DatabaseSchema,
  state: GraphState,
  node: GraphNode,
): boolean {
  return relationshipsFor(schema, node.table).every((r) => isRelExpanded(state, node.id, r));
}

/**
 * How many rows one relationship expansion would add.
 * Forward needs no query (1 if the FK is set, else 0).
 */
export async function countRelationship(
  ds: DataSource,
  node: GraphNode,
  rel: Relationship,
): Promise<number> {
  if (rel.kind === 'forward') {
    return rel.fk.columns.every((c) => node.values[c] != null) ? 1 : 0;
  }
  const refValues = reverseRefValues(node, rel);
  if (!refValues) return 0;
  const { totalCount } = await ds.getReferencingRows(rel.childTable, rel.fk.id, refValues, {
    limit: 0,
  });
  return totalCount;
}

export interface ExpandResult {
  state: GraphState;
  addedNodes: number;
  addedEdges: number;
  /** Reverse relationships that hit REVERSE_EXPAND_LIMIT: "Track (25 of 214)". */
  truncated: string[];
}

/** Expand a single relationship of a node. Idempotent per (node, relationship). */
export async function expandRelationship(
  ds: DataSource,
  schema: DatabaseSchema,
  state: GraphState,
  node: GraphNode,
  rel: Relationship,
): Promise<ExpandResult> {
  const d = draft(state);
  const rk = node.id + '::' + relKey(rel);
  if (d.state.expandedRels.has(rk)) return result(d);
  d.state.expandedRels.add(rk);
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
    if (hasNull) return result(d); // nullable FK not set on this row
    const row = await ds.getRow(rel.parentTable, key);
    if (!row) return result(d); // dangling FK
    const parent = makeNode(tableByName(schema, rel.parentTable), row);
    addNode(d, parent);
    addEdge(d, node.id, fkLabel, parent.id);
  } else {
    // parent (this node) <- many child rows
    const refValues = reverseRefValues(node, rel);
    if (!refValues) return result(d);
    const childT = tableByName(schema, rel.childTable);
    const { rows, totalCount } = await ds.getReferencingRows(
      rel.childTable,
      rel.fk.id,
      refValues,
      { limit: REVERSE_EXPAND_LIMIT },
    );
    for (const row of rows) {
      const child = makeNode(childT, row);
      addNode(d, child);
      addEdge(d, child.id, fkLabel, node.id);
    }
    if (totalCount > rows.length) {
      d.truncated.push(`${rel.childTable} (${rows.length} of ${totalCount})`);
      const pill: PillNode = {
        id: `more|${node.id}|${relKey(rel)}`,
        parentNodeId: node.id,
        childTable: rel.childTable,
        fkId: rel.fk.id,
        fkLabel,
        refValues,
        fetched: rows.length,
        total: totalCount,
      };
      d.state.pills.set(pill.id, pill);
      d.state.edges.set(pillEdgeId(pill), {
        id: pillEdgeId(pill),
        source: pill.id,
        target: node.id,
        label: fkLabel,
      });
    }
  }
  return result(d);
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
  let current = state;
  let addedNodes = 0;
  let addedEdges = 0;
  const truncated: string[] = [];
  for (const rel of relationshipsFor(schema, node.table)) {
    const r = await expandRelationship(ds, schema, current, node, rel);
    current = r.state;
    addedNodes += r.addedNodes;
    addedEdges += r.addedEdges;
    truncated.push(...r.truncated);
  }
  return { state: current, addedNodes, addedEdges, truncated };
}

/** Fetch the next page of a truncated expansion; shrinks or removes the pill. */
export async function expandMore(
  ds: DataSource,
  schema: DatabaseSchema,
  state: GraphState,
  pill: PillNode,
): Promise<ExpandResult> {
  const d = draft(state);
  const childT = tableByName(schema, pill.childTable);
  const { rows, totalCount } = await ds.getReferencingRows(
    pill.childTable,
    pill.fkId,
    pill.refValues,
    { limit: REVERSE_EXPAND_LIMIT, offset: pill.fetched },
  );
  for (const row of rows) {
    const child = makeNode(childT, row);
    addNode(d, child);
    addEdge(d, child.id, pill.fkLabel, pill.parentNodeId);
  }
  const fetched = pill.fetched + rows.length;
  if (fetched >= totalCount || rows.length === 0) {
    d.state.pills.delete(pill.id);
    d.state.edges.delete(pillEdgeId(pill));
  } else {
    d.state.pills.set(pill.id, { ...pill, fetched, total: totalCount });
    d.truncated.push(`${pill.childTable} (${fetched} of ${totalCount})`);
  }
  return result(d);
}

// ----------------------------------------------------------------- internals

interface Draft {
  state: GraphState;
  addedNodes: number;
  addedEdges: number;
  truncated: string[];
}

function draft(state: GraphState): Draft {
  return {
    state: {
      nodes: new Map(state.nodes),
      edges: new Map(state.edges),
      pills: new Map(state.pills),
      expandedRels: new Set(state.expandedRels),
    },
    addedNodes: 0,
    addedEdges: 0,
    truncated: [],
  };
}

function result(d: Draft): ExpandResult {
  return { state: d.state, addedNodes: d.addedNodes, addedEdges: d.addedEdges, truncated: d.truncated };
}

function addNode(d: Draft, n: GraphNode): void {
  if (!d.state.nodes.has(n.id)) {
    d.state.nodes.set(n.id, n);
    d.addedNodes++;
  }
}

function addEdge(d: Draft, childId: string, fkLabel: string, parentId: string): void {
  const id = `${childId} -${fkLabel}-> ${parentId}`;
  if (!d.state.edges.has(id)) {
    d.state.edges.set(id, { id, source: childId, target: parentId, label: fkLabel });
    d.addedEdges++;
  }
}

function pillEdgeId(pill: PillNode): string {
  return `pill-edge|${pill.id}`;
}

/** Child-column -> value map for a reverse expansion, or null if any value is NULL. */
function reverseRefValues(node: GraphNode, rel: Relationship): PkValue | null {
  const refValues: PkValue = {};
  for (let i = 0; i < rel.fk.columns.length; i++) {
    const v = node.values[rel.fk.refColumns[i]];
    if (v == null) return null;
    refValues[rel.fk.columns[i]] = v;
  }
  return refValues;
}
