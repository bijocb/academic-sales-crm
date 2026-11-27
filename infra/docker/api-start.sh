#!/usr/bin/env bash
# Container entrypoint: migrate, enable app role, optional seeds, then start the API.
set -euo pipefail
cd /app/apps/api
npx tsx scripts/migrate.ts --seed
exec node --enable-source-maps dist/main.js
