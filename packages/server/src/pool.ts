import pg from 'pg';
import { config } from './config.ts';

/**
 * A single lazily-created connection pool for the configured database.
 * The pool is the server's one point of contact with Postgres — introspection
 * and every data route (Phase C+) borrow connections from here.
 */
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  if (!config.databaseUrl) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      // Fail fast instead of hanging when Postgres is unreachable.
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

export type DbHealth = 'connected' | 'unreachable' | 'unconfigured';

/** Cheap reachability probe used by the health route. Never throws. */
export async function pingDb(): Promise<DbHealth> {
  const p = getPool();
  if (!p) return 'unconfigured';
  try {
    await p.query('SELECT 1');
    return 'connected';
  } catch {
    return 'unreachable';
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
