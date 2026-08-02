import type { DatabaseSchema, FkSchema, TableSchema } from '@dbviz/shared';

/**
 * One expandable relationship as seen FROM a given table.
 * - forward: this table's FK points at one parent row.
 * - reverse: another table's FK points back at this table (fans out to many).
 */
export interface Relationship {
  kind: 'forward' | 'reverse';
  /** Table that owns the FK (always the child side). */
  childTable: string;
  fk: FkSchema;
  parentTable: string;
}

export function tableByName(schema: DatabaseSchema, name: string): TableSchema {
  const t = schema.tables.find((t) => t.name === name);
  if (!t) throw new Error(`Unknown table: ${name}`);
  return t;
}

/** All relationships expandable from a row of `table`, forward and reverse. */
export function relationshipsFor(schema: DatabaseSchema, table: string): Relationship[] {
  const rels: Relationship[] = [];
  for (const fk of tableByName(schema, table).fks) {
    rels.push({ kind: 'forward', childTable: table, fk, parentTable: fk.refTable });
  }
  for (const t of schema.tables) {
    for (const fk of t.fks) {
      if (fk.refTable === table) {
        rels.push({ kind: 'reverse', childTable: t.name, fk, parentTable: table });
      }
    }
  }
  return rels;
}
