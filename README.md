# database-visualization

A schema-adaptive relational data explorer. Load any database and it renders
**rows as nodes and foreign keys as edges**; you seed a row and expand outward
hop-by-hop, following relationships. It introspects the schema at load time, so
it works on any database with no hardcoded model.

Two interchangeable data sources sit behind one `DataSource` interface:

- **Local file** — a SQLite file runs entirely in the browser via sql.js (WASM).
- **Live Postgres** — a Fastify + `pg` server introspects a real database and
  streams only the rows each expansion needs.

Nothing above the `DataSource` boundary knows which one it's talking to.

## Monorepo

```
packages/
  frontend/   @dbviz/frontend  React + Vite app (SVG + d3-force)
  backend/    @dbviz/backend   Fastify + pg server
  shared/     @dbviz/shared    the DataSource contract both sides import
demo/         docker-compose Postgres seeded with Pagila
```

## Run — local SQLite (no setup)

```bash
npm install
npm run dev            # http://localhost:5173 — auto-loads bundled Chinook.sqlite
```

Open any other `.sqlite` file with the header button or drag-and-drop.

## Run — live Postgres

```bash
./demo/up.sh           # seeded Pagila Postgres in Docker (see demo/README.md)
npm run dev:backend    # http://localhost:5174  (reads packages/backend/.env)
npm run dev            # http://localhost:5173
```

Then click **Connect to Postgres**. The graph reseeds from the live database
and the SQL-log panel shows the real queries each expansion runs.

## Scripts

| Command | What |
| --- | --- |
| `npm run dev` / `npm run build` | frontend dev server / production build |
| `npm test` | frontend tests (vitest) |
| `npm run lint` | frontend lint (enforces the sql.js boundary) |
| `npm run dev:backend` | backend dev server (Node native TS, no transpiler) |
| `npm run test:backend` | backend tests (PGlite + node:test) |
| `npm run typecheck:backend` | backend typecheck |

## Design notes

- **The `DataSource` boundary** (`@dbviz/shared`) is the spine: async,
  parameterized, one method ≈ one endpoint. `SqlJsDataSource` and
  `HttpDataSource` implement it; the graph engine, schema model, and rendering
  depend only on it. ESLint forbids importing sql.js outside its folder.
- **Backend safety**: values are always parameterized; identifiers are quoted
  *and* validated against the introspected schema. Fastify JSON-schema
  validation bounds every querystring param before a handler runs.
- **Backend runtime**: Node's native TypeScript type-stripping — no transpiler.
  This requires erasable syntax only (no constructor parameter properties,
  enums, or namespaces) and explicit `.ts` import extensions.
