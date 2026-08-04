import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Pool } from 'pg';
import { config } from './config.ts';
import { getPool, pingDb } from './pool.ts';
import { introspect, type Queryable } from './introspect.ts';
import { PgDataSource } from './data.ts';
import { registerDataRoutes, type GetData } from './routes.ts';
import { httpError } from './errors.ts';

/** Adapt a pg.Pool to the minimal Queryable introspect/PgDataSource expect. */
function asQueryable(pool: Pool): Queryable {
  return {
    query: async (text, params) => ({ rows: (await pool.query(text, params as unknown[])).rows }),
  };
}

/**
 * Default data provider: on first use, introspect the configured database once
 * and cache a PgDataSource over the pool. Returns null when no DB is
 * configured (routes answer 503); a caught introspection failure surfaces as
 * 503 without poisoning the cache, so a later request can retry.
 */
function makeDefaultGetData(): GetData {
  let cached: PgDataSource | null | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    const pool = getPool();
    if (!pool) {
      cached = null;
      return null;
    }
    let schema;
    try {
      schema = await introspect(asQueryable(pool), config.schema);
    } catch (err) {
      throw httpError(503, `Database unreachable: ${(err as Error).message}`);
    }
    cached = new PgDataSource(asQueryable(pool), schema, config.rowLimit);
    return cached;
  };
}

export interface ServerDeps {
  /** Injectable for tests; defaults to the pool-backed lazy provider. */
  getData?: GetData;
  /** Disable request logging (tests). */
  logger?: boolean;
}

/**
 * Build the Fastify instance with middleware and routes wired, but WITHOUT
 * listening — so tests (via app.inject) and the entry point share one path.
 */
export async function buildServer(deps: ServerDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? true });

  await app.register(cors, { origin: config.corsOrigin });

  // Liveness + DB reachability. Always 200 while the process is up.
  app.get('/api/health', async () => {
    return { status: 'ok', db: await pingDb() };
  });

  registerDataRoutes(app, deps.getData ?? makeDefaultGetData());

  return app;
}
