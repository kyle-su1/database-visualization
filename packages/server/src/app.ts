import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.ts';
import { pingDb } from './pool.ts';

/**
 * Build the Fastify instance with its middleware and routes wired, but WITHOUT
 * listening — so tests and the entry point share one construction path.
 * Phase D registers the data routes (schema/rows/row/referencing) here.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: config.corsOrigin });

  // Liveness + DB reachability. Always 200 while the process is up; the `db`
  // field reports whether the configured Postgres is reachable, so the
  // skeleton is verifiable before any data routes (or a database) exist.
  app.get('/api/health', async () => {
    return { status: 'ok', db: await pingDb() };
  });

  return app;
}
