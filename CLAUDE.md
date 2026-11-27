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

## Commands
(to be filled in Phase 1)
