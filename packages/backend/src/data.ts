import type {
  DatabaseSchema,
  PkValue,
  QueryLogEntry,
  Row,
  SqlValue,
  TableSchema,
} from '@dbviz/shared';
import type { Queryable } from './introspect.ts';
import { httpError } from './errors.ts';

/** Fallback identity column for a PK-less table (see introspect.ts). */
const CTID = 'ctid';

/** Quote a SQL identifier (Postgres, like SQLite, uses "" with "" escaping). */
function q(identifier: string): string {
  return '"' + identifier.replace(/"/g, '""') + '"';
}

/** Postgres text-ish types the seed search scans (character varying / text / character). */
function isTexty(type: string): boolean {
  return /char|text/i.test(type);
}

interface GetRowsOpts {
  limit: number;
  offset?: number;
  searchText?: string;
}

/**
 * Server-side data access over the introspected schema — the Postgres twin of
 * the browser's SqlJsDataSource. Same safety discipline: values are always
 * parameterized ($1, $2 …) and identifiers are both quoted AND validated
 * against the schema before interpolation, so no user input reaches SQL as a
 * raw identifier. Each method returns the SQL it ran (`queryLog`) so the
 * response can carry a per-request log to the browser's query panel.
 */
export class PgDataSource {
  private readonly db: Queryable;
  private readonly schema: DatabaseSchema;
  private readonly rowLimit: number;
  private readonly tablesByName: Map<string, TableSchema>;

  // Fields are assigned explicitly rather than via constructor parameter
  // properties: Node's native type-stripping is erasable-only and does not
  // support the `private readonly x` shorthand (it would require codegen).
  constructor(db: Queryable, schema: DatabaseSchema, rowLimit: number) {
    this.db = db;
    this.schema = schema;
    this.rowLimit = rowLimit;
    this.tablesByName = new Map(schema.tables.map((t) => [t.name, t]));
  }

  getSchema(): DatabaseSchema {
    return this.schema;
  }

  async getRows(
    table: string,
    opts: GetRowsOpts,
  ): Promise<{ rows: Row[]; queryLog: QueryLogEntry[] }> {
    const log: QueryLogEntry[] = [];
    const t = this.assertTable(table);
    const params: SqlValue[] = [];
    let where = '';
    if (opts.searchText) {
      const textCols = t.columns.filter((c) => isTexty(c.type));
      if (textCols.length > 0) {
        const clauses = textCols.map((c) => {
          params.push(`%${opts.searchText}%`);
          return `${q(c.name)} ILIKE $${params.length}`;
        });
        where = ' WHERE ' + clauses.join(' OR ');
      }
    }
    params.push(this.clampLimit(opts.limit));
    const limitPlaceholder = params.length;
    params.push(opts.offset ?? 0);
    const rows = await this.run(
      `SELECT ${this.selectList(t)} FROM ${q(t.name)}${where} LIMIT $${limitPlaceholder} OFFSET $${params.length}`,
      params,
      log,
    );
    return { rows: rows.map((r) => this.toRow(t, r)), queryLog: log };
  }

  async getRow(
    table: string,
    pk: PkValue,
  ): Promise<{ row: Row | null; queryLog: QueryLogEntry[] }> {
    const log: QueryLogEntry[] = [];
    const t = this.assertTable(table);
    const cols = Object.keys(pk).map((c) => this.assertColumn(t, c));
    const params = cols.map((c) => pk[c]);
    const where = cols.map((c, i) => this.eq(c, i + 1)).join(' AND ');
    const rows = await this.run(
      `SELECT ${this.selectList(t)} FROM ${q(t.name)} WHERE ${where} LIMIT 1`,
      params,
      log,
    );
    return { row: rows.length > 0 ? this.toRow(t, rows[0]) : null, queryLog: log };
  }

  async getReferencingRows(
    childTable: string,
    fkId: number,
    refValues: PkValue,
    opts: { limit: number; offset?: number },
  ): Promise<{ rows: Row[]; totalCount: number; queryLog: QueryLogEntry[] }> {
    const log: QueryLogEntry[] = [];
    const t = this.assertTable(childTable);
    const fk = t.fks.find((f) => f.id === fkId);
    if (!fk) throw httpError(400, `No foreign key #${fkId} on table ${childTable}`);
    const cols = fk.columns.map((c) => this.assertColumn(t, c));
    for (const c of cols) {
      if (!(c in refValues)) throw httpError(400, `Missing FK value for ${childTable}.${c}`);
    }
    const whereParams = cols.map((c) => refValues[c]);
    const where = cols.map((c, i) => this.eq(c, i + 1)).join(' AND ');

    const countRows = await this.run(
      `SELECT COUNT(*)::bigint AS n FROM ${q(t.name)} WHERE ${where}`,
      whereParams,
      log,
    );
    const totalCount = Number(countRows[0].n);

    // limit: 0 is a count-only query (the "+N more" pill uses it).
    let rows: Row[] = [];
    if (opts.limit !== 0) {
      const params = [...whereParams, this.clampLimit(opts.limit), opts.offset ?? 0];
      const fetched = await this.run(
        `SELECT ${this.selectList(t)} FROM ${q(t.name)} WHERE ${where} LIMIT $${cols.length + 1} OFFSET $${cols.length + 2}`,
        params,
        log,
      );
      rows = fetched.map((r) => this.toRow(t, r));
    }
    return { rows, totalCount, queryLog: log };
  }

  // --------------------------------------------------------------- helpers

  private clampLimit(n: number | undefined): number {
    return Math.max(1, Math.min(n ?? this.rowLimit, this.rowLimit));
  }

  /** `col = $n`, casting to tid for the ctid fallback identity column. */
  private eq(col: string, placeholder: number): string {
    return col === CTID ? `ctid = $${placeholder}::tid` : `${q(col)} = $${placeholder}`;
  }

  private assertTable(name: string): TableSchema {
    const t = this.tablesByName.get(name);
    if (!t) throw httpError(400, `Unknown table: ${name}`);
    return t;
  }

  private assertColumn(t: TableSchema, name: string): string {
    if (name === CTID && t.pk[0] === CTID) return name;
    const c = t.columns.find((c) => c.name === name);
    if (!c) throw httpError(400, `Unknown column: ${t.name}.${name}`);
    return c.name;
  }

  /** Include ctid explicitly when it stands in as the PK (it is not part of *). */
  private selectList(t: TableSchema): string {
    return t.pk[0] === CTID && !t.columns.some((c) => c.name === CTID) ? 'ctid, *' : '*';
  }

  private toRow(t: TableSchema, values: Record<string, unknown>): Row {
    // Postgres values (Date, boolean, bigint-as-string, …) are JSON-serialized
    // to the client, which treats them as opaque SqlValue for display and,
    // for key columns, echoes them back verbatim as query parameters.
    const pk: PkValue = {};
    for (const c of t.pk) pk[c] = values[c] as SqlValue;
    return { pk, values: values as Record<string, SqlValue> };
  }

  private async run(
    sql: string,
    params: SqlValue[],
    log: QueryLogEntry[],
  ): Promise<Record<string, unknown>[]> {
    const t0 = performance.now();
    const res = await this.db.query(sql, params);
    log.push({ sql, params, ms: performance.now() - t0 });
    return res.rows;
  }
}
