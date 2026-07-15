import type { QueryLogEntry } from '../datasource/types';

interface Props {
  entries: QueryLogEntry[];
  onClose: () => void;
}

const MAX_SHOWN = 100;

export function QueryLog({ entries, onClose }: Props) {
  const shown = entries.slice(-MAX_SHOWN).reverse();
  return (
    <div className="panel query-log">
      <div className="panel-title">
        SQL log ({entries.length} queries)
        <button className="link-button" onClick={onClose}>
          close
        </button>
      </div>
      <div className="query-list">
        {shown.map((e, i) => (
          <div key={entries.length - i} className="query-entry">
            <code>{e.sql}</code>
            <span className="query-meta">
              {e.params.length > 0 && <>params: {JSON.stringify(e.params)} · </>}
              {e.ms.toFixed(1)}ms
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
