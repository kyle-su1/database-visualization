interface Props {
  tables: string[];
  colorFor: (table: string) => string;
}

export function Legend({ tables, colorFor }: Props) {
  if (tables.length === 0) return null;
  return (
    <div className="legend">
      {tables.map((t) => (
        <div key={t} className="legend-item">
          <span className="legend-swatch" style={{ background: colorFor(t) }} />
          {t}
        </div>
      ))}
    </div>
  );
}
