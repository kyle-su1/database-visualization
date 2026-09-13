import { cpus } from 'node:os';
import { Pool } from 'pg';
import type { DatabaseSchema, PkValue, Row, TableSchema } from '@dbviz/shared';
import { config } from './config.ts';
import { PgDataSource } from './data.ts';
import type { Queryable } from './introspect.ts';

const CONCURRENCY = 8;
const DEFAULT_SIZES = [25, 100, 500];

interface Measurement {
  ms: number;
  queries: number;
  rows: (Row | null)[];
}

interface Summary {
  medianMs: number;
  p95Ms: number;
  queries: number;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function benchmarkSizes(): number[] {
  const raw = process.env.BENCH_SIZES;
  if (!raw) return DEFAULT_SIZES;
  const sizes = raw.split(',').map((part) => Number(part.trim()));
  if (sizes.length === 0 || sizes.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error('BENCH_SIZES must be a comma-separated list of positive integers');
  }
  return sizes;
}

function quoteIdentifier(identifier: string): string {
  return '"' + identifier.replace(/"/g, '""') + '"';
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      output[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function measureRowByRow(
  data: PgDataSource,
  table: string,
  keys: PkValue[],
): Promise<Measurement> {
  let queries = 0;
  const started = performance.now();
  const rows = await mapLimit(keys, CONCURRENCY, async (key) => {
    const result = await data.getRow(table, key);
    queries += result.queryLog.length;
    return result.row;
  });
  return { ms: performance.now() - started, queries, rows };
}

async function measureBatch(
  data: PgDataSource,
  table: string,
  keys: PkValue[],
): Promise<Measurement> {
  const started = performance.now();
  const result = await data.getRowsByKeys(table, keys);
  return {
    ms: performance.now() - started,
    queries: result.queryLog.length,
    rows: result.rows,
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples: Measurement[]): Summary {
  return {
    medianMs: percentile(samples.map((sample) => sample.ms), 0.5),
    p95Ms: percentile(samples.map((sample) => sample.ms), 0.95),
    queries: samples[0].queries,
  };
}

function validate(measurement: Measurement, expected: number): void {
  if (
    measurement.rows.length !== expected ||
    measurement.rows.some((row, index) => row?.pk.id !== index + 1)
  ) {
    throw new Error(`Benchmark returned an incorrect result for ${expected} keys`);
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.BENCH_DATABASE_URL ?? config.databaseUrl;
  if (!connectionString) {
    throw new Error(
      'Set BENCH_DATABASE_URL or DATABASE_URL to a disposable PostgreSQL database before running the benchmark',
    );
  }

  const sizes = benchmarkSizes();
  const runs = positiveInt('BENCH_RUNS', 20);
  const warmups = positiveInt('BENCH_WARMUPS', 3);
  const largest = Math.max(...sizes);
  const tableName = `dbviz_batch_bench_${process.pid}`;
  const quotedTable = quoteIdentifier(tableName);
  const pool = new Pool({ connectionString, max: CONCURRENCY });

  try {
    await pool.query(`DROP TABLE IF EXISTS ${quotedTable}`);
    await pool.query(
      `CREATE TABLE ${quotedTable} (id integer PRIMARY KEY, label text NOT NULL)`,
    );
    await pool.query(
      `INSERT INTO ${quotedTable} (id, label) ` +
        `SELECT value, 'parent-' || value FROM generate_series(1, $1) AS value`,
      [largest],
    );
    await pool.query(`ANALYZE ${quotedTable}`);

    const table: TableSchema = {
      name: tableName,
      columns: [
        { name: 'id', type: 'integer', notNull: true },
        { name: 'label', type: 'text', notNull: true },
      ],
      pk: ['id'],
      fks: [],
      rowCount: largest,
    };
    const schema: DatabaseSchema = { name: 'batch-benchmark', tables: [table] };
    const db: Queryable = {
      query: async (text, params) => ({ rows: (await pool.query(text, params)).rows }),
    };
    const data = new PgDataSource(db, schema, largest);
    const version = await pool.query('SHOW server_version');

    console.log('Batched key lookup benchmark');
    console.log(`PostgreSQL ${version.rows[0].server_version}`);
    console.log(`${cpus()[0]?.model ?? 'unknown CPU'}; concurrency ${CONCURRENCY}`);
    console.log(`${runs} measured runs after ${warmups} warmups`);

    const output: Record<string, string | number>[] = [];
    for (const size of sizes) {
      const keys = Array.from({ length: size }, (_, index) => ({ id: index + 1 }));

      for (let index = 0; index < warmups; index++) {
        validate(await measureRowByRow(data, tableName, keys), size);
        validate(await measureBatch(data, tableName, keys), size);
      }

      const rowByRowSamples: Measurement[] = [];
      const batchSamples: Measurement[] = [];
      for (let index = 0; index < runs; index++) {
        // Alternate order so cache and background activity do not consistently
        // favor either implementation.
        if (index % 2 === 0) {
          rowByRowSamples.push(await measureRowByRow(data, tableName, keys));
          batchSamples.push(await measureBatch(data, tableName, keys));
        } else {
          batchSamples.push(await measureBatch(data, tableName, keys));
          rowByRowSamples.push(await measureRowByRow(data, tableName, keys));
        }
      }
      rowByRowSamples.forEach((sample) => validate(sample, size));
      batchSamples.forEach((sample) => validate(sample, size));

      const rowByRow = summarize(rowByRowSamples);
      const batch = summarize(batchSamples);
      output.push({
        keys: size,
        'row queries': rowByRow.queries,
        'batch queries': batch.queries,
        'row p50 ms': rowByRow.medianMs.toFixed(2),
        'batch p50 ms': batch.medianMs.toFixed(2),
        'row p95 ms': rowByRow.p95Ms.toFixed(2),
        'batch p95 ms': batch.p95Ms.toFixed(2),
        'p95 speedup': `${(rowByRow.p95Ms / batch.p95Ms).toFixed(2)}x`,
      });
    }
    console.table(output);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${quotedTable}`).catch(() => undefined);
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
