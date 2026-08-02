/**
 * @dbviz/shared — the cross-package contract.
 *
 * The DataSource interface and its DTO types are the single source of truth
 * shared by every implementation: the browser-side SqlJsDataSource, the
 * upcoming HttpDataSource client, and the server that backs it. Keeping the
 * contract in its own package is what lets the server satisfy the exact same
 * types the UI already depends on.
 */
export * from './types';
