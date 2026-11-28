# Deployment

Go-live checklist, production settings and rollback: `docs/RELEASE.md`. Operations: `docs/RUNBOOK.md`.
Backups: `docs/BACKUP-RESTORE.md`.

## Current demo hosting (Vercel + Neon)

| Part             | Where                                                                               | Notes                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Web (`apps/web`) | Vercel project `academic-sales-crm-web` → https://academic-sales-crm-web.vercel.app | Proxies `/api/v1/*` to the API (`API_INTERNAL_URL`) so auth cookies stay first-party                                                    |
| API (`apps/api`) | Vercel project `academic-sales-crm-api` (Node 22, region `sin1`)                    | Nest app as one Vercel function (`apps/api/api/index.js`)                                                                               |
| Database         | Neon Postgres (free), connected to the API project                                  | Owner credentials injected as `DATABASE_URL` / `DATABASE_URL_UNPOOLED`; the app derives its `crm_app` login from them (`src/db-env.ts`) |
| Redis            | not configured                                                                      | Not needed until background jobs (Phase 6/7)                                                                                            |

Every push to `main` deploys both projects. The API build runs migrations, enables the `crm_app`
role, creates the platform admin (`SEED_PLATFORM_ADMIN_*`) and — because `ALLOW_DEMO_SEED=true`
— the labelled `[DEMO]` organization. Secrets live only in Vercel project settings.

**Demo-only settings to remove before real use:** `ALLOW_DEMO_SEED`, `ALLOW_LOG_MAILER`
(emails are written to Vercel runtime logs instead of being sent; configure `SMTP_URL`).

## Limitations of this setup

- Vercel functions run per request, so background jobs (SLA checkpoints, task reminders, queue drain) run when
  `/api/v1/internal/tick` is called with `Authorization: Bearer $CRON_SECRET`:
  - `.github/workflows/tick.yml` calls it every 5 minutes. It needs the repository secret `CRON_SECRET`
    (GitHub → Settings → Secrets and variables → Actions) with the same value as `CRON_SECRET` on the Vercel API
    project. Without it the workflow skips. GitHub may start scheduled runs late.
  - `apps/api/vercel.json` adds a daily Vercel Cron as a backstop (Hobby plans allow one run per day; on Pro change
    the schedule to `* * * * *`).
  - On any long-lived host (`pnpm start`, Docker) the in-process worker runs every 15 s (`WORKER_MODE=interval`).
- WhatsApp and click-to-call show as "not configured" in production until a provider is chosen (O-06); sandbox
  adapters never run there. Calls are logged manually; email goes through the configured mailer.
- No payment gateway runs in production yet (O-09): Accounts users record verified payments manually; the sandbox
  gateway and its checkout pages exist only in development and tests.
- Rate limits are counted per function instance (in memory) until Redis is added (SECURITY-REVIEW S3).

## Container alternative

`infra/docker/api.Dockerfile` builds the API for any container host (Railway, Fly, ECS…);
its entrypoint runs `scripts/migrate.ts --seed` and then starts the server.
