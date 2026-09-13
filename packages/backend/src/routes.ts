import type { FastifyInstance } from 'fastify';
import type { PkValue } from '@dbviz/shared';
import { config } from './config.ts';
import { httpError } from './errors.ts';
import type { PgDataSource } from './data.ts';

/** Resolves the data source per request (null when no DB is configured). */
export type GetData = () => Promise<PgDataSource | null>;

/**
 * The read endpoints mirror the DataSource interface 1:1 — the API
 * IS the contract. Fastify validates and type-coerces every querystring param
 * against the JSON schemas below BEFORE the handler runs, so `limit` arrives as
 * a bounded integer and required params are guaranteed present; the handler
 * then does identity-level validation (table/column/fk) inside PgDataSource.
 */
export function registerDataRoutes(app: FastifyInstance, getData: GetData): void {
  const need = async (): Promise<PgDataSource> => {
    const d = await getData();
    if (!d) throw httpError(503, 'No database configured. Set DATABASE_URL and restart.');
    return d;
  };

  app.get('/api/schema', async () => {
    return { schema: (await need()).getSchema() };
  });

  app.get(
    '/api/rows',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['table'],
          additionalProperties: false,
          properties: {
            table: { type: 'string', minLength: 1 },
            limit: { type: 'integer', minimum: 1, maximum: config.rowLimit, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
            search: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const { table, limit, offset, search } = req.query as {
        table: string;
        limit: number;
        offset: number;
        search?: string;
      };
      return (await need()).getRows(table, { limit, offset, searchText: search });
    },
  );

  app.get(
    '/api/row',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['table', 'pk'],
          additionalProperties: false,
          properties: {
            table: { type: 'string', minLength: 1 },
            pk: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const { table, pk } = req.query as { table: string; pk: string };
      return (await need()).getRow(table, parseJsonObject(pk, 'pk'));
    },
  );

  app.post(
    '/api/rows/batch',
    {
      schema: {
        body: {
          type: 'object',
          required: ['table', 'keys'],
          additionalProperties: false,
          properties: {
            table: { type: 'string', minLength: 1 },
            keys: {
              type: 'array',
              maxItems: config.rowLimit,
              items: { type: 'object', minProperties: 1 },
            },
          },
        },
      },
    },
    async (req) => {
      const { table, keys } = req.body as { table: string; keys: PkValue[] };
      return (await need()).getRowsByKeys(table, keys);
    },
  );

  app.get(
    '/api/referencing',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['childTable', 'fkId', 'refValues'],
          additionalProperties: false,
          properties: {
            childTable: { type: 'string', minLength: 1 },
            fkId: { type: 'integer' },
            refValues: { type: 'string' },
            // limit: 0 is a count-only query (the "+N more" pill).
            limit: { type: 'integer', minimum: 0, maximum: config.rowLimit, default: 25 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req) => {
      const { childTable, fkId, refValues, limit, offset } = req.query as {
        childTable: string;
        fkId: number;
        refValues: string;
        limit: number;
        offset: number;
      };
      return (await need()).getReferencingRows(
        childTable,
        fkId,
        parseJsonObject(refValues, 'refValues'),
        { limit, offset },
      );
    },
  );
}

/** Parse a JSON-object querystring param (pk / refValues), 400 on anything else. */
function parseJsonObject(raw: string, field: string): PkValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw httpError(400, `Invalid ${field}: not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw httpError(400, `Invalid ${field}: expected a JSON object`);
  }
  return parsed as PkValue;
}
