import initSqlJs, { type Database } from 'sql.js';
import type {
  ColumnSchema,
  DataSource,
  DatabaseSchema,
  FkSchema,
  PkValue,
  QueryLogEntry,
  Row,
  SqlValue,
  TableSchema,
} from '../types';

interface CreateOptions {
  /** Where to load sql-wasm.wasm from (browser: ?url asset, node tests: fs path). */
  locateFile?: (file: string) => string;
  /** Label for the database (e.g. file name). */
  name?: string;
}

/** Quote a SQL identifier. Names are additionally validated against the schema. */
function q(identifier: string): string {
  return '"' + identifier.replace(/"/g, '""') + '"';
}

const ROWID = 'rowid';

export class SqlJsDataSource implements DataSource {
  private readonly log: QueryLogEntry[] = [];
  private readonly schema: DatabaseSchema;
  private readonly tablesByName: Map<string, TableSchema>;

  private constructor(
    private readonly db: Database,
    name: string,
  ) {
    this.schema = { name, tables: this.introspect() };
    this.tablesByName = new Map(this.schema.tables.map((t) => [t.name, t]));
  }

  static async create(data: Uint8Array, opts: CreateOptions = {}): Promise<SqlJsDataSource> {
    const SQL = await initSqlJs(opts.locateFile ? { locateFile: opts.locateFile } : undefined);
    return new SqlJsDataSource(new SQL.Database(data), opts.name ?? 'database');
  }

  // ---------------------------------------------------------------- schema

  private introspect(): TableSchema[] {
    const names = this.run(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid`,
    ).map((r) => r.name as string);

    const tables: TableSchema[] = names.map((name) => {
      const info = this.run(`PRAGMA table_info(${q(name)})`);
      const columns: ColumnSchema[] = info.map((c) => ({
        name: c.name as string,
        type: (c.type as string) ?? '',
        notNull: c.notnull === 1,
      }));
      const pk = info
        .filter((c) => (c.pk as number) > 0)
        .sort((a, b) => (a.pk as number) - (b.pk as number))
        .map((c) => c.name as string);

      // Group PRAGMA foreign_key_list rows by fk id (composite FKs share an id).
      const fkRows = this.run(`PRAGMA foreign_key_list(${q(name)})`);
      const fkMap = new Map<number, FkSchema>();
      for (const r of fkRows) {
        const id = r.id as number;
        let fk = fkMap.get(id);
        if (!fk) {
          fk = { id, columns: [], refTable: r.table as string, refColumns: [] };
          fkMap.set(id, fk);
        }
        fk.columns.push(r.from as string);
        // `to` is null when the FK implicitly references the parent PK;
        // resolved below once all tables are known.
        fk.refColumns.push((r.to as string | null) ?? '');
      }

      const rowCount = this.run(`SELECT COUNT(*) AS n FROM ${q(name)}`)[0].n as number;

      return {
        name,
        columns,
        pk: pk.length > 0 ? pk : [ROWID],
        fks: [...fkMap.values()],
        rowCount,
      };
    });

    // Resolve implicit FK targets to the parent PK; drop FKs to unknown tables.
    const byName = new Map(tables.map((t) => [t.name, t]));
    for (const t of tables) {
      t.fks = t.fks.filter((fk) => {
        const parent = byName.get(fk.refTable);
        if (!parent) return false;
        if (fk.refColumns.some((c) => c === '')) {
          if (parent.pk.length !== fk.columns.length) return false;
          fk.refColumns = [...parent.pk];
        }
        return true;
      });
    }
    return tables;
  }

  // ------------------------------------------------------------ DataSource

  getSchema(): Promise<DatabaseSchema> {
    return Promise.resolve(this.schema);
  }

  async getRow(table: string, pk: PkValue): Promise<Row | null> {
    const t = this.assertTable(table);
    const cols = Object.keys(pk).map((c) => this.assertColumn(t, c));
    const where = cols.map((c) => `${q(c)} = ?`).join(' AND ');
    const rows = this.run(
      `SELECT ${this.selectList(t)} FROM ${q(t.name)} WHERE ${where} LIMIT 1`,
      cols.map((c) => pk[c]),
    );
    return rows.length > 0 ? this.toRow(t, rows[0]) : null;
  }

  async getRows(
    table: string,
    opts: { limit: number; offset?: number; searchText?: string },
  ): Promise<Row[]> {
    const t = this.assertTable(table);
    const params: SqlValue[] = [];
    let where = '';
    if (opts.searchText) {
      const textCols = t.columns.filter((c) => isTexty(c.type));
      if (textCols.length > 0) {
        where = ' WHERE ' + textCols.map((c) => `${q(c.name)} LIKE ?`).join(' OR ');
        params.push(...textCols.map(() => `%${opts.searchText}%`));
      }
    }
    params.push(opts.limit, opts.offset ?? 0);
    const rows = this.run(
      `SELECT ${this.selectList(t)} FROM ${q(t.name)}${where} LIMIT ? OFFSET ?`,
      params,
    );
    return rows.map((r) => this.toRow(t, r));
  }

  async getReferencingRows(
    childTable: string,
    fkId: number,
    refValues: PkValue,
    opts: { limit: number },
  ): Promise<{ rows: Row[]; totalCount: number }> {
    const t = this.assertTable(childTable);
    const fk = t.fks.find((f) => f.id === fkId);
    if (!fk) throw new Error(`No foreign key #${fkId} on table ${childTable}`);
    const cols = fk.columns.map((c) => this.assertColumn(t, c));
    for (const c of cols) {
      if (!(c in refValues)) throw new Error(`Missing FK value for ${childTable}.${c}`);
    }
    const where = cols.map((c) => `${q(c)} = ?`).join(' AND ');
    const params = cols.map((c) => refValues[c]);

    const totalCount = this.run(
      `SELECT COUNT(*) AS n FROM ${q(t.name)} WHERE ${where}`,
      params,
    )[0].n as number;
    const rows = this.run(
      `SELECT ${this.selectList(t)} FROM ${q(t.name)} WHERE ${where} LIMIT ?`,
      [...params, opts.limit],
    );
    return { rows: rows.map((r) => this.toRow(t, r)), totalCount };
  }

  getQueryLog(): QueryLogEntry[] {
    return [...this.log];
  }

  // --------------------------------------------------------------- helpers

  private assertTable(name: string): TableSchema {
    const t = this.tablesByName.get(name);
    if (!t) throw new Error(`Unknown table: ${name}`);
    return t;
  }

  private assertColumn(t: TableSchema, name: string): string {
    if (name === ROWID && t.pk[0] === ROWID) return name;
    const c = t.columns.find((c) => c.name === name);
    if (!c) throw new Error(`Unknown column: ${t.name}.${name}`);
    return c.name;
  }

  /** Include rowid explicitly when it serves as the fallback PK. */
  private selectList(t: TableSchema): string {
    return t.pk[0] === ROWID && !t.columns.some((c) => c.name === ROWID)
      ? `${ROWID} AS ${ROWID}, *`
      : '*';
  }

  private toRow(t: TableSchema, values: Record<string, SqlValue>): Row {
    const pk: PkValue = {};
    for (const c of t.pk) pk[c] = values[c];
    return { pk, values };
  }

  private run(sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
    const t0 = performance.now();
    const stmt = this.db.prepare(sql);
    try {
      if (params.length > 0) stmt.bind(params);
      const rows: Record<string, SqlValue>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, SqlValue>);
      this.log.push({ sql, params, ms: performance.now() - t0 });
      return rows;
    } finally {
      stmt.free();
    }
  }
}

function isTexty(type: string): boolean {
  return type === '' || /char|text|clob/i.test(type);
}
