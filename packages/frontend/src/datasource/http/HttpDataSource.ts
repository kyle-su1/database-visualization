import type {
  DataSource,
  DatabaseSchema,
  PkValue,
  QueryLogEntry,
  Row,
} from '@dbviz/shared';

/** The subset of `fetch` we use; injectable so the client is testable without a network. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  /** API root the endpoints hang off. Default '/api' (Vite proxies it to the server in dev). */
  baseUrl?: string;
  fetch?: FetchLike;
}

/**
 * DataSource backed by the Fastify server's read endpoints — the server-backed
 * twin of SqlJsDataSource. Each method is one GET whose response carries the
 * SQL the server ran; those entries accumulate here so the query-log panel
 * works identically to the in-browser source. Nothing above the DataSource
 * boundary knows which implementation it's talking to.
 */
export class HttpDataSource implements DataSource {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly log: QueryLogEntry[] = [];

  constructor(opts: HttpOptions = {}) {
    this.baseUrl = opts.baseUrl ?? '/api';
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async getSchema(): Promise<DatabaseSchema> {
    const { schema } = await this.get<{ schema: DatabaseSchema }>('/schema', {});
    return schema;
  }

  async getRow(table: string, pk: PkValue): Promise<Row | null> {
    const { row, queryLog } = await this.get<{ row: Row | null; queryLog: QueryLogEntry[] }>(
      '/row',
      { table, pk: JSON.stringify(pk) },
    );
    this.record(queryLog);
    return row;
  }

  async getRows(
    table: string,
    opts: { limit: number; offset?: number; searchText?: string },
  ): Promise<Row[]> {
    const { rows, queryLog } = await this.get<{ rows: Row[]; queryLog: QueryLogEntry[] }>('/rows', {
      table,
      limit: opts.limit,
      offset: opts.offset,
      search: opts.searchText,
    });
    this.record(queryLog);
    return rows;
  }

  async getReferencingRows(
    childTable: string,
    fkId: number,
    refValues: PkValue,
    opts: { limit: number; offset?: number },
  ): Promise<{ rows: Row[]; totalCount: number }> {
    const { rows, totalCount, queryLog } = await this.get<{
      rows: Row[];
      totalCount: number;
      queryLog: QueryLogEntry[];
    }>('/referencing', {
      childTable,
      fkId,
      refValues: JSON.stringify(refValues),
      limit: opts.limit,
      offset: opts.offset,
    });
    this.record(queryLog);
    return { rows, totalCount };
  }

  getQueryLog(): QueryLogEntry[] {
    return [...this.log];
  }

  // --------------------------------------------------------------- helpers

  private record(entries: QueryLogEntry[] | undefined): void {
    if (entries) this.log.push(...entries);
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) qs.set(key, String(value));
    }
    const query = qs.toString();
    const res = await this.fetchFn(`${this.baseUrl}${path}${query ? `?${query}` : ''}`);
    if (!res.ok) throw new Error(await errorMessage(res));
    return (await res.json()) as T;
  }
}

/** Prefer the server's `{ message }` body over a bare status line. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof (body as { message?: unknown }).message === 'string') {
      return `${res.status}: ${(body as { message: string }).message}`;
    }
  } catch {
    // non-JSON body; fall through to the status line
  }
  return `${res.status} ${res.statusText}`;
}

export function createHttpDataSource(baseUrl?: string): DataSource {
  return new HttpDataSource({ baseUrl });
}
