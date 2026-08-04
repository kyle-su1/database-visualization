/**
 * Browser entry point for the sql.js DataSource. Kept separate from the
 * class so node-based tests can construct SqlJsDataSource without the
 * Vite `?url` wasm import.
 */
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { DataSource } from '@dbviz/shared';
import { SqlJsDataSource } from './SqlJsDataSource';

export async function createSqlJsDataSource(
  data: Uint8Array,
  name: string,
): Promise<DataSource> {
  return SqlJsDataSource.create(data, { locateFile: () => wasmUrl, name });
}
