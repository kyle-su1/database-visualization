/**
 * Server-backed DataSource entry point. Mirrors the sqljs folder so App can
 * pick an implementation by folder: `../datasource/sqljs` vs `../datasource/http`.
 */
export { HttpDataSource, createHttpDataSource, type HttpOptions } from './HttpDataSource';
