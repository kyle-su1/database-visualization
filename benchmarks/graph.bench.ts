import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import react from '@vitejs/plugin-react';
import { config as loadEnv } from 'dotenv';
import { chromium, type Browser, type Page } from 'playwright';
import { Pool } from 'pg';
import { build, preview, type PreviewServer } from 'vite';
import { buildServer } from '../packages/backend/src/app.ts';
import { PgDataSource } from '../packages/backend/src/data.ts';
import { introspect, type Queryable } from '../packages/backend/src/introspect.ts';

const HOST = '127.0.0.1';
const EXPECTED_NODE_COUNTS = [25, 97, 457, 1177];
const EXPAND_INCOMING_TITLE = 'Expand every node one hop along incoming references';

loadEnv({ path: fileURLToPath(new URL('../packages/backend/.env', import.meta.url)) });

interface ExpansionMeasurement {
  ms: number;
  beforeNodes: number;
  afterNodes: number;
  afterEdges: number;
  queries: number;
  maxFrameGapMs: number;
}

interface StageSummary {
  graph: string;
  added: number;
  edges: number;
  queries: number;
  p50Ms: string;
  p95Ms: string;
  p95FrameGapMs: string;
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

function quoteIdentifier(identifier: string): string {
  return '"' + identifier.replace(/"/g, '""') + '"';
}

function addressPort(address: AddressInfo | string | null): number {
  if (!address || typeof address === 'string') throw new Error('Server did not expose a TCP port');
  return address.port;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function createFixture(pool: Pool, schema: string): Promise<void> {
  const qSchema = quoteIdentifier(schema);
  await pool.query(`CREATE SCHEMA ${qSchema}`);
  await pool.query(`CREATE TABLE ${qSchema}.bench_0_root (id integer PRIMARY KEY)`);
  await pool.query(
    `CREATE TABLE ${qSchema}.bench_1 (` +
      `id integer PRIMARY KEY, parent_id integer NOT NULL ` +
      `REFERENCES ${qSchema}.bench_0_root(id))`,
  );
  await pool.query(
    `CREATE TABLE ${qSchema}.bench_2 (` +
      `id integer PRIMARY KEY, parent_id integer NOT NULL ` +
      `REFERENCES ${qSchema}.bench_1(id))`,
  );
  await pool.query(
    `CREATE TABLE ${qSchema}.bench_3 (` +
      `id integer PRIMARY KEY, parent_id integer NOT NULL ` +
      `REFERENCES ${qSchema}.bench_2(id))`,
  );
  await pool.query(
    `CREATE TABLE ${qSchema}.bench_4 (` +
      `id integer PRIMARY KEY, parent_id integer NOT NULL ` +
      `REFERENCES ${qSchema}.bench_3(id))`,
  );

  await pool.query(`INSERT INTO ${qSchema}.bench_0_root VALUES (1)`);
  await pool.query(
    `INSERT INTO ${qSchema}.bench_1 ` +
      `SELECT child, 1 FROM generate_series(1, 24) AS child`,
  );
  await pool.query(
    `INSERT INTO ${qSchema}.bench_2 ` +
      `SELECT (parent - 1) * 3 + child, parent ` +
      `FROM generate_series(1, 24) AS parent ` +
      `CROSS JOIN generate_series(1, 3) AS child`,
  );
  await pool.query(
    `INSERT INTO ${qSchema}.bench_3 ` +
      `SELECT (parent - 1) * 5 + child, parent ` +
      `FROM generate_series(1, 72) AS parent ` +
      `CROSS JOIN generate_series(1, 5) AS child`,
  );
  await pool.query(
    `INSERT INTO ${qSchema}.bench_4 ` +
      `SELECT (parent - 1) * 2 + child, parent ` +
      `FROM generate_series(1, 360) AS parent ` +
      `CROSS JOIN generate_series(1, 2) AS child`,
  );
  for (let level = 0; level <= 4; level++) {
    const table = `bench_${level}${level === 0 ? '_root' : ''}`;
    await pool.query(`ANALYZE ${qSchema}.${quoteIdentifier(table)}`);
  }
}

async function preparePage(page: Page, frontendUrl: string): Promise<void> {
  await page.goto(frontendUrl);
  await page.getByRole('button', { name: 'Connect to Postgres' }).click();
  await page.waitForFunction(
    () => document.querySelector('[role="status"]')?.textContent?.startsWith('Postgres (server)'),
    undefined,
    { timeout: 15_000 },
  );
  await page.locator('.stagger-control input[type="range"]').fill('0');
  await page.waitForFunction(
    () => document.querySelectorAll('.graph-canvas .node').length === 1,
    undefined,
    { timeout: 5_000 },
  );
}

async function measureExpansion(page: Page): Promise<ExpansionMeasurement> {
  return page.evaluate(async (buttonTitle) => {
    const button = document.querySelector<HTMLButtonElement>(`button[title="${buttonTitle}"]`);
    const status = document.querySelector<HTMLElement>('[role="status"]');
    const canvas = document.querySelector<SVGSVGElement>('.graph-canvas');
    if (!button || !status || !canvas) throw new Error('Benchmark UI controls were not found');
    if (button.disabled) throw new Error(`Expansion button is disabled: ${button.textContent}`);

    const beforeNodes = canvas.querySelectorAll('.node').length;
    const started = performance.now();
    let sawBusyState = false;
    let lastFrame = started;
    let maxFrameGapMs = 0;
    let sampleFrames = true;
    const recordFrame = (now: number) => {
      maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrame);
      lastFrame = now;
      if (sampleFrames) requestAnimationFrame(recordFrame);
    };
    requestAnimationFrame(recordFrame);

    return new Promise<ExpansionMeasurement>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Expansion timed out: ${status.textContent}`));
      }, 30_000);
      const observer = new MutationObserver(() => {
        const text = status.textContent ?? '';
        if (text.startsWith('Expanding ')) sawBusyState = true;
        if (!sawBusyState || !text.startsWith('Expanded ')) return;
        observer.disconnect();
        window.clearTimeout(timeout);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            sampleFrames = false;
            const queryMatch = text.match(/ · (\d+) quer(?:y|ies)/);
            resolve({
              ms: performance.now() - started,
              beforeNodes,
              afterNodes: canvas.querySelectorAll('.node').length,
              afterEdges: canvas.querySelectorAll('.edge').length,
              queries: queryMatch ? Number(queryMatch[1]) : -1,
              maxFrameGapMs,
            });
          });
        });
      });
      observer.observe(status, { childList: true, characterData: true, subtree: true });
      button.click();
    });
  }, EXPAND_INCOMING_TITLE);
}

async function runSequence(page: Page, frontendUrl: string): Promise<ExpansionMeasurement[]> {
  await preparePage(page, frontendUrl);
  const measurements: ExpansionMeasurement[] = [];
  for (const expectedNodes of EXPECTED_NODE_COUNTS) {
    const measurement = await measureExpansion(page);
    if (measurement.afterNodes !== expectedNodes || measurement.afterEdges !== expectedNodes - 1) {
      throw new Error(
        `Expected ${expectedNodes} nodes and ${expectedNodes - 1} edges, got ` +
          `${measurement.afterNodes} nodes and ${measurement.afterEdges} edges`,
      );
    }
    measurements.push(measurement);
  }
  return measurements;
}

async function main(): Promise<void> {
  const connectionString = process.env.GRAPH_BENCH_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'Set GRAPH_BENCH_DATABASE_URL or DATABASE_URL to a disposable PostgreSQL database',
    );
  }

  const runs = positiveInt('GRAPH_BENCH_RUNS', 20);
  const warmups = positiveInt('GRAPH_BENCH_WARMUPS', 2);
  const schemaName = `dbviz_graph_bench_${process.pid}`;
  const frontendRoot = fileURLToPath(new URL('../packages/frontend', import.meta.url));
  const adminPool = new Pool({ connectionString, max: 2 });
  let dataPool: Pool | undefined;
  let backend: Awaited<ReturnType<typeof buildServer>> | undefined;
  let frontend: PreviewServer | undefined;
  let browser: Browser | undefined;

  try {
    await createFixture(adminPool, schemaName);
    dataPool = new Pool({
      connectionString,
      max: 10,
      options: `-c search_path=${schemaName},public`,
    });
    const db: Queryable = {
      query: async (text, params) => ({ rows: (await dataPool!.query(text, params)).rows }),
    };
    const schema = await introspect(db, schemaName);
    const data = new PgDataSource(db, schema, 500);

    backend = await buildServer({ getData: async () => data, logger: false });
    await backend.listen({ host: HOST, port: 0 });
    const backendPort = addressPort(backend.server.address());

    await build({
      configFile: false,
      root: frontendRoot,
      plugins: [react()],
      logLevel: 'error',
    });
    frontend = await preview({
      configFile: false,
      root: frontendRoot,
      logLevel: 'error',
      preview: {
        host: HOST,
        port: 0,
        strictPort: false,
        proxy: { '/api': `http://${HOST}:${backendPort}` },
      },
    });
    const frontendPort = addressPort(frontend.httpServer.address());
    const frontendUrl = `http://${HOST}:${frontendPort}`;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    for (let index = 0; index < warmups; index++) {
      await runSequence(page, frontendUrl);
    }

    const samples = EXPECTED_NODE_COUNTS.map(() => [] as ExpansionMeasurement[]);
    for (let run = 0; run < runs; run++) {
      const sequence = await runSequence(page, frontendUrl);
      sequence.forEach((measurement, stage) => samples[stage].push(measurement));
    }
    if (pageErrors.length > 0) throw pageErrors[0];

    const version = await adminPool.query('SHOW server_version');
    console.log('End-to-end graph expansion benchmark');
    console.log(`Chromium ${browser.version()}; PostgreSQL ${version.rows[0].server_version}`);
    console.log(
      `${cpus()[0]?.model ?? 'unknown CPU'}; production build; viewport 1440x900; reveal disabled`,
    );
    console.log(`${runs} measured runs after ${warmups} warmups`);
    console.log('Latency runs from DOM click through API, SQL, React commit, and two paint frames.');
    console.log('Frame gap is the longest requestAnimationFrame interval during each expansion.');

    const output: StageSummary[] = samples.map((stageSamples) => {
      const first = stageSamples[0];
      const durations = stageSamples.map((sample) => sample.ms);
      return {
        graph: `${first.beforeNodes} → ${first.afterNodes} nodes`,
        added: first.afterNodes - first.beforeNodes,
        edges: first.afterEdges,
        queries: first.queries,
        p50Ms: percentile(durations, 0.5).toFixed(2),
        p95Ms: percentile(durations, 0.95).toFixed(2),
        p95FrameGapMs: percentile(
          stageSamples.map((sample) => sample.maxFrameGapMs),
          0.95,
        ).toFixed(2),
      };
    });
    console.table(output);
  } finally {
    await browser?.close().catch(() => undefined);
    await frontend?.close().catch(() => undefined);
    await backend?.close().catch(() => undefined);
    await dataPool?.end().catch(() => undefined);
    await adminPool
      .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`)
      .catch(() => undefined);
    await adminPool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
