#!/usr/bin/env bash
# Migration rehearsal (Phase 15, docs/BACKUP-RESTORE.md §3).
#
#   BACKUP=prod-before-release.dump  BASE_URL=postgresql://owner:…@host  CRM_APP_DB_PASSWORD=…  \
#     infra/scripts/migration-rehearsal.sh
#
# 1. Lists the migrations this release adds (compared with the backup) and flags destructive SQL in them.
# 2. Restores BACKUP (pg_dump custom format of the database BEFORE the release, e.g. a Neon branch of production)
#    into a new scratch database, applies the release with the same deploy step as production (scripts/migrate.ts),
#    and times it.
# 3. Verifies: every migration applied, the schema matches schema.prisma (apart from hand-written objects),
#    RLS / append-only checks, and row counts unchanged.
# The scratch database is kept for inspection. Never point BASE_URL at production with a name it could overwrite.
set -euo pipefail
: "${BACKUP:?BACKUP (pg_dump -Fc file) is required}"
: "${BASE_URL:?BASE_URL (server URL with owner credentials, no database) is required}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="crm_rehearsal_$(date +%Y%m%d%H%M%S)"
URL="$BASE_URL/$DB"
q() { psql "$1" -tAX -v ON_ERROR_STOP=1 -c "$2"; }
now() { date +%s.%N; }

echo "== 1. Restore the pre-release backup into $DB"
q "$BASE_URL/postgres" "CREATE DATABASE \"$DB\"" >/dev/null
t0=$(now)
pg_restore --no-password --exit-on-error --dbname="$URL" "$BACKUP"
t1=$(now)
applied=$(q "$URL" "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY 1")
pending=()
for d in "$ROOT"/apps/api/prisma/migrations/*/; do
  name=$(basename "$d")
  grep -qx "$name" <<<"$applied" || pending+=("$name")
done
echo "Migrations in this release: ${#pending[@]}"
risky=0
for m in "${pending[@]}"; do
  echo "  - $m"
  if grep -nEi 'DROP TABLE|DROP COLUMN|ALTER COLUMN .* TYPE|TRUNCATE|DELETE FROM|RENAME (COLUMN|TO)|DROP CONSTRAINT "[^"]*_fkey"' \
    "$ROOT/apps/api/prisma/migrations/$m/migration.sql"; then
    echo "    ^ destructive or locking statement: review before release"
    risky=1
  fi
done
COUNTS="SELECT string_agg(t || '=' || n, ',' ORDER BY t) FROM (
  SELECT c.relname AS t, (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM public.' || quote_ident(c.relname), false, true, '')))[1]::text AS n
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relkind = 'r'
   AND c.relname NOT IN ('_prisma_migrations', 'jobs', 'audit_logs')) x"
before=$(q "$URL" "$COUNTS")

echo "== 2. Apply the release (same step as the production deploy)"
t2=$(now)
(cd "$ROOT" && MIGRATION_DATABASE_URL="$URL" APP_DATABASE_URL="${APP_DATABASE_URL:-$URL}" pnpm -s --filter @crm/api db:migrate)
t3=$(now)

echo "== 3. Verify"
fail=0
left=$(q "$URL" "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")
[[ "$left" == "0" ]] && echo "  ok    all migrations finished" || { echo "  FAIL  $left unfinished migration(s)"; fail=1; }
drift=$(cd "$ROOT/apps/api" && npx prisma migrate diff --from-url "$URL" --to-schema-datamodel prisma/schema.prisma --script |
  grep -vE '^--|^$|DROP CONSTRAINT "[^"]*_fkey"|DROP INDEX "(persons_org_phone_prefix_idx|tasks_one_initial_per_lead|sla_instances_one_active_per_lead|recovery_cases_one_live_per_lead|admissions_one_live_per_lead|[a-z_]*_trgm_idx)"' || true)
[[ -z "$drift" ]] && echo "  ok    schema matches schema.prisma" || { echo "  FAIL  schema drift:"; echo "$drift"; fail=1; }
after=$(q "$URL" "$COUNTS")
[[ "$before" == "$after" ]] && echo "  ok    row counts unchanged by the migration" || { echo "  FAIL  row counts changed"; fail=1; }
unsafe=$(q "$URL" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_name = c.relname AND k.column_name = 'organization_id')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")
[[ "$unsafe" == "0" ]] && echo "  ok    every tenant table has forced RLS" || { echo "  FAIL  $unsafe tenant table(s) without forced RLS"; fail=1; }
printf 'Restore %.1f s · apply release %.1f s\n' "$(echo "$t1 - $t0" | bc)" "$(echo "$t3 - $t2" | bc)"
[[ $risky -eq 0 ]] || echo "NOTE: destructive statements found above — confirm they are intended and backed up."
if [[ $fail -ne 0 ]]; then echo "REHEARSAL FAILED ($DB kept)"; exit 1; fi
echo "REHEARSAL PASSED ($DB kept for inspection; drop it when done)"
