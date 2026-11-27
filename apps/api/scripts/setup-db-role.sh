#!/usr/bin/env bash
# Local/CI only: give the crm_app role a login password from CRM_APP_DB_PASSWORD.
# Production: provision the role's password through your secret manager instead.
set -euo pipefail
if [ -z "${MIGRATION_DATABASE_URL:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required}"
: "${CRM_APP_DB_PASSWORD:?CRM_APP_DB_PASSWORD is required}"
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -v pw="$CRM_APP_DB_PASSWORD" <<'SQL'
SELECT format('ALTER ROLE crm_app LOGIN PASSWORD %L', :'pw') \gexec
SQL
echo "crm_app login enabled"
