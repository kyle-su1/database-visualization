import type {
  DataSource,
  DatabaseSchema,
  FkSchema,
  PkValue,
  Row,
  SqlValue,
  TableSchema,
} from '@dbviz/shared';
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

/**
 * Max DataSource fetches in flight per expansion step. Over HTTP each fetch is
 * a round trip, so batching them is what keeps an expansion responsive; the cap
 * keeps the server's connection pool (and the browser) from being swamped.
 */
const FETCH_CONCURRENCY = 8;

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
  /**
   * Added node/pill ids grouped by the query that fetched them, in query
   * order: a reverse expansion is ONE group (one query, many rows); each
   * forward or junction-partner hop is its own single-id group. Drives the
   * staggered-arrival animation — reveal cadence = real query cadence.
   */
  addedGroups: string[][];
}

export interface ExpandOptions {
  /**
   * Junction tables to traverse THROUGH: when a reverse expansion pulls in
   * rows of one of these tables, each row's other forward FK is followed
   * immediately so both endpoints exist and the view can dissolve the row
   * into a direct edge.
   */
  junctions?: Set<string>;
  /**
   * Restrict a node expansion to a single FK direction — 'forward' (follow
   * this row's FKs to its parents) or 'reverse' (pull in rows that reference
   * this row). Omitted = both. Ignored by expandRelationship (already scoped).
   */
  direction?: 'forward' | 'reverse';
}

