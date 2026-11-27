# Deployment

## Current demo hosting (Vercel + Neon)

| Part | Where | Notes |
|---|---|---|
| Web (`apps/web`) | Vercel project `academic-sales-crm-web` → https://academic-sales-crm-web.vercel.app | Proxies `/api/v1/*` to the API (`API_INTERNAL_URL`) so auth cookies stay first-party |
| API (`apps/api`) | Vercel project `academic-sales-crm-api` (Node 22, region `sin1`) | Nest app as one Vercel function (`apps/api/api/index.js`) |
| Database | Neon Postgres (free), connected to the API project | Owner credentials injected as `DATABASE_URL` / `DATABASE_URL_UNPOOLED`; the app derives its `crm_app` login from them (`src/db-env.ts`) |
| Redis | not configured | Not needed until background jobs (Phase 6/7) |

Every push to `main` deploys both projects. The API build runs migrations, enables the `crm_app`
role, creates the platform admin (`SEED_PLATFORM_ADMIN_*`) and — because `ALLOW_DEMO_SEED=true`
— the labelled `[DEMO]` organization. Secrets live only in Vercel project settings.

**Demo-only settings to remove before real use:** `ALLOW_DEMO_SEED`, `ALLOW_LOG_MAILER`
(emails are written to Vercel runtime logs instead of being sent; configure `SMTP_URL`).

## Limitations of this setup

- Vercel functions run per request; the SLA timers and workers of Phase 7 need an always-on
  process (Railway / container host) with Redis. Plan to move the API there in Phase 7.
- Login rate limiting is per function instance (in memory) until Redis is added.

## Container alternative

`infra/docker/api.Dockerfile` builds the API for any container host (Railway, Fly, ECS…);
its entrypoint runs `scripts/migrate.ts --seed` and then starts the server.
