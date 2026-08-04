import type { QueryLogEntry } from '@dbviz/shared';

/**
 * One user-visible expansion mapped to the half-open range of query-log
 * entries it fired: log[start..end). Recorded by App around each expansion.
 */
export interface ExpansionSpan {
  label: string;
  start: number;
  end: number;
}

interface Props {
  entries: QueryLogEntry[];
  spans: ExpansionSpan[];
  onClose: () => void;
}

interface Group {
  label: string;
  /** Index of the first entry in the full log (for stable keys). */
  start: number;
  entries: QueryLogEntry[];
  /** Expansion group (vs background schema/count/search queries). */
  expansion: boolean;
}

/** Total entries rendered before older groups are elided. */
const ENTRY_BUDGET = 150;
/** An expansion firing this many queries gets flagged — the N+1 smell. */
const HOT_THRESHOLD = 10;

const BACKGROUND_LABEL = 'background (schema · counts · search)';

/** Slot every log entry into its expansion span; gaps become background groups. */
function groupEntries(entries: QueryLogEntry[], spans: ExpansionSpan[]): Group[] {
  const groups: Group[] = [];
  let i = 0;
  for (const s of spans) {
    if (i < s.start) {
      groups.push({
        label: BACKGROUND_LABEL,
        start: i,
        entries: entries.slice(i, s.start),
        expansion: false,
      });
    }
    if (s.end > s.start) {
      groups.push({
        label: s.label,
        start: s.start,
        entries: entries.slice(s.start, s.end),
        expansion: true,
      });
    }
    i = Math.max(i, s.end);
  }
  if (i < entries.length) {
    groups.push({
      label: BACKGROUND_LABEL,
      start: i,
      entries: entries.slice(i),
      expansion: false,
    });
  }
  return groups;
}

export function QueryLog({ entries, spans, onClose }: Props) {
  const groups = groupEntries(entries, spans);

  // Newest groups first; stop rendering once the entry budget is spent.
  const shown: Group[] = [];
  let budget = ENTRY_BUDGET;
  for (let g = groups.length - 1; g >= 0 && budget > 0; g--) {
    shown.push(groups[g]);
    budget -= groups[g].entries.length;
  }
  const hidden = entries.length - shown.reduce((n, g) => n + g.entries.length, 0);

  return (
    <div className="panel query-log">
      <div className="panel-title">
        SQL log ({entries.length} queries)
        <button className="link-button" onClick={onClose}>
          close
        </button>
      </div>
      <div className="query-list">
        {shown.map((g) => {
          const ms = g.entries.reduce((t, e) => t + e.ms, 0);
          const hot = g.expansion && g.entries.length >= HOT_THRESHOLD;
          return (
            <div key={`${g.start}-${g.label}`} className="query-group">
              <div className={'query-group-header' + (g.expansion ? '' : ' background')}>
                {g.label}
                <span className={'group-count' + (hot ? ' hot' : '')}>
                  {g.entries.length} {g.entries.length === 1 ? 'query' : 'queries'} ·{' '}
                  {ms.toFixed(1)}ms
                  {hot && ' — N+1 pattern'}
                </span>
              </div>
              {g.entries.map((e, i) => (
                <div key={g.start + i} className="query-entry">
                  <code>{e.sql}</code>
                  <span className="query-meta">
                    {e.params.length > 0 && <>params: {JSON.stringify(e.params)} · </>}
                    {e.ms.toFixed(1)}ms
                  </span>
                </div>
              ))}
            </div>
          );
        })}
        {hidden > 0 && <div className="query-meta">… {hidden} older queries hidden</div>}
      </div>
    </div>
  );
}
