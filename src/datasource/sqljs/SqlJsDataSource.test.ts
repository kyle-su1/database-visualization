import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqlJsDataSource } from './SqlJsDataSource';
import {
  addSeed,
  countRelationship,
  emptyGraph,
  expandMore,
  expandNode,
  expandRelationship,
  isFullyExpanded,
  REVERSE_EXPAND_LIMIT,
} from '../../graph/session';
import { relationshipsFor } from '../../schema/relationships';
import type { DatabaseSchema } from '../types';

const require = createRequire(import.meta.url);

let ds: SqlJsDataSource;
let schema: DatabaseSchema;

beforeAll(async () => {
  const data = readFileSync(new URL('../../../public/Chinook.sqlite', import.meta.url));
  ds = await SqlJsDataSource.create(new Uint8Array(data), {
    locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm'),
    name: 'Chinook',
  });
  schema = await ds.getSchema();
});

describe('schema introspection', () => {
  it('finds Chinook tables with PKs and FKs', () => {
    const names = schema.tables.map((t) => t.name);
    expect(names).toContain('Artist');
    expect(names).toContain('Album');
    expect(names).toContain('Track');

    const album = schema.tables.find((t) => t.name === 'Album')!;
    expect(album.pk).toEqual(['AlbumId']);
    const artistFk = album.fks.find((fk) => fk.refTable === 'Artist')!;
    expect(artistFk.columns).toEqual(['ArtistId']);
    expect(artistFk.refColumns).toEqual(['ArtistId']);
    expect(album.rowCount).toBeGreaterThan(0);
  });

  it('handles composite primary keys (PlaylistTrack)', () => {
    const pt = schema.tables.find((t) => t.name === 'PlaylistTrack')!;
    expect(pt.pk).toEqual(['PlaylistId', 'TrackId']);
    expect(pt.fks).toHaveLength(2);
  });
});

describe('row access', () => {
  it('getRow fetches by single-column PK', async () => {
    const row = await ds.getRow('Artist', { ArtistId: 1 });
    expect(row).not.toBeNull();
    expect(row!.values.Name).toBe('AC/DC');
    expect(row!.pk).toEqual({ ArtistId: 1 });
  });

  it('getRow fetches by composite PK', async () => {
    const row = await ds.getRow('PlaylistTrack', { PlaylistId: 1, TrackId: 3402 });
    expect(row).not.toBeNull();
    expect(row!.pk).toEqual({ PlaylistId: 1, TrackId: 3402 });
  });

  it('getRow returns null for a missing row', async () => {
    expect(await ds.getRow('Artist', { ArtistId: -1 })).toBeNull();
  });

  it('getRows supports search', async () => {
    const rows = await ds.getRows('Artist', { limit: 10, searchText: 'AC/DC' });
    expect(rows.some((r) => r.values.Name === 'AC/DC')).toBe(true);
  });

  it('getReferencingRows finds children and reports totalCount', async () => {
    const album = schema.tables.find((t) => t.name === 'Album')!;
    const fk = album.fks.find((f) => f.refTable === 'Artist')!;
    const { rows, totalCount } = await ds.getReferencingRows(
      'Album',
      fk.id,
      { ArtistId: 1 },
      { limit: 25 },
    );
    expect(totalCount).toBe(2); // AC/DC has 2 albums in Chinook
    expect(rows).toHaveLength(2);
  });

  it('getReferencingRows truncates at the limit', async () => {
    const track = schema.tables.find((t) => t.name === 'Track')!;
    const fk = track.fks.find((f) => f.refTable === 'Genre')!;
    const { rows, totalCount } = await ds.getReferencingRows(
      'Track',
      fk.id,
      { GenreId: 1 }, // Rock: hundreds of tracks
      { limit: 5 },
    );
    expect(rows).toHaveLength(5);
    expect(totalCount).toBeGreaterThan(5);
  });

  it('logs parameterized queries', () => {
    const log = ds.getQueryLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((e) => e.sql.includes('?') && e.params.length > 0)).toBe(true);
  });
});

