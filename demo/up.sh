#!/usr/bin/env bash
# Fetch Pagila if missing, start Postgres, and wait until it is healthy.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
[ -f "$here/seed/01-pagila-schema.sql" ] || "$here/fetch-pagila.sh"

docker compose -f "$here/docker-compose.yml" up -d

echo "waiting for Postgres to become healthy …"
until [ "$(docker inspect -f '{{.State.Health.Status}}' dbviz-postgres 2>/dev/null)" = "healthy" ]; do
  sleep 2
done

echo "✓ Postgres ready — postgres://postgres:postgres@localhost:5433/pagila"
echo "  now run:  npm run dev:backend   and   npm run dev"
