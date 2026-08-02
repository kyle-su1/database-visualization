import 'dotenv/config';

/**
 * Server configuration, resolved once from the environment at startup.
 * Everything is optional with a sane default EXCEPT DATABASE_URL: the server
 * boots without it (health reports db: "unconfigured") so the skeleton is
 * verifiable before a real Postgres exists, but every data route requires it.
 */
export interface ServerConfig {
  host: string;
  port: number;
  /** Postgres connection string, or undefined when unconfigured. */
  databaseUrl: string | undefined;
  /** Schema to introspect and query (Phase C+). */
  schema: string;
  /** Hard cap on rows any single query may return. */
  rowLimit: number;
  /** Browser origin allowed via CORS (the Vite dev server). */
  corsOrigin: string;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${name}: expected a non-negative integer, got "${raw}"`);
  }
  return n;
}

export const config: ServerConfig = {
  host: process.env.HOST ?? '127.0.0.1',
  port: int('PORT', 5174),
  databaseUrl: process.env.DATABASE_URL || undefined,
  schema: process.env.PG_SCHEMA ?? 'public',
  rowLimit: int('ROW_LIMIT', 500),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
};
