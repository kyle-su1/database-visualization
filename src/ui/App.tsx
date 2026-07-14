import { useEffect, useRef, useState } from 'react';
import type { DataSource, DatabaseSchema } from '../datasource/types';
import { createSqlJsDataSource } from '../datasource/sqljs';
import { tableColor } from '../schema/display';
import {
  addSeed,
  emptyGraph,
  expandNode,
  type GraphNode,
  type GraphState,
} from '../graph/session';
import { GraphCanvas } from './GraphCanvas';
import { Legend } from './Legend';

const FIXTURE = 'Chinook.sqlite';

export function App() {
  const [ds, setDs] = useState<DataSource | null>(null);
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [graph, setGraph] = useState<GraphState>(emptyGraph());
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

      // Phase 1 seed: first row of the first non-empty table.
      const seedTable = dbSchema.tables.find((t) => t.rowCount > 0);
      if (!seedTable) throw new Error('Database contains no rows');
      const [seedRow] = await source.getRows(seedTable.name, { limit: 1 });

      if (cancelled) return;
      setDs(source);
      setSchema(dbSchema);
      setGraph(addSeed(emptyGraph(), seedTable, seedRow));
      setStatus(
        `${FIXTURE} — ${dbSchema.tables.length} tables. Seeded ${seedTable.name}; click the node to expand.`,
      );
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleNodeClick = async (node: GraphNode) => {
    if (!ds || !schema || expanding.current) return;
    expanding.current = true;
    setStatus(`Expanding ${node.table}: ${node.label}…`);
    try {
      const result = await expandNode(ds, schema, graph, node);
      setGraph(result.state);
      let msg = `Expanded ${node.table}: ${node.label} — +${result.addedNodes} nodes, +${result.addedEdges} edges`;
      if (result.truncated.length > 0) msg += ` · truncated: ${result.truncated.join(', ')}`;
      setStatus(msg);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      expanding.current = false;
    }
  };

  const nodes = [...graph.nodes.values()];
  const edges = [...graph.edges.values()];
  const tablesInGraph = [...new Set(nodes.map((n) => n.table))];
  const colorFor = (table: string) => (schema ? tableColor(schema, table) : '#999');

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
          edges={edges}
          expandedIds={graph.expanded}
          colorFor={colorFor}
          onNodeClick={handleNodeClick}
        />
        <Legend tables={tablesInGraph} colorFor={colorFor} />
      </main>
      <footer>
        {nodes.length} nodes · {edges.length} edges · click a node to expand its
        foreign-key neighbors
      </footer>
    </div>
  );
}
