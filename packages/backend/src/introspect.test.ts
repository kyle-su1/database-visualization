import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { DatabaseSchema, TableSchema } from '@dbviz/shared';
import { introspect, type Queryable } from './introspect.ts';

let pg: PGlite;
let schema: DatabaseSchema;

const table = (name: string): TableSchema => {
  const t = schema.tables.find((x) => x.name === name);
  assert.ok(t, `table ${name} present`);
  return t;
};

before(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE artist (
      artist_id integer PRIMARY KEY,
      name text NOT NULL
    );
    CREATE TABLE album (
      album_id integer PRIMARY KEY,
      title text,
      artist_id integer NOT NULL REFERENCES artist(artist_id)
    );
    CREATE TABLE playlist (
      playlist_id integer PRIMARY KEY,
      name text
    );
    CREATE TABLE track (
      track_id integer PRIMARY KEY,
      name text,
      album_id integer REFERENCES album(album_id)
    );
    -- junction: composite PK, two FKs, one payload column
    CREATE TABLE playlist_track (
      playlist_id integer NOT NULL REFERENCES playlist(playlist_id),
      track_id integer NOT NULL REFERENCES track(track_id),
      position integer,
      PRIMARY KEY (playlist_id, track_id)
    );
    -- composite-key target + composite FK, to test column-pair ORDERING
    CREATE TABLE seat (
      section text NOT NULL,
      row_num integer NOT NULL,
      PRIMARY KEY (section, row_num)
    );
    CREATE TABLE ticket (
      ticket_id integer PRIMARY KEY,
      seat_section text,
      seat_row integer,
      FOREIGN KEY (seat_section, seat_row) REFERENCES seat(section, row_num)
    );
    INSERT INTO artist (artist_id, name)
      SELECT g, 'artist ' || g FROM generate_series(1, 7) g;
    ANALYZE artist;
  `);
  const db: Queryable = {
    query: (text, params) =>
      pg.query(text, params) as Promise<{ rows: Record<string, unknown>[] }>,
  };
  schema = await introspect(db, 'public');
});

after(async () => {
  await pg.close();
});

test('discovers every table', () => {
  assert.deepEqual(
    schema.tables.map((t) => t.name).sort(),
    ['album', 'artist', 'playlist', 'playlist_track', 'seat', 'ticket', 'track'],
  );
});

test('columns carry type and NOT NULL', () => {
  const album = table('album');
  assert.deepEqual(
    album.columns.map((c) => c.name),
    ['album_id', 'title', 'artist_id'],
  );
  assert.equal(album.columns.find((c) => c.name === 'artist_id')?.notNull, true);
  assert.equal(album.columns.find((c) => c.name === 'title')?.notNull, false);
});

test('single-column primary key', () => {
  assert.deepEqual(table('artist').pk, ['artist_id']);
});

test('composite primary key preserves column order', () => {
  assert.deepEqual(table('playlist_track').pk, ['playlist_id', 'track_id']);
});

test('single-column foreign key resolves child and parent columns', () => {
  const fks = table('album').fks;
  assert.equal(fks.length, 1);
  assert.deepEqual(fks[0].columns, ['artist_id']);
  assert.equal(fks[0].refTable, 'artist');
  assert.deepEqual(fks[0].refColumns, ['artist_id']);
  assert.equal(typeof fks[0].id, 'number');
});

test('junction table exposes both foreign keys', () => {
  const fks = table('playlist_track').fks;
  assert.equal(fks.length, 2);
  assert.deepEqual(new Set(fks.map((f) => f.refTable)), new Set(['playlist', 'track']));
});

test('composite foreign key pairs columns in the right order', () => {
  const fks = table('ticket').fks;
  assert.equal(fks.length, 1);
  assert.deepEqual(fks[0].columns, ['seat_section', 'seat_row']);
  assert.equal(fks[0].refTable, 'seat');
  assert.deepEqual(fks[0].refColumns, ['section', 'row_num']);
});

test('row count comes from the analyzed estimate', () => {
  assert.equal(table('artist').rowCount, 7);
});

test('table with no primary key falls back to ctid', async () => {
  await pg.exec(`CREATE TABLE log_line (message text);`);
  const db: Queryable = {
    query: (text, params) =>
      pg.query(text, params) as Promise<{ rows: Record<string, unknown>[] }>,
  };
  const s = await introspect(db, 'public');
  assert.deepEqual(s.tables.find((t) => t.name === 'log_line')?.pk, ['ctid']);
});
