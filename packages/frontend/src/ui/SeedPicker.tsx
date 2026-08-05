import { useEffect, useState } from 'react';
import type { DatabaseSchema, Row } from '@dbviz/shared';
import { rowLabel } from '../schema/display';

interface Props {
  schema: DatabaseSchema;
  colorFor: (table: string) => string;
  search: (table: string, text: string) => Promise<Row[]>;
  onPick: (table: string, row: Row) => void;
  onClear: () => void;
  hasGraph: boolean;
}

export function SeedPicker({ schema, colorFor, search, onPick, onClear, hasGraph }: Props) {
  const [table, setTable] = useState(
    () => (schema.tables.find((t) => t.rowCount > 0) ?? schema.tables[0]).name,
  );
  const [text, setText] = useState('');
  // Rows are stored WITH the table they were fetched from, so a stale result
  // is never rendered against a newly selected table's schema.
  const [result, setResult] = useState<{ table: string; rows: Row[] }>({ table, rows: [] });

  // Switching data sources swaps the schema underneath us; the remembered
  // table may not exist in the new one (e.g. SQLite "Album" vs Postgres
  // "album"). Reset it so lookups stay valid.
  useEffect(() => {
    if (!schema.tables.some((x) => x.name === table)) {
      setTable((schema.tables.find((x) => x.rowCount > 0) ?? schema.tables[0]).name);
    }
  }, [schema, table]);

  useEffect(() => {
    let cancelled = false;
    search(table, text)
      .then((rows) => {
        if (!cancelled) setResult({ table, rows });
      })
      .catch((e: unknown) => console.error('seed search failed:', e));
    return () => {
      cancelled = true;
    };
  }, [table, text, search]);

  // Fall back to a valid table for the render before the reset effect runs,
  // so we never throw on a stale table name.
  const t = schema.tables.find((x) => x.name === table) ?? schema.tables[0];
  const rows = result.table === table ? result.rows : [];

  return (
    <div className="panel seed-picker">
      <div className="panel-title">
        Seed picker
        {hasGraph && (
          <button className="link-button" onClick={onClear}>
            clear graph
          </button>
        )}
      </div>
      <select value={table} onChange={(e) => setTable(e.target.value)}>
        {schema.tables.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name} ({t.rowCount})
          </option>
        ))}
      </select>
      <input
        type="search"
        placeholder="Search rows…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row-list">
        {rows.map((row) => {
          const id = t.pk.map((c) => String(row.pk[c])).join(' · ');
          return (
            <button key={id} className="row-item" onClick={() => onPick(table, row)}>
              <span className="legend-swatch" style={{ background: colorFor(table) }} />
              <span className="row-item-label">{rowLabel(t, row)}</span>
              <span className="row-item-pk">{id}</span>
            </button>
          );
        })}
        {rows.length === 0 && <div className="empty">no matching rows</div>}
      </div>
    </div>
  );
}
