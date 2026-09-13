import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { introspect, type Queryable } from './introspect.ts';
import { PgDataSource } from './data.ts';
import { buildServer } from './app.ts';

let pg: PGlite;
let app: FastifyInstance;
let albumArtistFk: number;

before(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE artist (artist_id integer PRIMARY KEY, name text NOT NULL);
    CREATE TABLE album (
      album_id integer PRIMARY KEY,
      title text,
      artist_id integer NOT NULL REFERENCES artist(artist_id)
    );
    INSERT INTO artist VALUES (1, 'AC/DC'), (2, 'Aerosmith');
    INSERT INTO album VALUES (1, 'Let There Be Rock', 1), (2, 'Big Ones', 2);
  `);
  const db: Queryable = {
    query: (text, params) =>
      pg.query(text, params) as Promise<{ rows: Record<string, unknown>[] }>,
  };
  const schema = await introspect(db, 'public');
  albumArtistFk = schema.tables.find((t) => t.name === 'album')!.fks[0].id;
  const data = new PgDataSource(db, schema, 500);
  app = await buildServer({ getData: async () => data, logger: false });
});

after(async () => {
  await app.close();
  await pg.close();
});

test('GET /api/schema returns the introspected schema', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/schema' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.schema.tables.map((t: { name: string }) => t.name).sort(),
    ['album', 'artist'],
  );
});

test('GET /api/rows returns rows plus a per-request query log', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/rows?table=artist&limit=1' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.queryLog.length, 1);
});

test('querystring validation rejects a missing required param (400)', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/rows?limit=5' });
  assert.equal(res.statusCode, 400);
});

test('querystring validation enforces the limit ceiling (400)', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/rows?table=artist&limit=99999' });
  assert.equal(res.statusCode, 400);
});

test('GET /api/row parses the JSON pk param', async () => {
  const pk = encodeURIComponent(JSON.stringify({ album_id: 2 }));
  const res = await app.inject({ method: 'GET', url: `/api/row?table=album&pk=${pk}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().row.values.title, 'Big Ones');
});

test('POST /api/rows/batch returns ordered hits and misses from one query', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/rows/batch',
    payload: {
      table: 'artist',
      keys: [{ artist_id: 2 }, { artist_id: 999 }, { artist_id: 1 }],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.rows.map((row: { values: { name: string } } | null) => row?.values.name ?? null),
    ['Aerosmith', null, 'AC/DC'],
  );
  assert.equal(body.queryLog.length, 1);
});

test('malformed JSON in a pk param is a 400', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/row?table=album&pk=not-json' });
  assert.equal(res.statusCode, 400);
});

test('GET /api/referencing returns children and total count', async () => {
  const refValues = encodeURIComponent(JSON.stringify({ artist_id: 1 }));
  const res = await app.inject({
    method: 'GET',
    url: `/api/referencing?childTable=album&fkId=${albumArtistFk}&refValues=${refValues}&limit=25`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.totalCount, 1);
  assert.equal(body.rows[0].values.title, 'Let There Be Rock');
});

test('data routes answer 503 when no database is configured', async () => {
  const unconfigured = await buildServer({ getData: async () => null, logger: false });
  const res = await unconfigured.inject({ method: 'GET', url: '/api/schema' });
  assert.equal(res.statusCode, 503);
  await unconfigured.close();
});
