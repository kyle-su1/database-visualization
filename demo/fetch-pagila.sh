#!/usr/bin/env bash
# Download the Pagila sample database (schema + data) into seed/ so the Postgres
# container loads it on first startup. Run once before `up`; the files are
# git-ignored (~13MB of data). Loaded in filename order: 01 schema, 02 data.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
base="https://raw.githubusercontent.com/devrimgunduz/pagila/master"

echo "→ downloading Pagila schema + data …"
curl -fSL "$base/pagila-schema.sql" -o "$here/seed/01-pagila-schema.sql"
curl -fSL "$base/pagila-data.sql" -o "$here/seed/02-pagila-data.sql"

echo "✓ wrote seed/01-pagila-schema.sql + seed/02-pagila-data.sql"
echo "  next: ./demo/up.sh   (or: docker compose -f demo/docker-compose.yml up -d)"
