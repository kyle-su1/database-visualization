import type { DatabaseSchema } from '@dbviz/shared';

/**
 * Junction (many-to-many) table heuristic: exactly 2 FKs, and every column
 * is either an FK column or part of the PK, allowing at most one extra
 * payload column (e.g. `position`, `created_at`).
 *
 * Example: Chinook's PlaylistTrack qualifies; InvoiceLine (2 FKs but
 * UnitPrice + Quantity payload) does not.
 */
export function detectJunctionTables(schema: DatabaseSchema): Set<string> {
  const out = new Set<string>();
  for (const t of schema.tables) {
    if (t.fks.length !== 2) continue;
    const fkCols = new Set(t.fks.flatMap((fk) => fk.columns));
    const extra = t.columns.filter((c) => !fkCols.has(c.name) && !t.pk.includes(c.name));
    if (extra.length <= 1) out.add(t.name);
  }
  return out;
}

/** Apply per-table user overrides on top of the detected set. */
export function effectiveJunctions(
  detected: Set<string>,
  overrides: Map<string, boolean>,
): Set<string> {
  const out = new Set(detected);
  for (const [table, isJunction] of overrides) {
    if (isJunction) out.add(table);
    else out.delete(table);
  }
  return out;
}
