# Academic Course Sales CRM

Multi-organization, multi-brand education sales and admission CRM for India and the UAE.

Status: **Phases 1–2 complete** (engineering foundation; organizations, brands, users, roles and access control).
Specification and decisions: [`docs/`](docs/) — start with `SRS.md`, `DECISIONS.md`, `ARCHITECTURE.md`.

## Stack

NestJS 11 · Prisma 6 · PostgreSQL 16 (row-level security per organization) · Redis 7 · Next.js 15 · Tailwind 4 · pnpm workspaces · Jest · Playwright.

## Local setup

Requirements: Node 22, pnpm 10 (`corepack enable`), Docker.

1. Start Postgres, Redis and Mailpit:

   ```bash
   docker compose -f infra/docker/docker-compose.yml up -d
   ```

2. Create your environment file and fill in `JWT_ACCESS_SECRET` (`openssl rand -base64 48`) and the seed admin:

   ```bash
   cp .env.example .env
   ```

3. Install, migrate and seed:

   ```bash
   pnpm install
   pnpm db:migrate
   pnpm db:seed
   ```

   Optional development data (clearly labelled `[DEMO]`, never in production):

   ```bash
   pnpm db:seed:demo
   ```

4. Run the API (http://localhost:4000, docs at `/api/docs`) and the web app (http://localhost:3000) in two terminals:

   ```bash
   pnpm dev:api
   ```

   ```bash
   pnpm dev:web
   ```

Invitation and password-reset emails appear in Mailpit at http://localhost:8025.

## Checks

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

End-to-end (needs the demo seed and a build):

```bash
pnpm test:e2e
```

## Security model in one paragraph

Each organization is a tenant. The API connects as a non-superuser database role, and PostgreSQL row-level
security only exposes the current organization's rows, so a missing filter in code cannot leak another
tenant's data. Inside an organization, every permission is granted at a scope (organization, brand, branch
or team); records outside a user's scope return 404. Users can only grant roles they themselves hold at
that scope. The audit log is append-only at the database level.
