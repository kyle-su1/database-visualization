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
| `npm run benchmark:batch` | compare row-by-row and batched Postgres key lookups |
| `npm run benchmark:graph` | measure browser-to-SVG graph expansion latency |
| `npm run typecheck:benchmarks` | benchmark harness typecheck |

## Batch benchmark

The backend benchmark creates a uniquely named 500-row table in the configured
PostgreSQL database, compares the old eight-way-concurrent lookup path with one
batched SQL query, validates that both return identical ordered results, and
drops the table when it finishes.

```bash
DATABASE_URL=postgres://... npm run benchmark:batch
```

It reports query counts plus median and p95 latency for 25, 100, and 500 keys.
Use `BENCH_RUNS`, `BENCH_WARMUPS`, or a comma-separated `BENCH_SIZES` to change
the workload. Record the PostgreSQL version and CPU printed by the script when
using results outside the repository.

Reference run on 2026-09-13 using PostgreSQL 18.4 on an Apple M4, with 20
measured runs after three warmups:

| Keys | Row-by-row queries | Batch queries | Row-by-row p95 | Batch p95 | Speedup |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 25 | 25 | 1 | 1.38 ms | 0.34 ms | 4.10x |
| 100 | 100 | 1 | 3.97 ms | 0.49 ms | 8.09x |
| 500 | 500 | 1 | 20.58 ms | 3.59 ms | 5.73x |

The app's default many-to-many expansion fetches 25 junction partners. Its SQL
cost is now three statements—count, junction page, and batched partner lookup—
instead of 27 statements with individual partner lookups.

## End-to-end graph benchmark

The graph benchmark builds the production frontend, creates an isolated
five-table PostgreSQL schema, starts Fastify and the Vite preview server on
random local ports, and drives the real UI in headless Chromium. Each run grows
the graph through four deterministic stages and validates every resulting node
and edge before the sample is accepted. The schema and servers are removed when
the run finishes.

```bash
npx playwright install chromium  # once per machine
DATABASE_URL=postgres://... npm run benchmark:graph
```

Latency begins at the DOM click and ends two animation frames after the SVG
commit. It includes the browser, HTTP API, SQL queries, graph-state update, and
React render; it does not wait for the force simulation to settle. Staggered
node reveal is disabled. The benchmark also samples animation frames and
reports the p95 of the longest frame interval in each expansion. Use
`GRAPH_BENCH_RUNS` and `GRAPH_BENCH_WARMUPS` to change the default 20 measured
runs and two warmups.

Reference run on 2026-09-13 using the production build, Chromium 153,
PostgreSQL 18.4, and an Apple M4:

| Graph growth | Nodes added | Total edges | SQL queries | p50 | p95 | p95 max frame gap |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 → 25 nodes | 24 | 24 | 2 | 30.4 ms | 31.0 ms | 16.7 ms |
| 25 → 97 nodes | 72 | 96 | 48 | 66.0 ms | 66.8 ms | 16.8 ms |
| 97 → 457 nodes | 360 | 456 | 144 | 151.3 ms | 167.7 ms | 16.8 ms |
| 457 → 1,177 nodes | 720 | 1,176 | 720 | 874.1 ms | 909.4 ms | 16.8 ms |

This is a baseline rather than an optimized claim. The query counts show that
large incoming expansions are currently bounded by row-by-row reverse
relationship requests, giving the next optimization a reproducible target.

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
