import { useCallback, useEffect, useRef, useState } from 'react';
import type { DataSource, DatabaseSchema, Row } from '../datasource/types';
import { createSqlJsDataSource } from '../datasource/sqljs';
import { tableColor } from '../schema/display';
import { relationshipsFor, tableByName, type Relationship } from '../schema/relationships';
import {
  addSeed,
  countRelationship,
  emptyGraph,
  expandMore,
  expandNode,
  expandRelationship,
  isFullyExpanded,
  isRelExpanded,
  makeNode,
  relKey,
  type ExpandResult,
  type GraphNode,
  type GraphState,
  type PillNode,
} from '../graph/session';
import { GraphCanvas } from './GraphCanvas';
import { Legend } from './Legend';
import { SeedPicker } from './SeedPicker';
import { Inspector, type RelEntry } from './Inspector';

const FIXTURE = 'Chinook.sqlite';

export function App() {
  const [ds, setDs] = useState<DataSource | null>(null);
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [graph, setGraph] = useState<GraphState>(emptyGraph());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState('Loading database…');
  const [error, setError] = useState<string | null>(null);
  const expanding = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(import.meta.env.BASE_URL + FIXTURE);
      if (!res.ok) throw new Error(`Failed to fetch ${FIXTURE}: ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const source = await createSqlJsDataSource(buf, FIXTURE);
      const dbSchema = await source.getSchema();

      // Default seed: first row of the first non-empty table.
      const seedTable = dbSchema.tables.find((t) => t.rowCount > 0);
      if (!seedTable) throw new Error('Database contains no rows');
      const [seedRow] = await source.getRows(seedTable.name, { limit: 1 });

      if (cancelled) return;
      setDs(source);
      setSchema(dbSchema);
      setGraph(addSeed(emptyGraph(), seedTable, seedRow));
      setStatus(
        `${FIXTURE} — ${dbSchema.tables.length} tables. Seeded ${seedTable.name}; click a node to inspect, double-click to expand.`,
      );
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedNode = selectedId ? (graph.nodes.get(selectedId) ?? null) : null;

  // Eagerly count each relationship of the selected node so one-vs-many is
  // visible before the graph pays for an expansion.
  useEffect(() => {
    if (!ds || !schema || !selectedNode) return;
    let cancelled = false;
    (async () => {
      const rels = relationshipsFor(schema, selectedNode.table);
      const entries = await Promise.all(
        rels.map(async (rel) => [relKey(rel), await countRelationship(ds, selectedNode, rel)]),
      );
      if (!cancelled) setCounts(Object.fromEntries(entries));
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ds, schema, selectedId, selectedNode]);

  const runExpansion = async (fn: () => Promise<ExpandResult>, what: string) => {
    if (expanding.current) return;
    expanding.current = true;
    setStatus(`Expanding ${what}…`);
    try {
      const result = await fn();
      setGraph(result.state);
      let msg = `Expanded ${what} — +${result.addedNodes} nodes, +${result.addedEdges} edges`;
      if (result.truncated.length > 0) msg += ` · truncated: ${result.truncated.join(', ')}`;
      setStatus(msg);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      expanding.current = false;
    }
  };

  const handleExpandAll = (node: GraphNode) => {
    if (!ds || !schema) return;
    void runExpansion(() => expandNode(ds, schema, graph, node), `${node.table}: ${node.label}`);
  };

  const handleExpandRel = (rel: Relationship) => {
    if (!ds || !schema || !selectedNode) return;
    const desc =
      rel.kind === 'forward' ? `→ ${rel.parentTable}` : `← ${rel.childTable}`;
    void runExpansion(
      () => expandRelationship(ds, schema, graph, selectedNode, rel),
      `${selectedNode.label} ${desc}`,
    );
  };

  const handlePillClick = (pill: PillNode) => {
    if (!ds || !schema) return;
    void runExpansion(() => expandMore(ds, schema, graph, pill), `more ${pill.childTable}`);
  };

  const searchRows = useCallback(
    (table: string, text: string) =>
      ds ? ds.getRows(table, { limit: 20, searchText: text || undefined }) : Promise.resolve([]),
    [ds],
  );

  const handlePickSeed = (table: string, row: Row) => {
    if (!schema) return;
    const t = tableByName(schema, table);
    const node = makeNode(t, row);
    setGraph((g) => addSeed(g, t, row));
    setSelectedId(node.id);
    setStatus(`Added seed ${table}: ${node.label}`);
  };

  const handleClear = () => {
    setGraph(emptyGraph());
    setSelectedId(null);
    setStatus('Graph cleared — pick a seed row.');
  };

  const nodes = [...graph.nodes.values()];
  const edges = [...graph.edges.values()];
  const pills = [...graph.pills.values()];
  const tablesInGraph = [...new Set(nodes.map((n) => n.table))];
  const colorFor = (table: string) => (schema ? tableColor(schema, table) : '#999');

  const relEntries: RelEntry[] =
    schema && selectedNode
      ? relationshipsFor(schema, selectedNode.table).map((rel) => ({
          rel,
          key: relKey(rel),
          expanded: isRelExpanded(graph, selectedNode.id, rel),
          count: counts[relKey(rel)] ?? null,
        }))
      : [];

  if (error) {
    return (
      <div className="app">
        <div className="error">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>Relational Data Graph Explorer</h1>
        <span className="status">{status}</span>
      </header>
      <main>
        <GraphCanvas
          nodes={nodes}
          pills={pills}
          edges={edges}
          selectedId={selectedId}
          isExpanded={(n) => (schema ? isFullyExpanded(schema, graph, n) : false)}
          colorFor={colorFor}
          onNodeClick={(n) => setSelectedId(n.id)}
          onNodeDoubleClick={handleExpandAll}
          onPillClick={handlePillClick}
        />
        {schema && (
          <SeedPicker
            schema={schema}
            colorFor={colorFor}
            search={searchRows}
            onPick={handlePickSeed}
            onClear={handleClear}
            hasGraph={nodes.length > 0}
          />
        )}
        {selectedNode && (
          <Inspector
            node={selectedNode}
            entries={relEntries}
            colorFor={colorFor}
            onExpandRel={handleExpandRel}
            onExpandAll={() => handleExpandAll(selectedNode)}
            onClose={() => setSelectedId(null)}
          />
        )}
        <Legend tables={tablesInGraph} colorFor={colorFor} />
      </main>
      <footer>
        {nodes.length} nodes · {edges.length} edges · click a node to inspect ·
        double-click to expand all its relationships
      </footer>
    </div>
  );
}
