# Demo: live Postgres backend

Stands up a Postgres seeded with the [Pagila](https://github.com/devrimgunduz/pagila)
sample database (a DVD-rental store) so the app's **Connect to Postgres** button
works end-to-end. The bundled local file is Chinook (a music store), so
connecting to Postgres visibly switches you to a completely different dataset.

## Run it

```bash
# 1. Start a seeded Pagila Postgres (downloads Pagila once, then boots + waits)
./demo/up.sh

# 2. Start the backend (reads packages/backend/.env → the compose DB)
npm run dev:backend        # http://localhost:5174

# 3. Start the frontend
npm run dev                # http://localhost:5173
```

Then open http://localhost:5173 and click **Connect to Postgres**. The graph
reseeds from the live database; the SQL-log panel shows the real Postgres
queries each expansion runs.

## Verify without the browser

```bash
curl localhost:5174/api/health                       # {"status":"ok","db":"connected"}
curl 'localhost:5174/api/schema' | jq '.schema.tables | length'   # 16
curl 'localhost:5174/api/rows?table=film&limit=2' | jq
```

## Notes

- **Image**: `pgvector/pgvector:pg18`. Pagila's current schema requires Postgres
  18 (`uuidv7()`) and the `vector` extension, and its dump sets object ownership
  to the `postgres` role — so the superuser is `postgres`, not a custom role.
- Postgres is published on host port **5433** (not 5432) to avoid clashing with
  a native Postgres install; `packages/backend/.env` already points there.
- The seed scripts in `seed/` run **once**, on first init of an empty data
  volume. To re-seed: `docker compose -f demo/docker-compose.yml down -v` then
  `./demo/up.sh` again.
- Good things to expand in a walkthrough: `film → film_actor → actor` (a
  many-to-many via the `film_actor` junction), `film ↔ category` via
  `film_category`, and the sales side `customer → rental → payment`. `payment`
  is a partitioned table; the introspector shows it as one table, not its
  monthly partitions.
- Stop everything: `docker compose -f demo/docker-compose.yml down` (add `-v`
  to also drop the data).
