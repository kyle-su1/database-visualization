import type { SqlValue } from '@dbviz/shared';
import type { Relationship } from '../schema/relationships';
import type { GraphNode } from '../graph/session';

export interface RelEntry {
  rel: Relationship;
  key: string;
  expanded: boolean;
  /** null while the count is still loading. */
  count: number | null;
  /** How many of those rows are already nodes on the canvas. */
  present: number;
  /** How many of those are already joined to this node by the edge. */
  linked: number;
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
  // A direction is expandable while any of its relationships would still change
  // the canvas — either new rows, or an edge that isn't drawn yet.
  const canExpand = (group: RelEntry[]) =>
    group.some((e) => {
      if (e.expanded || e.count === 0 || e.count === null) return false;
      return !(e.present >= e.count && e.linked >= e.present);
    });
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
        {entries.map(({ rel, key, expanded, count, present, linked }) => {
          // Three outcomes, and the button should name the right one:
          //   some rows still to fetch      -> "expand"  (nodes will appear)
          //   all present, not all joined   -> "connect" (only edges appear)
          //   all present and all joined    -> nothing would change at all
          const allPresent = count !== null && count > 0 && present >= count;
          const nothingToAdd = allPresent && linked >= present;
          const edgesOnly = allPresent && !nothingToAdd;
          const done = expanded || nothingToAdd;
          return (
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
              {count !== null && present > 0 && (
                <span className="rel-present">
                  {allPresent ? ' on canvas' : ` · ${present} on canvas`}
                </span>
              )}
            </span>
            <button
              className="expand-button"
              disabled={done || count === 0}
              onClick={() => onExpandRel(rel)}
              title={
                nothingToAdd
                  ? 'These rows and their edges are already on the canvas — nothing left to add'
                  : edgesOnly
                    ? 'Every row on the other side is already on the canvas — this just draws the edge'
                    : undefined
              }
            >
              {done ? '✓' : edgesOnly ? 'connect' : 'expand'}
            </button>
          </div>
          );
        })}
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
