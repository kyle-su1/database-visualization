import type { SqlValue } from '../datasource/types';
import type { Relationship } from '../schema/relationships';
import type { GraphNode } from '../graph/session';

export interface RelEntry {
  rel: Relationship;
  key: string;
  expanded: boolean;
  /** null while the count is still loading. */
  count: number | null;
}

interface Props {
  node: GraphNode;
  entries: RelEntry[];
  colorFor: (table: string) => string;
  onExpandRel: (rel: Relationship) => void;
  onExpandAll: () => void;
  onClose: () => void;
}

function fmt(v: SqlValue): string {
  if (v === null) return 'NULL';
  if (v instanceof Uint8Array) return `<blob ${v.length}B>`;
  const s = String(v);
  return s.length > 60 ? s.slice(0, 59) + '…' : s;
}

export function Inspector({ node, entries, colorFor, onExpandRel, onExpandAll, onClose }: Props) {
  const allExpanded = entries.every((e) => e.expanded);
  return (
    <div className="panel inspector">
      <div className="panel-title">
        <span className="legend-swatch" style={{ background: colorFor(node.table) }} />
        {node.table}: {node.label}
        <button className="link-button" onClick={onClose}>
          close
        </button>
      </div>

      <div className="section-label">Relationships</div>
      <div className="rel-list">
        {entries.map(({ rel, key, expanded, count }) => (
          <div key={key} className="rel-item">
            <span className="rel-desc">
              {rel.kind === 'forward' ? (
                <>
                  → {rel.parentTable}
                  <span className="rel-via">via {rel.fk.columns.join('+')}</span>
                </>
              ) : (
                <>
                  ← {rel.childTable}
                  <span className="rel-via">
                    {rel.childTable}.{rel.fk.columns.join('+')} → this
                  </span>
                </>
              )}
            </span>
            <span className="rel-count">
              {count === null ? '…' : rel.kind === 'forward' && count === 0 ? 'null' : count}
            </span>
            <button
              className="expand-button"
              disabled={expanded || count === 0}
              onClick={() => onExpandRel(rel)}
            >
              {expanded ? '✓' : 'expand'}
            </button>
          </div>
        ))}
        {entries.length === 0 && <div className="empty">no foreign-key relationships</div>}
      </div>
      {entries.length > 1 && (
        <button className="expand-all" disabled={allExpanded} onClick={onExpandAll}>
          Expand all
        </button>
      )}

      <div className="section-label">Row</div>
      <table className="values-table">
        <tbody>
          {Object.entries(node.values).map(([col, v]) => (
            <tr key={col}>
              <td className="col-name">{col}</td>
              <td className={v === null ? 'null-value' : ''}>{fmt(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
