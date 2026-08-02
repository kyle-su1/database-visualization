/**
 * THE DATA-SOURCE BOUNDARY.
 *
 * Everything above this interface (schema model, graph session, rendering)
 * depends only on these types. The sql.js implementation lives in
 * ./sqljs/ and is the ONLY code allowed to import sql.js (enforced by
 * eslint no-restricted-imports). A future server-backed implementation
 * satisfies this same interface with one fetch per method.
 */

/** A value as stored in a SQL cell. */
export type SqlValue = number | string | Uint8Array | null;

/**
 * Identifies one row: primary-key column name -> value.
 * Supports composite PKs. Column order is defined by TableSchema.pk.
 */
export type PkValue = Record<string, SqlValue>;

export interface ColumnSchema {
  name: string;
  /** Declared SQL type, possibly empty string. */
  type: string;
  notNull: boolean;
}

export interface FkSchema {
  /** Stable index of this FK within its table (from PRAGMA foreign_key_list). */
  id: number;
  /** Child-side column names, in FK declaration order. */
  columns: string[];
  /** Referenced (parent) table. */
  refTable: string;
  /** Parent-side column names, same order as `columns`. Defaults to parent PK. */
  refColumns: string[];
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  /** Ordered PK column names. Falls back to ['rowid'] when no declared PK. */
  pk: string[];
  fks: FkSchema[];
  rowCount: number;
}

export interface DatabaseSchema {
  /** Human-readable label for the loaded database (e.g. file name). */
  name: string;
  tables: TableSchema[];
}

export interface Row {
  pk: PkValue;
  values: Record<string, SqlValue>;
}

export interface QueryLogEntry {
  sql: string;
  params: SqlValue[];
  ms: number;
}

export interface DataSource {
  getSchema(): Promise<DatabaseSchema>;

  /** Fetch a single row by primary key (or unique column match). */
  getRow(table: string, pk: PkValue): Promise<Row | null>;

  /** Browse/search rows of a table (seed selection). */
  getRows(
    table: string,
    opts: { limit: number; offset?: number; searchText?: string },
  ): Promise<Row[]>;

  /**
   * Reverse FK expansion: rows of `childTable` whose FK `fkId` points at
   * the given parent values. `refValues` is keyed by the CHILD fk columns.
   * `totalCount` reports the untruncated match count; `limit: 0` is a
   * count-only query. `offset` pages through truncated expansions.
   */
  getReferencingRows(
    childTable: string,
    fkId: number,
    refValues: PkValue,
    opts: { limit: number; offset?: number },
  ): Promise<{ rows: Row[]; totalCount: number }>;

  /** Every SQL statement executed so far (for the query-log panel). */
  getQueryLog(): QueryLogEntry[];

  /** Release underlying resources (e.g. wasm memory) when replaced. */
  dispose?(): void;
}
