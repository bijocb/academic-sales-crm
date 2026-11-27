# Academic Course Sales CRM — project rules

Multi-organization, multi-brand education sales & admission CRM (India + UAE).

Read first: `docs/SRS.md` (spec), `docs/DECISIONS.md` (overrides SRS where they differ), `docs/ARCHITECTURE.md`.

## Non-negotiable rules

1. Work only on the phase the owner has approved; stop at the phase boundary.
2. Plan before multi-file changes: files, migrations, APIs, risks, tests.
3. Do not invent business rules. Add OPEN items to `docs/DECISIONS.md` or propose configurable defaults marked ASSUMED.
4. Never update or delete history: lead_assignments, lead_stage_history, activities, payments, refunds, audit_logs are append-only.
5. Every query goes through the scoped data-access layer (organization + brand/team scope). Authorization is enforced in the backend, never only in the UI.
6. Schema changes only via Prisma migrations. Never alter production data directly.
7. Background jobs: idempotent (deterministic job IDs), retryable, observable, dead-lettered.
8. Use the injected `Clock`; never call `Date.now()` / `new Date()` in domain code.
9. Money = integer minor units + currency code. Timestamps stored in UTC.
10. No secrets in Git. Sandbox integrations must be clearly labelled and never enabled in production config.
11. Every business-critical workflow gets unit + integration tests; run lint, typecheck, tests and build after each phase and report exact results.
12. Keep docs current: DECISIONS, ARCHITECTURE, ERD, API, KPI dictionary.

## Layout

- `apps/api` — NestJS API (+ Prisma schema/migrations in `apps/api/prisma`). DB access only via `Db.tenant()` / `Db.system()`.
- `apps/web` — Next.js UI; calls the API through the `/api/v1` rewrite (same origin, cookie auth).
- `packages/contracts` — zod request schemas, permission catalog, role templates (shared by API and web).

## Commands (run from repo root)

- `pnpm install` — install
- `pnpm db:migrate` — apply migrations + enable `crm_app` login (needs `.env`)
- `pnpm db:seed` — create first platform admin from `SEED_PLATFORM_ADMIN_*`
- `pnpm db:seed:demo` — DEV ONLY demo organization (`*@demo.local`, password `DemoPass#2026`)
- `pnpm dev:api` / `pnpm dev:web` — run locally (API :4000, web :3000)
- `pnpm lint` · `pnpm format:check` · `pnpm typecheck` · `pnpm test` · `pnpm build` · `pnpm test:e2e`
- New migration (the shadow database cannot replay migration 1, so diff against the live dev DB):
  `cd apps/api && set -a && . ../../.env && set +a && mkdir -p prisma/migrations/<timestamp>_<name> && npx prisma migrate diff --from-url "$MIGRATION_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<timestamp>_<name>/migration.sql`
  then append CHECKs, `GRANT … TO crm_app` and the RLS `tenant_isolation` block for every new tenant table, and run `pnpm db:migrate`.
  **Check the diff for `DROP INDEX` of hand-written indexes** (`persons_org_phone_prefix_idx`, `tasks_one_initial_per_lead`, `sla_instances_one_active_per_lead`) and delete those lines.
- New brand-level configuration needs a default in `src/settings/brand-defaults.ts` (back-filled on every deploy).

## Local gotchas

- `ss` is not installed in the dev container: stop servers with `pkill -f dist/main.js; pkill -f next-server` before
  `pnpm test:e2e`, otherwise an old build keeps serving. Login rate limit is 10/min: wait 60 s between e2e runs.

## Conventions

- Every tenant table: `organization_id` column, RLS policy `tenant_isolation`, composite FKs `(organization_id, x_id)`.
- Out-of-scope IDs return 404, missing permission returns 403.
- Integration tests run serially against `crm_test` (wiped per suite).
