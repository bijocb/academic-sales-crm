# Phase 1 + 2 plan — Engineering foundation, identity & multi-tenant access

Approved by owner: 2026-11-27. Scope is SRS §12 Phase 1 and Phase 2 only.

## Phase 1 — Engineering foundation

| Item           | Detail                                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo       | pnpm workspaces: `apps/api` (NestJS 11), `apps/web` (Next.js 15), `packages/contracts` (zod schemas, permission catalog, shared enums)                          |
| Database       | Prisma 6 schema + migrations live in `apps/api/prisma` (only the API touches the DB — deviation from SRS Appendix A, recorded in ARCHITECTURE)                  |
| Quality        | ESLint 9 (flat), Prettier, `tsc --noEmit`, Jest (+SWC) unit & integration, Playwright e2e smoke                                                                 |
| Runtime basics | Env validation (zod), pino structured logs with correlation ID, consistent error format, `/api/v1/health` (DB + Redis), OpenAPI at `/api/docs` (non-production) |
| Clock          | Injectable `Clock` (system + fixed test clock); lint rule bans `Date.now()` / `new Date()` in domain code                                                       |
| Local infra    | `infra/docker/docker-compose.yml`: Postgres 16, Redis 7, Mailpit                                                                                                |
| CI             | GitHub Actions: install → migrate → lint → typecheck → test → build → e2e                                                                                       |
| Docs           | README setup, CLAUDE.md commands, `.env.example` (no secrets)                                                                                                   |

## Phase 2 — Database & identity foundation

### Tables (migration `0001_identity`)

`organizations`, `brands`, `branches`, `users`, `roles`, `role_permissions`, `role_assignments` (scope ORGANIZATION/BRAND/BRANCH/TEAM, revoke instead of delete), `teams`, `team_members` (leave instead of delete), `sessions` (refresh-token rotation), `auth_tokens` (invite / password reset, hashed, single-use), `audit_logs` (append-only, DB trigger blocks UPDATE/DELETE).

### Isolation (A-008)

- App connects as non-superuser role `crm_app`; migrations run as owner.
- Row-level security on every tenant table: rows visible only when `organization_id = current_setting('app.org_id')` (or system bypass for login and platform-admin operations).
- All services use `Db.tenant(orgId, tx => …)` / `Db.system(tx => …)`; no direct client use.
- Brand/branch/team scope enforced in the service layer; out-of-scope IDs return 404.

### Authentication

Argon2id hashing · email + password login · lockout after repeated failures · 15-min access JWT + 30-day rotating refresh token (httpOnly cookies, reuse detection revokes the family) · Bearer header accepted for API clients · logout / logout-all · invite & password-reset via emailed single-use token · change password · session check on every request (immediate revocation/deactivation) · MFA-ready fields (not enabled) · CSRF header required on cookie-authenticated writes.

### Authorization

- Permission catalog in `packages/contracts` (Phase 2 + declared future permissions).
- 10 system role templates seeded per organization from SRS §2 (Org Admin … Management Viewer); custom roles allowed.
- Effective permission = role permission AND scope covering the target.
- Anti-escalation: a user can only grant a role whose every permission they hold at the target scope.

### API (all under `/api/v1`)

- auth: login, refresh, logout, logout-all, me, password/forgot, password/reset, password/change
- platform (platform admin): organizations list/create (creates org + system roles + first Org Admin invite)/suspend
- organization: current get/patch
- brands, branches, teams (+ members), users (+ status changes, role assignments), roles, permissions catalog, audit-logs

### Web

Login, forgot/reset password, app shell with navigation by permission, Brands, Branches, Teams, Users (invite, assign role), Roles (read), Platform organizations.

### Tests (exit gate: cross-brand isolation and role tests pass)

- Unit: permission/scope evaluation, anti-escalation, token rotation, lockout, clock.
- Integration (real Postgres): RLS blocks cross-org reads even with a raw unfiltered query; org B user gets 404 for org A IDs; brand-scoped user cannot read/modify another brand's brand/branch/team/users by ID; role-grant escalation rejected; refresh reuse revokes family; deactivated user's session stops working; audit rows cannot be updated/deleted.
- E2E: login → see brands list.

### New assumptions (added to DECISIONS)

- A-013 email is globally unique (one login per person across the platform).
- A-014 platform Super Admin manages organizations but does not read organization business data.
- A-015 password minimum 10 characters; lockout 5 failures / 15 minutes (configurable).
