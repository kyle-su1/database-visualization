import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { introspect, type Queryable } from './introspect.ts';
import { PgDataSource } from './data.ts';

let pg: PGlite;
let data: PgDataSource;
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
    INSERT INTO artist VALUES (1, 'AC/DC'), (2, 'Aerosmith'), (3, 'Audioslave');
    INSERT INTO album VALUES
      (1, 'For Those About To Rock', 1),
      (2, 'Let There Be Rock', 1),
      (3, 'Big Ones', 2),
      (4, 'Out Of Exile', 3);
  `);
  const db: Queryable = {
    query: (text, params) =>
      pg.query(text, params) as Promise<{ rows: Record<string, unknown>[] }>,
  };
  const schema = await introspect(db, 'public');
  data = new PgDataSource(db, schema, 500);
  albumArtistFk = schema.tables.find((t) => t.name === 'album')!.fks[0].id;
});

after(async () => {
  await pg.close();
});

test('getRows paginates with limit/offset and logs the SQL it ran', async () => {
  const { rows, queryLog } = await data.getRows('artist', { limit: 2, offset: 1 });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].pk, { artist_id: 2 });
  assert.equal(queryLog.length, 1);
  assert.match(queryLog[0].sql, /LIMIT \$\d+ OFFSET \$\d+/);
  assert.equal(typeof queryLog[0].ms, 'number');
});

test('getRows search is case-insensitive (ILIKE)', async () => {
  const { rows } = await data.getRows('artist', { limit: 50, searchText: 'aero' });
  assert.deepEqual(
    rows.map((r) => r.values.name),
    ['Aerosmith'],
  );
});

test('getRow returns a single row or null', async () => {
  const hit = await data.getRow('album', { album_id: 3 });
  assert.equal(hit.row?.values.title, 'Big Ones');
  const miss = await data.getRow('album', { album_id: 999 });
  assert.equal(miss.row, null);
});

test('getRowsByKeys preserves key order and resolves misses in one query', async () => {
  const { rows, queryLog } = await data.getRowsByKeys('artist', [
    { artist_id: 3 },
    { artist_id: 999 },
    { artist_id: 1 },
  ]);
  assert.deepEqual(
    rows.map((row) => row?.values.name ?? null),
    ['Audioslave', null, 'AC/DC'],
  );
  assert.equal(queryLog.length, 1);
  assert.match(queryLog[0].sql, / OR /);
});

test('getRowsByKeys rejects mixed key shapes', async () => {
  await assert.rejects(
    () => data.getRowsByKeys('artist', [{ artist_id: 1 }, { name: 'Aerosmith' }]),
    { statusCode: 400 },
  );
});

test('getReferencingRows with limit 0 is count-only (one query, no rows)', async () => {
  const { rows, totalCount, queryLog } = await data.getReferencingRows(
    'album',
    albumArtistFk,
    { artist_id: 1 },
    { limit: 0 },
  );
  assert.equal(totalCount, 2);
  assert.equal(rows.length, 0);
  assert.equal(queryLog.length, 1); // only the COUNT
});

test('getReferencingRows fetches children and reports total (count + select)', async () => {
  const { rows, totalCount, queryLog } = await data.getReferencingRows(
    'album',
    albumArtistFk,
    { artist_id: 1 },
    { limit: 25 },
  );
  assert.equal(totalCount, 2);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.values.title)), new Set(['For Those About To Rock', 'Let There Be Rock']));
  assert.equal(queryLog.length, 2);
});

test('rejects an unknown table with a 400', async () => {
  await assert.rejects(() => data.getRows('nope', { limit: 10 }), { statusCode: 400 });
});

test('rejects an unknown pk column with a 400', async () => {
  await assert.rejects(() => data.getRow('artist', { bogus: 1 }), { statusCode: 400 });
});

test('rejects an unknown foreign-key id with a 400', async () => {
  await assert.rejects(
    () => data.getReferencingRows('album', 999999, { artist_id: 1 }, { limit: 25 }),
    { statusCode: 400 },
  );
});
