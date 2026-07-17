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
  onExpandDirection: (direction: 'forward' | 'reverse') => void;
  onClose: () => void;
}

function fmt(v: SqlValue): string {
  if (v === null) return 'NULL';
  if (v instanceof Uint8Array) return `<blob ${v.length}B>`;
  const s = String(v);
  return s.length > 60 ? s.slice(0, 59) + '…' : s;
}

export function Inspector({ node, entries, colorFor, onExpandRel, onExpandDirection, onClose }: Props) {
  const forward = entries.filter((e) => e.rel.kind === 'forward');
  const reverse = entries.filter((e) => e.rel.kind === 'reverse');
  // A direction is expandable while any of its relationships has rows left to pull in.
  const canExpand = (group: RelEntry[]) => group.some((e) => !e.expanded && e.count !== 0);
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
        <div className="expand-actions">
          {forward.length > 0 && (
            <button
              className="expand-all"
              disabled={!canExpand(forward)}
              onClick={() => onExpandDirection('forward')}
              title="Follow this row's foreign keys to the rows it references"
            >
              → outgoing ({forward.length})
            </button>
          )}
          {reverse.length > 0 && (
            <button
              className="expand-all"
              disabled={!canExpand(reverse)}
              onClick={() => onExpandDirection('reverse')}
              title="Pull in rows that reference this row"
            >
              ← incoming ({reverse.length})
            </button>
          )}
        </div>
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
