import type { DatabaseSchema, Row, TableSchema } from '@dbviz/shared';

/** Tableau-10 palette, cycled by table position in the schema. */
const PALETTE = [
  '#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f',
  '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab',
];

export function tableColor(schema: DatabaseSchema, table: string): string {
  const i = schema.tables.findIndex((t) => t.name === table);
  return PALETTE[(i >= 0 ? i : 0) % PALETTE.length];
}

const MAX_LABEL = 24;

function isTexty(type: string): boolean {
  return type === '' || /char|text|clob/i.test(type);
}

/** Pick a human-friendly label for a row: name/title-ish column, else first text column, else PK. */
export function rowLabel(t: TableSchema, row: Row): string {
  const candidates = [
    ...t.columns.filter((c) => /^(name|title|label)$/i.test(c.name)),
    ...t.columns.filter((c) => /(name|title)$/i.test(c.name)),
    ...t.columns.filter((c) => isTexty(c.type) && !t.pk.includes(c.name)),
  ];
  for (const c of candidates) {
    const v = row.values[c.name];
    if (typeof v === 'string' && v.trim() !== '') return truncate(v.trim());
  }
  return truncate(t.pk.map((c) => String(row.pk[c])).join(' · '));
}

function truncate(s: string): string {
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '…' : s;
}
