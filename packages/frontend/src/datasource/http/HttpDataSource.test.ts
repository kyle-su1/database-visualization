import { describe, it, expect } from 'vitest';
import type { QueryLogEntry } from '@dbviz/shared';
import { HttpDataSource } from './HttpDataSource';

/** A fetch stub that records request URLs and replies from a path->body table. */
function stubFetch(table: Record<string, unknown>) {
  const urls: string[] = [];
  const fetchFn = async (input: string): Promise<Response> => {
    urls.push(input);
    const path = input.split('?')[0];
    const body = table[path];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { urls, fetchFn };
}

const log = (sql: string): QueryLogEntry[] => [{ sql, params: [], ms: 1 }];

describe('HttpDataSource', () => {
  it('getSchema fetches /api/schema and unwraps the schema', async () => {
    const { urls, fetchFn } = stubFetch({
      '/api/schema': { schema: { name: 'chinook', tables: [{ name: 'artist' }] } },
    });
    const ds = new HttpDataSource({ fetch: fetchFn });
    const schema = await ds.getSchema();
    expect(schema.name).toBe('chinook');
    expect(urls).toEqual(['/api/schema']);
  });

  it('getRows encodes params and accumulates the server query log', async () => {
    const { urls, fetchFn } = stubFetch({
      '/api/rows': { rows: [{ pk: { artist_id: 2 }, values: { name: 'Aerosmith' } }], queryLog: log('SELECT … LIMIT $1 OFFSET $2') },
    });
    const ds = new HttpDataSource({ fetch: fetchFn });
    const rows = await ds.getRows('artist', { limit: 20, searchText: 'aero' });
    expect(rows).toHaveLength(1);
    // omitted offset is dropped; provided params are present
    expect(urls[0]).toBe('/api/rows?table=artist&limit=20&search=aero');
    expect(ds.getQueryLog()).toHaveLength(1);
  });

  it('getRow encodes the pk as JSON', async () => {
    const { urls, fetchFn } = stubFetch({
      '/api/row': { row: { pk: { album_id: 3 }, values: { title: 'Big Ones' } }, queryLog: log('SELECT … WHERE "album_id" = $1') },
    });
    const ds = new HttpDataSource({ fetch: fetchFn });
    const row = await ds.getRow('album', { album_id: 3 });
    expect(row?.values.title).toBe('Big Ones');
    expect(urls[0]).toBe(`/api/row?table=album&pk=${encodeURIComponent('{"album_id":3}')}`);
  });

  it('getRowsByKeys posts one ordered batch and accumulates its query log', async () => {
    const requests: { input: string; init?: RequestInit }[] = [];
    const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
      requests.push({ input, init });
      return new Response(
        JSON.stringify({
          rows: [{ pk: { artist_id: 2 }, values: { name: 'Aerosmith' } }, null],
          queryLog: log('SELECT batch'),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const ds = new HttpDataSource({ fetch: fetchFn });
    const rows = await ds.getRowsByKeys('artist', [{ artist_id: 2 }, { artist_id: 999 }]);
    expect(rows.map((row) => row?.values.name ?? null)).toEqual(['Aerosmith', null]);
    expect(requests[0].input).toBe('/api/rows/batch');
    expect(requests[0].init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      table: 'artist',
      keys: [{ artist_id: 2 }, { artist_id: 999 }],
    });
    expect(ds.getQueryLog()).toHaveLength(1);
  });

  it('getReferencingRows passes JSON refValues, keeps limit 0, returns rows + total', async () => {
    const { urls, fetchFn } = stubFetch({
      '/api/referencing': { rows: [], totalCount: 42, queryLog: log('SELECT COUNT(*) …') },
    });
    const ds = new HttpDataSource({ fetch: fetchFn });
    const result = await ds.getReferencingRows('album', 7, { artist_id: 1 }, { limit: 0 });
    expect(result.totalCount).toBe(42);
    expect(urls[0]).toBe(
      `/api/referencing?childTable=album&fkId=7&refValues=${encodeURIComponent('{"artist_id":1}')}&limit=0`,
    );
  });

  it('accumulates the query log across calls', async () => {
    const { fetchFn } = stubFetch({
      '/api/rows': { rows: [], queryLog: log('one') },
      '/api/referencing': { rows: [], totalCount: 0, queryLog: log('two') },
    });
    const ds = new HttpDataSource({ fetch: fetchFn });
    await ds.getRows('artist', { limit: 5 });
    await ds.getReferencingRows('album', 1, { artist_id: 1 }, { limit: 25 });
    expect(ds.getQueryLog().map((e) => e.sql)).toEqual(['one', 'two']);
  });

  it('throws the server error message on a non-ok response', async () => {
    const fetchFn = async (): Promise<Response> =>
      new Response(JSON.stringify({ statusCode: 400, message: 'Unknown table: nope' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    const ds = new HttpDataSource({ fetch: fetchFn });
    await expect(ds.getRows('nope', { limit: 5 })).rejects.toThrow('Unknown table: nope');
  });
});
