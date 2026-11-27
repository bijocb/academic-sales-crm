#!/usr/bin/env bash
# Container entrypoint: migrate, enable app role, optional seeds, then start the API.
set -euo pipefail
cd /app/apps/api
npx prisma migrate deploy
bash scripts/setup-db-role.sh
if [ -n "${SEED_PLATFORM_ADMIN_EMAIL:-}" ]; then npx tsx prisma/seed.ts; fi
# Labelled demo data only when explicitly allowed (idempotent).
if [ "${ALLOW_DEMO_SEED:-}" = "true" ]; then npx tsx prisma/seed-demo.ts; fi
exec node --enable-source-maps dist/main.js
