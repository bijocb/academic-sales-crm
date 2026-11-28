#!/usr/bin/env bash
# Backup / restore drill (Phase 15, docs/BACKUP-RESTORE.md).
#
#   SOURCE_URL=postgresql://owner:…@host/db  TARGET_DB=crm_restore_drill  infra/scripts/restore-drill.sh
#
# Takes a full logical backup of SOURCE_URL (pg_dump custom format), restores it into a NEW database TARGET_DB on the
# same server, then verifies it: row counts of every table match, the migration history matches, forced RLS and the
# tenant_isolation policy are present on every tenant table, append-only triggers are present, and the app role can
# read through RLS. Prints the timings (backup, restore, verify) as RTO evidence. Never writes to SOURCE_URL.
# TARGET_DB must not exist and must contain "restore" (guard against restoring over a real database).
set -euo pipefail

: "${SOURCE_URL:?SOURCE_URL is required}"
: "${TARGET_DB:?TARGET_DB is required}"
[[ "$TARGET_DB" == *restore* ]] || { echo "TARGET_DB must contain 'restore'" >&2; exit 2; }

BASE="${SOURCE_URL%/*}"
TARGET_URL="$BASE/$TARGET_DB"
DUMP="$(mktemp -d)/backup.dump"
now() { date +%s.%N; }
q() { psql "$1" -tAX -v ON_ERROR_STOP=1 -c "$2"; }

if [[ "$(q "$BASE/postgres" "SELECT count(*) FROM pg_database WHERE datname = '$TARGET_DB'")" != "0" ]]; then
  echo "Database $TARGET_DB already exists; choose a new name" >&2
  exit 2
fi

t0=$(now)
pg_dump --format=custom --no-password --file="$DUMP" "$SOURCE_URL"
t1=$(now)
q "$BASE/postgres" "CREATE DATABASE \"$TARGET_DB\"" >/dev/null
pg_restore --no-password --exit-on-error --dbname="$TARGET_URL" "$DUMP"
t2=$(now)

fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  ok    $1"; else echo "  FAIL  $1 (source: $2, restored: $3)"; fail=1; fi; }

echo "Verifying $TARGET_DB against the source"
COUNTS="SELECT string_agg(t || '=' || n, ',' ORDER BY t) FROM (
  SELECT c.relname AS t, (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM public.' || quote_ident(c.relname), false, true, '')))[1]::text AS n
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relkind = 'r') x"
check "row counts of every table" "$(q "$SOURCE_URL" "$COUNTS" | md5sum)" "$(q "$TARGET_URL" "$COUNTS" | md5sum)"
MIG="SELECT count(*) || ':' || max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL"
check "migration history" "$(q "$SOURCE_URL" "$MIG")" "$(q "$TARGET_URL" "$MIG")"
RLS="SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
    AND EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation')"
check "tables with forced RLS + tenant_isolation" "$(q "$SOURCE_URL" "$RLS")" "$(q "$TARGET_URL" "$RLS")"
TRG="SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal"
check "triggers (append-only history)" "$(q "$SOURCE_URL" "$TRG")" "$(q "$TARGET_URL" "$TRG")"
GRANTS="SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'crm_app'"
check "crm_app grants" "$(q "$SOURCE_URL" "$GRANTS")" "$(q "$TARGET_URL" "$GRANTS")"
ORG=$(q "$TARGET_URL" "SELECT organization_id FROM leads GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")
if [[ -n "$ORG" ]]; then
  # As the app role, through RLS: the busiest organization sees exactly its leads, and an unknown one sees none.
  SRC_LEADS=$(q "$TARGET_URL" "SELECT count(*) FROM leads WHERE organization_id = '$ORG'")
  APP=$(q "$TARGET_URL" "SET ROLE crm_app; SELECT set_config('app.org_id', '$ORG', false); SELECT count(*) FROM leads;" | tail -1)
  check "app role reads its organization's $SRC_LEADS leads through RLS" "$SRC_LEADS" "$APP"
  OTHER=$(q "$TARGET_URL" "SET ROLE crm_app; SELECT set_config('app.org_id', gen_random_uuid()::text, false); SELECT count(*) FROM leads;" | tail -1)
  check "another organization sees none of them" "0" "$OTHER"
fi
t3=$(now)
printf 'Backup %.1f s · restore %.1f s · verify %.1f s · dump size %s\n' \
  "$(echo "$t1 - $t0" | bc)" "$(echo "$t2 - $t1" | bc)" "$(echo "$t3 - $t2" | bc)" "$(du -h "$DUMP" | cut -f1)"
rm -f "$DUMP"
if [[ $fail -ne 0 ]]; then echo "RESTORE DRILL FAILED"; exit 1; fi
echo "RESTORE DRILL PASSED ($TARGET_DB kept for inspection; drop it when done)"
