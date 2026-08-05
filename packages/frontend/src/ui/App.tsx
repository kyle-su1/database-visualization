import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DataSource, DatabaseSchema, Row, TableSchema } from '@dbviz/shared';
import { createSqlJsDataSource } from '../datasource/sqljs';
import { createHttpDataSource } from '../datasource/http';
import { tableColor } from '../schema/display';
import { relationshipsFor, tableByName, type Relationship } from '../schema/relationships';
import { detectJunctionTables, effectiveJunctions } from '../schema/junctions';
import {
  addSeed,
  alreadyPresent,
  completeJunctionNodes,
  countRelationship,
  emptyGraph,
  expandAllNodes,
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
import { deriveView } from '../graph/view';
import { GraphCanvas } from './GraphCanvas';
import { Legend } from './Legend';
import { SeedPicker } from './SeedPicker';
import { Inspector, type RelEntry } from './Inspector';
import { QueryLog, type ExpansionSpan } from './QueryLog';

const FIXTURE = 'Chinook.sqlite';

/** Whole staggered reveal must finish within this, however many queries fired. */
const MAX_REVEAL_TOTAL_MS = 2000;

/** One reveal tick: the nodes/pills a single query fetched, shown together. */
interface RevealGroup {
  ids: string[];
  delay: number;
}

/**
 * Choose a seed row by probing tables in schema order and taking the first that
 * actually returns a row. Probing (rather than trusting rowCount) is robust to
 * Postgres reltuples estimates being 0 before ANALYZE, and keeps the seed a
 * meaningful early table rather than whichever happens to be largest.
 */
async function pickSeed(
  source: DataSource,
  schema: DatabaseSchema,
): Promise<{ table: TableSchema; row: Row } | null> {
  for (const table of schema.tables) {
    const [row] = await source.getRows(table.name, { limit: 1 });
    if (row) return { table, row };
  }
  return null;
}

export function App() {
  const [ds, setDs] = useState<DataSource | null>(null);
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [graph, setGraph] = useState<GraphState>(emptyGraph());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [dissolve, setDissolve] = useState(true);
  const [junctionOverrides, setJunctionOverrides] = useState<Map<string, boolean>>(new Map());
  const [showLog, setShowLog] = useState(false);
  const [relayoutKey, setRelayoutKey] = useState(0);
  const [spans, setSpans] = useState<ExpansionSpan[]>([]);
  const [staggerMs, setStaggerMs] = useState(40);
  const [pendingReveal, setPendingReveal] = useState<RevealGroup[]>([]);
  const [status, setStatus] = useState('Loading database…');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const expanding = useRef(false);
  /** Bumped per data-source activation; stale async results check it before writing state. */
  const sourceEpoch = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detected = useMemo(
    () => (schema ? detectJunctionTables(schema) : new Set<string>()),
    [schema],
  );
  const junctions = useMemo(
    () => effectiveJunctions(detected, junctionOverrides),
    [detected, junctionOverrides],
  );
  const expandOpts = useMemo(
    () => (dissolve ? { junctions } : {}),
    [dissolve, junctions],
  );

  // Swap in a DataSource (sql.js file or server-backed Postgres) and seed the
  // graph. Everything below the DataSource boundary is oblivious to which one.
  const activateSource = useCallback(
    async (source: DataSource, label: string) => {
      // Claim an epoch up front. Anything still in flight from the previous
      // source (a slow expansion, the startup fixture load) is now stale and
      // must not write back over this one's schema/graph.
      const epoch = ++sourceEpoch.current;
      const dbSchema = await source.getSchema();
      const seed = await pickSeed(source, dbSchema);
      if (epoch !== sourceEpoch.current) {
        source.dispose?.(); // a newer activation superseded this one
        return;
      }
      if (!seed) {
        source.dispose?.();
        throw new Error(`${label} has no rows to seed from`);
      }
      ds?.dispose?.();
      setDs(source);
      setSchema(dbSchema);
      setGraph(addSeed(emptyGraph(), seed.table, seed.row));
      setSelectedId(null);
      setJunctionOverrides(new Map());
      setSpans([]); // new DataSource = new empty query log
      setPendingReveal([]);
      setStatus(
        `${label} — ${dbSchema.tables.length} tables. Seeded ${seed.table.name}; click a node to inspect, double-click to expand.`,
      );
    },
    [ds],
  );

  const loadDatabase = useCallback(
    async (bytes: Uint8Array, name: string) => {
      await activateSource(await createSqlJsDataSource(bytes, name), name);
    },
    [activateSource],
  );

  const connectToServer = useCallback(async () => {
    await activateSource(createHttpDataSource(), 'Postgres (server)');
  }, [activateSource]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(import.meta.env.BASE_URL + FIXTURE);
      if (!res.ok) throw new Error(`Failed to fetch ${FIXTURE}: ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      // Skip if the user already picked a source (e.g. connected to Postgres)
      // while the fixture was still downloading — don't clobber their choice.
      if (!cancelled && sourceEpoch.current === 0) await loadDatabase(buf, FIXTURE);
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
    // Initial fixture load only; later loads go through handleOpenFile.
  }, []);

  const handleOpenFile = async (file: File) => {
    try {
      setStatus(`Loading ${file.name}…`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      await loadDatabase(bytes, file.name);
    } catch (e: unknown) {
      setStatus(`Failed to load ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleConnectServer = async () => {
    try {
      setStatus('Connecting to the server’s Postgres…');
      await connectToServer();
    } catch (e: unknown) {
      setStatus(`Failed to connect: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

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
    if (!ds || expanding.current) return;
    expanding.current = true;
    setBusy(true);
    setStatus(`Expanding ${what}…`);
    // Snapshot the log so this expansion's queries become a labeled span —
    // the visible cost of expanding row-by-row (the N+1 pattern).
    const logStart = ds.getQueryLog().length;
    const epoch = sourceEpoch.current;
    try {
      const result = await fn();
      // The data source changed while this was running: its result describes a
      // graph from the old database, so drop it rather than overwrite.
      if (epoch !== sourceEpoch.current) return;
      setGraph(result.state);
      const queries = ds.getQueryLog().length - logStart;
      setSpans((s) => [...s, { label: what, start: logStart, end: logStart + queries }]);
      // Stagger arrival one query-batch at a time, so N+1 expansions visibly
      // drip in while a single-query fetch pops in as one block.
      if (staggerMs > 0 && result.addedGroups.length > 1) {
        const delay = Math.min(staggerMs, MAX_REVEAL_TOTAL_MS / result.addedGroups.length);
        setPendingReveal((q) => [...q, ...result.addedGroups.map((ids) => ({ ids, delay }))]);
      }
      let msg =
        `Expanded ${what} — +${result.addedNodes} nodes, +${result.addedEdges} edges` +
        ` · ${queries} ${queries === 1 ? 'query' : 'queries'}`;
      if (result.truncated.length > 0) msg += ` · truncated: ${result.truncated.join(', ')}`;
      setStatus(msg);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      expanding.current = false;
      setBusy(false);
    }
  };

  const handleExpandAll = (node: GraphNode) => {
    if (!ds || !schema) return;
    void runExpansion(
      () => expandNode(ds, schema, graph, node, expandOpts),
      `${node.table}: ${node.label}`,
    );
  };

  const handleExpandDirection = (direction: 'forward' | 'reverse') => {
    if (!ds || !schema || !selectedNode) return;
    const label = direction === 'forward' ? 'outgoing' : 'incoming';
    void runExpansion(
      () => expandNode(ds, schema, graph, selectedNode, { ...expandOpts, direction }),
      `${selectedNode.table}: ${selectedNode.label} (${label})`,
    );
  };

  const handleExpandRel = (rel: Relationship) => {
    if (!ds || !schema || !selectedNode) return;
    const desc = rel.kind === 'forward' ? `→ ${rel.parentTable}` : `← ${rel.childTable}`;
    void runExpansion(
      () => expandRelationship(ds, schema, graph, selectedNode, rel, expandOpts),
      `${selectedNode.label} ${desc}`,
    );
  };

  const handlePillClick = (pill: PillNode) => {
    if (!ds || !schema) return;
    void runExpansion(() => expandMore(ds, schema, graph, pill), `more ${pill.childTable}`);
  };

  const handleToggleDissolve = (on: boolean) => {
    setDissolve(on);
    if (on && ds && schema && [...graph.nodes.values()].some((n) => junctions.has(n.table))) {
      // Fetch missing partners so existing junction rows can dissolve too.
      void runExpansion(
        () => completeJunctionNodes(ds, schema, graph, junctions),
        'junction partners',
      );
    }
  };

  const handleToggleJunction = (table: string) => {
    setJunctionOverrides((prev) => {
      const next = new Map(prev);
      next.set(table, !junctions.has(table));
      return next;
    });
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
    setPendingReveal([]);
    setStatus('Graph cleared — pick a seed row.');
  };

  // Pop the head reveal group after its delay; each pop re-renders with one
  // more query's worth of nodes visible.
  useEffect(() => {
    if (pendingReveal.length === 0) return;
    const t = setTimeout(() => setPendingReveal((q) => q.slice(1)), pendingReveal[0].delay);
    return () => clearTimeout(t);
  }, [pendingReveal]);

  const handleStagger = (ms: number) => {
    setStaggerMs(ms);
    if (ms === 0) setPendingReveal([]); // flush: everything appears at once
  };

  const view = useMemo(
    () => deriveView(graph, dissolve ? junctions : new Set<string>()),
    [graph, dissolve, junctions],
  );

  // Membership shown on canvas = derived view minus not-yet-revealed ids.
  const hiddenIds = useMemo(() => {
    const s = new Set<string>();
    for (const g of pendingReveal) for (const id of g.ids) s.add(id);
    return s;
  }, [pendingReveal]);
  const visibleView = useMemo(() => {
    if (hiddenIds.size === 0) return view;
    return {
      nodes: view.nodes.filter((n) => !hiddenIds.has(n.id)),
      pills: view.pills.filter((p) => !hiddenIds.has(p.id)),
      edges: view.edges.filter((e) => !hiddenIds.has(e.source) && !hiddenIds.has(e.target)),
    };
  }, [view, hiddenIds]);
  const stateTables = [...new Set([...graph.nodes.values()].map((n) => n.table))];
  const colorFor = (table: string) => (schema ? tableColor(schema, table) : '#999');
  // Nodes with at least one still-unexpanded relationship in the given
  // direction (both directions when omitted).
  const unexpandedCount = (direction?: 'forward' | 'reverse') =>
    schema
      ? [...graph.nodes.values()].filter((n) =>
          relationshipsFor(schema, n.table).some(
            (r) => (!direction || r.kind === direction) && !isRelExpanded(graph, n.id, r),
          ),
        ).length
      : 0;

  const handleExpandAllNodes = (direction: 'forward' | 'reverse') => {
    if (!ds || !schema) return;
    const what = direction === 'forward' ? 'outgoing' : 'incoming';
    void runExpansion(
      () => expandAllNodes(ds, schema, graph, { ...expandOpts, direction }),
      `${unexpandedCount(direction)} nodes (1 hop, ${what})`,
    );
  };

  const relEntries: RelEntry[] =
    schema && selectedNode
      ? relationshipsFor(schema, selectedNode.table).map((rel) => ({
          rel,
          key: relKey(rel),
          expanded: isRelExpanded(graph, selectedNode.id, rel),
          count: counts[relKey(rel)] ?? null,
          present: alreadyPresent(graph, selectedNode, rel),
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
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) void handleOpenFile(file);
      }}
    >
      <header>
        <h1>Relational Data Graph Explorer</h1>
        <button
          className="header-button"
          onClick={() => fileInputRef.current?.click()}
          title="Open any SQLite file (or drag & drop one anywhere)"
        >
          Open .sqlite…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".sqlite,.sqlite3,.db"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleOpenFile(file);
            e.target.value = '';
          }}
        />
        <button
          className="header-button"
          onClick={() => void handleConnectServer()}
          title="Connect to the Postgres database configured on the server"
        >
          Connect to Postgres
        </button>
        <button
          className="header-button"
          disabled={busy || unexpandedCount('forward') === 0}
          onClick={() => handleExpandAllNodes('forward')}
          title="Expand every node one hop along its outgoing foreign keys"
        >
          {busy ? 'Expanding…' : `Expand all → outgoing (${unexpandedCount('forward')})`}
        </button>
        <button
          className="header-button"
          disabled={busy || unexpandedCount('reverse') === 0}
          onClick={() => handleExpandAllNodes('reverse')}
          title="Expand every node one hop along incoming references"
        >
          {busy ? 'Expanding…' : `Expand all ← incoming (${unexpandedCount('reverse')})`}
        </button>
        <button
          className="header-button"
          onClick={() => setRelayoutKey((k) => k + 1)}
          title="Unpin every node and let the whole graph settle into a new shape"
        >
          Re-layout
        </button>
        <label className="dissolve-toggle" title="Collapse junction-table rows into direct edges">
          <input
            type="checkbox"
            checked={dissolve}
            onChange={(e) => handleToggleDissolve(e.target.checked)}
          />
          dissolve junctions
          {junctions.size > 0 && <span className="dissolve-names">({[...junctions].join(', ')})</span>}
        </label>
        <label
          className="stagger-control"
          title="Stagger node arrival: one batch per SQL query, so query count is visible as time (0 = instant)"
        >
          reveal
          <input
            type="range"
            min={0}
            max={150}
            step={10}
            value={staggerMs}
            onChange={(e) => handleStagger(Number(e.target.value))}
          />
          <span className="stagger-value">
            {staggerMs === 0 ? 'off' : `${staggerMs}ms/query`}
          </span>
        </label>
        <span className="status">{status}</span>
      </header>
      <main>
        <GraphCanvas
          nodes={visibleView.nodes}
          pills={visibleView.pills}
          edges={visibleView.edges}
          selectedId={selectedId}
          relayoutKey={relayoutKey}
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
            hasGraph={graph.nodes.size > 0}
          />
        )}
        {selectedNode && (
          <Inspector
            node={selectedNode}
            entries={relEntries}
            colorFor={colorFor}
            onExpandRel={handleExpandRel}
            onExpandDirection={handleExpandDirection}
            onClose={() => setSelectedId(null)}
          />
        )}
        <Legend
          tables={stateTables}
          colorFor={colorFor}
          junctions={junctions}
          onToggleJunction={handleToggleJunction}
        />
        {showLog && ds && (
          <QueryLog entries={ds.getQueryLog()} spans={spans} onClose={() => setShowLog(false)} />
        )}
      </main>
      <footer>
        {view.nodes.length} nodes · {view.edges.length} edges
        {dissolve && graph.nodes.size > view.nodes.length && (
          <> ({graph.nodes.size - view.nodes.length} junction rows dissolved)</>
        )}{' '}
        · <span className="query-counter">{ds ? ds.getQueryLog().length : 0} SQL queries</span> ·
        click a node to inspect · double-click to expand · drag background to pan · scroll to
        zoom ·{' '}
        <button className="link-button footer-link" onClick={() => setShowLog((s) => !s)}>
          {showLog ? 'hide' : 'show'} SQL log
        </button>
      </footer>
    </div>
  );
}
