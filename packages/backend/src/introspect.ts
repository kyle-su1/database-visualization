import type { ColumnSchema, DatabaseSchema, FkSchema, TableSchema } from '@dbviz/shared';

/**
 * The minimal query surface introspection needs. Both `pg.Pool` (production)
 * and PGlite (hermetic tests) satisfy it via a one-line adapter, so the exact
 * catalog logic below runs against real Postgres and the WASM build alike.
 */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Fallback identity column for a table with no primary key (analog of sql.js's rowid). */
const CTID = 'ctid';

const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);

function getOrInit<K, V>(m: Map<K, V>, k: K, make: () => V): V {
  let v = m.get(k);
  if (v === undefined) {
    v = make();
    m.set(k, v);
  }
  return v;
}

// Ordinary + partitioned tables, with a fast row-count estimate. reltuples is
// -1 until the table is analyzed, so clamp to 0. (Seed step should ANALYZE.)
const TABLES_SQL = `
  SELECT c.relname AS name, GREATEST(c.reltuples, 0)::bigint AS row_estimate
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
  ORDER BY c.relname`;

const COLUMNS_SQL = `
  SELECT table_name, column_name, data_type, is_nullable, ordinal_position
  FROM information_schema.columns
  WHERE table_schema = $1
  ORDER BY table_name, ordinal_position`;

// PK columns in key order (conkey is ordered; WITH ORDINALITY preserves it).
const PK_SQL = `
  SELECT c.relname AS table_name, a.attname AS column_name
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
  WHERE con.contype = 'p' AND n.nspname = $1
  ORDER BY c.relname, k.ord`;

// FK child/parent column pairs. conkey and confkey are unnested IN PARALLEL by
// ordinality (fk.ord = k.ord) so composite keys pair up in the right order —
// the thing information_schema's referential views get wrong.
const FK_SQL = `
  SELECT con.oid AS fk_id, c.relname AS table_name, rc.relname AS ref_table,
         a.attname AS column_name, fa.attname AS ref_column
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_class rc ON rc.oid = con.confrelid
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
  JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = fk.attnum
  WHERE con.contype = 'f' AND n.nspname = $1
  ORDER BY c.relname, con.oid, k.ord`;

/**
 * Introspect one Postgres schema into the shared DatabaseSchema shape — the
 * server-side twin of SqlJsDataSource.introspect(). FK `id` is the constraint
 * oid (stable, unique) so getReferencingRows can map fkId back to the FK.
 * FKs pointing outside `schema` are dropped, mirroring the sql.js behavior of
 * discarding FKs to unknown tables.
 */
export async function introspect(db: Queryable, schema: string): Promise<DatabaseSchema> {
  const dbName = str((await db.query('SELECT current_database() AS name')).rows[0]?.name ?? 'postgres');
  const tableRows = (await db.query(TABLES_SQL, [schema])).rows;
  const colRows = (await db.query(COLUMNS_SQL, [schema])).rows;
  const pkRows = (await db.query(PK_SQL, [schema])).rows;
  const fkRows = (await db.query(FK_SQL, [schema])).rows;

  const tableNames = new Set(tableRows.map((r) => str(r.name)));

  const columnsByTable = new Map<string, ColumnSchema[]>();
  for (const r of colRows) {
    const t = str(r.table_name);
    if (!tableNames.has(t)) continue;
    getOrInit(columnsByTable, t, () => []).push({
      name: str(r.column_name),
      type: str(r.data_type),
      notNull: r.is_nullable === 'NO',
    });
  }

  const pkByTable = new Map<string, string[]>();
  for (const r of pkRows) {
    getOrInit(pkByTable, str(r.table_name), () => []).push(str(r.column_name));
  }

  const fkByTable = new Map<string, Map<number, FkSchema>>();
  for (const r of fkRows) {
    const refTable = str(r.ref_table);
    if (!tableNames.has(refTable)) continue; // FK references a table outside this schema
    const byId = getOrInit(fkByTable, str(r.table_name), () => new Map<number, FkSchema>());
    const fk = getOrInit(byId, num(r.fk_id), () => ({
      id: num(r.fk_id),
      columns: [],
      refTable,
      refColumns: [],
    }));
    fk.columns.push(str(r.column_name));
    fk.refColumns.push(str(r.ref_column));
  }

  const tables: TableSchema[] = tableRows.map((r): TableSchema => {
    const name = str(r.name);
    const pk = pkByTable.get(name);
    return {
      name,
      columns: columnsByTable.get(name) ?? [],
      pk: pk && pk.length > 0 ? pk : [CTID],
      fks: [...(fkByTable.get(name)?.values() ?? [])],
      rowCount: Math.max(0, num(r.row_estimate)),
    };
  });

  return { name: dbName, tables };
}