describe('expandNode (graph session over the DataSource interface)', () => {
  it('expands an Artist to its Albums (reverse) and an Album to its Artist + Tracks (both)', async () => {
    const artistT = schema.tables.find((t) => t.name === 'Artist')!;
    const seedRow = (await ds.getRow('Artist', { ArtistId: 1 }))!;
    let state = addSeed(emptyGraph(), artistT, seedRow);
    const seed = [...state.nodes.values()][0];

    const r1 = await expandNode(ds, schema, state, seed);
    state = r1.state;
    expect(r1.addedNodes).toBe(2); // 2 AC/DC albums
    expect(isFullyExpanded(schema, state, seed)).toBe(true);

    const albumNode = [...state.nodes.values()].find((n) => n.table === 'Album')!;
    const r2 = await expandNode(ds, schema, state, albumNode);
    state = r2.state;
    // Forward to Artist dedupes onto the existing seed node; tracks are new.
    expect([...state.nodes.values()].filter((n) => n.table === 'Artist')).toHaveLength(1);
    expect([...state.nodes.values()].some((n) => n.table === 'Track')).toBe(true);
  });

  it('re-expanding is idempotent', async () => {
    const artistT = schema.tables.find((t) => t.name === 'Artist')!;
    const seedRow = (await ds.getRow('Artist', { ArtistId: 1 }))!;
    const state = addSeed(emptyGraph(), artistT, seedRow);
    const seed = [...state.nodes.values()][0];

    const r1 = await expandNode(ds, schema, state, seed);
    const r2 = await expandNode(ds, schema, r1.state, seed);
    expect(r2.addedNodes).toBe(0);
    expect(r2.addedEdges).toBe(0);
  });

  it('counts relationships without expanding', async () => {
    const genreT = schema.tables.find((t) => t.name === 'Genre')!;
    const row = (await ds.getRow('Genre', { GenreId: 1 }))!; // Rock
    const state = addSeed(emptyGraph(), genreT, row);
    const node = [...state.nodes.values()][0];
    const rel = relationshipsFor(schema, 'Genre').find(
      (r) => r.kind === 'reverse' && r.childTable === 'Track',
    )!;
    const count = await countRelationship(ds, node, rel);
    expect(count).toBeGreaterThan(REVERSE_EXPAND_LIMIT);
  });

  it('truncates hub expansion into a pill and paginates with expandMore', async () => {
    const genreT = schema.tables.find((t) => t.name === 'Genre')!;
    const row = (await ds.getRow('Genre', { GenreId: 1 }))!; // Rock: hundreds of tracks
    let state = addSeed(emptyGraph(), genreT, row);
    const node = [...state.nodes.values()][0];
    const rel = relationshipsFor(schema, 'Genre').find(
      (r) => r.kind === 'reverse' && r.childTable === 'Track',
    )!;

    const r1 = await expandRelationship(ds, schema, state, node, rel);
    state = r1.state;
    expect(r1.addedNodes).toBe(REVERSE_EXPAND_LIMIT);
    expect(r1.truncated).toHaveLength(1);
    expect(state.pills.size).toBe(1);
    const pill = [...state.pills.values()][0];
    expect(pill.fetched).toBe(REVERSE_EXPAND_LIMIT);
    expect(pill.total).toBeGreaterThan(REVERSE_EXPAND_LIMIT);

    const r2 = await expandMore(ds, schema, state, pill);
    state = r2.state;
    expect(r2.addedNodes).toBe(REVERSE_EXPAND_LIMIT);
    expect(state.nodes.size).toBe(1 + REVERSE_EXPAND_LIMIT * 2);
    const pill2 = [...state.pills.values()][0];
    expect(pill2.fetched).toBe(REVERSE_EXPAND_LIMIT * 2);
    expect(pill2.total).toBe(pill.total);
  });

  it('handles self-referencing FKs (Employee.ReportsTo) without duplication', async () => {
    const empT = schema.tables.find((t) => t.name === 'Employee')!;
    const gm = (await ds.getRow('Employee', { EmployeeId: 2 }))!; // reports to 1, has reports
    let state = addSeed(emptyGraph(), empT, gm);
    const node = [...state.nodes.values()][0];

    const r = await expandNode(ds, schema, state, node);
    state = r.state;
    const employees = [...state.nodes.values()].filter((n) => n.table === 'Employee');
    // Manager (forward) + direct reports (reverse) + self, all distinct node ids.
    expect(new Set(employees.map((n) => n.id)).size).toBe(employees.length);
    expect(employees.length).toBeGreaterThan(1);
  });
});