/** Expand a single relationship of a node. Idempotent per (node, relationship). */
export async function expandRelationship(
  ds: DataSource,
  schema: DatabaseSchema,
  state: GraphState,
  node: GraphNode,
  rel: Relationship,
  opts: ExpandOptions = {},
): Promise<ExpandResult> {
  const d = draft(state);
  const rk = node.id + '::' + relKey(rel);
  if (d.state.expandedRels.has(rk)) return result(d);
  d.state.expandedRels.add(rk);
  const fkLabel = `${rel.childTable}.${rel.fk.columns.join('+')}`;

  if (rel.kind === 'forward') {
    // child (this node) -> one parent row
    await forwardExpand(ds, schema, d, node, rel.fk, rel.childTable);
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
    const childNodes: GraphNode[] = [];
    const groupIds: string[] = [];
    for (const row of rows) {
      const child = makeNode(childT, row);
      if (addNode(d, child)) groupIds.push(child.id);
      addEdge(d, child.id, fkLabel, node.id);
      childNodes.push(child);
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
      groupIds.push(pill.id); // the pill comes from the same query's totalCount
    }
    // ONE group: however many rows arrived, this was a single query.
    if (groupIds.length > 0) d.groups.push(groupIds);
    if (opts.junctions?.has(rel.childTable)) {
      await traverseJunctionRows(ds, schema, d, childT, childNodes, rel.fk.id);
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
  opts: ExpandOptions = {},
): Promise<ExpandResult> {
  let current = state;
  let addedNodes = 0;
  let addedEdges = 0;
  const truncated: string[] = [];
  const addedGroups: string[][] = [];
  for (const rel of relationshipsFor(schema, node.table)) {
    if (opts.direction && rel.kind !== opts.direction) continue;
    const r = await expandRelationship(ds, schema, current, node, rel, opts);
    current = r.state;
    addedNodes += r.addedNodes;
    addedEdges += r.addedEdges;
    truncated.push(...r.truncated);
    addedGroups.push(...r.addedGroups);
  }
  return { state: current, addedNodes, addedEdges, truncated, addedGroups };
}

/**
 * Expand every node that is not yet fully expanded, one hop each.
 * Snapshots the node list first: nodes added during this pass are NOT
 * expanded (strictly one hop per invocation).
 */
export async function expandAllNodes(
  ds: DataSource,
  schema: DatabaseSchema,
  state: GraphState,
  opts: ExpandOptions = {},
): Promise<ExpandResult> {
  const targets = [...state.nodes.values()].filter((n) => !isFullyExpanded(schema, state, n));
  let current = state;
  let addedNodes = 0;
  let addedEdges = 0;
  const truncated: string[] = [];
  const addedGroups: string[][] = [];
  for (const node of targets) {
    const r = await expandNode(ds, schema, current, node, opts);
    current = r.state;
    addedNodes += r.addedNodes;
    addedEdges += r.addedEdges;
    truncated.push(...r.truncated);
    addedGroups.push(...r.addedGroups);
  }
  return { state: current, addedNodes, addedEdges, truncated, addedGroups };
}

/**
 * Fetch the missing forward partners of junction-table rows already in the
 * graph (used when junction dissolution is switched on mid-session).
 */
export async function completeJunctionNodes(
  ds: DataSource,
  schema: DatabaseSchema,
  state: GraphState,
  junctions: Set<string>,
): Promise<ExpandResult> {
  let current = state;
  let addedNodes = 0;
  let addedEdges = 0;
  const truncated: string[] = [];
  const addedGroups: string[][] = [];
  for (const node of [...state.nodes.values()]) {
    if (!junctions.has(node.table)) continue;
    for (const rel of relationshipsFor(schema, node.table)) {
      if (rel.kind !== 'forward') continue;
      const r = await expandRelationship(ds, schema, current, node, rel);
      current = r.state;
      addedNodes += r.addedNodes;
      addedEdges += r.addedEdges;
      truncated.push(...r.truncated);
      addedGroups.push(...r.addedGroups);
    }
  }
  return { state: current, addedNodes, addedEdges, truncated, addedGroups };
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
  const groupIds: string[] = [];
  for (const row of rows) {
    const child = makeNode(childT, row);
    if (addNode(d, child)) groupIds.push(child.id);
    addEdge(d, child.id, pill.fkLabel, pill.parentNodeId);
  }
  if (groupIds.length > 0) d.groups.push(groupIds); // one page = one query

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
  /** Added ids per query — see ExpandResult.addedGroups. */
  groups: string[][];
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
    groups: [],
  };
}

function result(d: Draft): ExpandResult {
  return {
    state: d.state,
    addedNodes: d.addedNodes,
    addedEdges: d.addedEdges,
    truncated: d.truncated,
    addedGroups: d.groups,
  };
}

/** @returns true if the node was new (not already in the graph). */
function addNode(d: Draft, n: GraphNode): boolean {
  if (d.state.nodes.has(n.id)) return false;
  d.state.nodes.set(n.id, n);
  d.addedNodes++;
  return true;
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

/** Follow one FK on `node` to its single parent row; adds node + edge. */
async function forwardExpand(
  ds: DataSource,
  schema: DatabaseSchema,
  d: Draft,
  node: GraphNode,
  fk: FkSchema,
  childTable: string,
): Promise<void> {
  const key = forwardKey(node, fk);
  if (!key) return; // nullable FK not set on this row
  const row = await ds.getRow(fk.refTable, key);
  if (!row) return; // dangling FK
  applyForward(d, schema, node, fk, childTable, row);
}

/** Parent-side key for following `fk` from `node`; null if any FK column is NULL. */
function forwardKey(node: GraphNode, fk: FkSchema): PkValue | null {
  const key: PkValue = {};
  for (let i = 0; i < fk.columns.length; i++) {
    const v = node.values[fk.columns[i]];
    if (v == null) return null;
    key[fk.refColumns[i]] = v;
  }
  return key;
}

/** Add the parent row fetched for a forward FK, plus the edge pointing at it. */
function applyForward(
  d: Draft,
  schema: DatabaseSchema,
  node: GraphNode,
  fk: FkSchema,
  childTable: string,
  row: Row,
): void {
  const parent = makeNode(tableByName(schema, fk.refTable), row);
  if (addNode(d, parent)) d.groups.push([parent.id]); // one query, one node
  addEdge(d, node.id, `${childTable}.${fk.columns.join('+')}`, parent.id);
}

/**
 * For each junction row just pulled in, immediately follow its OTHER forward
 * FK (the one not pointing back at the node being expanded), so the row can
 * be dissolved into a direct edge in the view.
 */
async function traverseJunctionRows(
  ds: DataSource,
  schema: DatabaseSchema,
  d: Draft,
  junctionT: TableSchema,
  rowNodes: GraphNode[],
  viaFkId: number,
): Promise<void> {
  // Collect every partner row up front, then fetch the whole batch with bounded
  // concurrency. Fetching these one await at a time is the dominant cost of an
  // expansion over HTTP: one blocking round trip per junction row.
  const pending: { rowNode: GraphNode; fk: FkSchema; key: PkValue }[] = [];
  for (const rowNode of rowNodes) {
    for (const fk of junctionT.fks) {
      if (fk.id === viaFkId) continue;
      const rk =
        rowNode.id +
        '::' +
        relKey({ kind: 'forward', childTable: junctionT.name, fk, parentTable: fk.refTable });
      if (d.state.expandedRels.has(rk)) continue;
      d.state.expandedRels.add(rk);
      const key = forwardKey(rowNode, fk);
      if (key) pending.push({ rowNode, fk, key });
    }
  }
  const rows = await mapLimit(pending, FETCH_CONCURRENCY, (p) => ds.getRow(p.fk.refTable, p.key));
  // Apply in request order, so nodes and edges land deterministically
  // regardless of the order responses came back in.
  rows.forEach((row, i) => {
    if (!row) return; // dangling FK
    const p = pending[i];
    applyForward(d, schema, p.rowNode, p.fk, junctionT.name, row);
  });
}

/** Run `fn` over `items` with bounded concurrency, preserving result order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
