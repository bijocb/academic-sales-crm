# Backup, restore and migration rehearsal — Phase 15

Targets (ASSUMED until the owner agrees them, A-046): **RPO ≤ 24 hours** (at most one day of data lost), **RTO ≤ 4 hours**
(service back within four hours), backups encrypted at rest, and a restore drill before go-live and every quarter.

## 1. Backups

| Layer                      | What                                                                                                                                                              | Who                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neon point-in-time restore | Neon keeps the database's change history for the plan's **history retention window** and can branch or restore to any moment in it. Storage is encrypted at rest. | Automatic. **Owner: confirm the plan's retention window covers the RPO.** Free plans keep only a short window, so use a paid plan for production. |
| Logical backup (`pg_dump`) | Full, portable copy for long-term retention and for restoring outside Neon. `infra/scripts/restore-drill.sh` takes and verifies one.                              | Recommended: a weekly dump kept in encrypted storage under the owner's account (O-11 decides how long).                                           |
| Code and configuration     | Git (GitHub), Vercel project settings, environment variables (not in Git).                                                                                        | Keep a private record of every production variable name and where its value lives.                                                                |

Append-only history (payments, refunds, audit) is not a backup: it protects against changes through the application,
not against loss of the database.

## 2. Restore procedures

**A. Recover from a bad change or data loss (point in time), using Neon:**

1. In Neon, create a branch of production at a time just before the incident (Branches → Create branch → point in time).
2. Verify the branch with the drill script (read-only on the source):
   `SOURCE_URL=<branch owner URL> TARGET_DB=crm_restore_check infra/scripts/restore-drill.sh` (or compare row counts manually).
3. Either point the API's `DATABASE_URL` / `DATABASE_URL_UNPOOLED` at the branch and redeploy, or use Neon's "restore"
   to reset production to that point (Neon keeps a backup branch of the state it replaced).
4. Run the API health check and the UAT smoke cases (`docs/UAT.md` §0). Record the incident and the data window lost.

**B. Restore a logical backup into a new database:**
`pg_restore --dbname=<new database URL> backup.dump`, then `pnpm db:migrate` (applies any newer migrations, enables
`crm_app`), then switch the API's database variables and redeploy. `restore-drill.sh` does the restore and checks in one go.

## 3. Drill results (2026-11-28, local rehearsal on the 21,000-lead load database)

`infra/scripts/restore-drill.sh` — backup 1.3 s, restore 2.2 s, verification 0.7 s, dump 11 MB:

- ok — row counts of every table identical
- ok — migration history identical
- ok — forced RLS and `tenant_isolation` on every tenant table
- ok — all triggers present (append-only history)
- ok — `crm_app` grants identical
- ok — the app role reads exactly its organization's 21,506 leads through RLS, and an unknown organization reads none

`infra/scripts/migration-rehearsal.sh` — restored a pre-release copy (the production schema plus 21,000 leads), then
applied this release through the production deploy step: restore 2.1 s, apply 4.4 s. All migrations finished, the
schema matches `schema.prisma` (apart from the documented hand-written objects), row counts were unchanged, and every
tenant table still has forced RLS. New migration: `20261128080000_search_indexes` (index-only, no destructive statements).

**Still to do on production (owner):** run drill A once against a Neon branch of production and record the time taken.
This verifies the real backups and the real RTO.

## 4. Migration rules for every release

- Migrations are forward-only and additive by default: add columns or tables, back-fill, and remove old ones only in a
  later release ("expand / contract"). The rehearsal script flags `DROP`, `TRUNCATE`, `DELETE`, type changes and renames.
- Before a release with migrations: take a Neon branch (or `pg_dump`) of production, run `migration-rehearsal.sh` on
  it, and keep the branch until the release is accepted.
- Index creation locks writes on that table while it builds. That takes seconds at current sizes. On large tables,
  build the index `CONCURRENTLY` in its own migration.
