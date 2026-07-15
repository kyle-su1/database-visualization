interface Props {
  tables: string[];
  colorFor: (table: string) => string;
  junctions: Set<string>;
  onToggleJunction: (table: string) => void;
}

export function Legend({ tables, colorFor, junctions, onToggleJunction }: Props) {
  if (tables.length === 0) return null;
  return (
    <div className="legend">
      {tables.map((t) => (
        <div key={t} className="legend-item">
          <span className="legend-swatch" style={{ background: colorFor(t) }} />
          {t}
          <button
            className={'junction-badge' + (junctions.has(t) ? ' on' : '')}
            title={
              junctions.has(t)
                ? `${t} is treated as a junction table — click to change`
                : `treat ${t} as a junction table`
            }
            onClick={() => onToggleJunction(t)}
          >
            ⋈
          </button>
        </div>
      ))}
    </div>
  );
}
