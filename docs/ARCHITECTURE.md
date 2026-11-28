# Architecture

Status: approved 2026-11-27. Phases 1–2 implemented.

Business source: `docs/SRS.md`. Decisions: `docs/DECISIONS.md`.

## 1. Tenancy and scope

```
Platform (Super Admin)
└── Organization  ← tenant boundary (D-001)
    ├── Brands (time zone, currency, working week, holidays, SLA/allocation rules)
    │   ├── Branches
    │   ├── Courses → Batches
    │   └── Teams → Members
    └── Users ── role assignments scoped to org / brand / branch / team
```

- Every business table has `organization_id`; brand-owned tables also have `brand_id`.
- Organization isolation: application data-access layer + PostgreSQL row-level security (A-008). The API sets the tenant on each DB transaction; RLS rejects anything else.
- Brand/team scope: one shared data-access layer builds every query filter from the user's role assignments. No controller queries the database directly.
- Authorization = permission (action) AND scope (where). Enforced in the backend.

## 2. Repository layout

```
academic-sales-crm/
├── apps/
│   ├── web/          Next.js (App Router) + TypeScript + Tailwind
│   ├── mobile/       Expo / React Native executive app (own npm lockfile, outside the pnpm workspace)
│   └── api/          NestJS — one codebase, two entrypoints:
│                       main.ts   → HTTP API (REST, OpenAPI)
│                       worker.ts → BullMQ workers + schedulers
├── packages/
│   ├── database/     Prisma schema, migrations, RLS SQL, seed
│   ├── contracts/    shared DTOs / zod schemas / enums
│   ├── ui/           shared components
│   └── config/       eslint, tsconfig, prettier
├── docs/             SRS, DECISIONS, ARCHITECTURE, ERD, API, KPI-DICTIONARY, runbooks
├── tests/e2e/        Playwright
└── infra/docker/     docker-compose (postgres, redis, mailpit), Dockerfiles
```

Changes from SRS Appendix A: the three separate worker apps become one worker entrypoint in `apps/api`, so domain logic exists once; the Prisma schema lives in `apps/api/prisma` (only the API touches the database) instead of `packages/database`.

## 3. Runtime

| Component             | Role                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL 16         | Single source of truth. History tables append-only.                                                                                                                                                              |
| Job queue             | PostgreSQL `jobs` table (A-033): deterministic keys, SKIP LOCKED claiming, retries with backoff, DEAD letters. Run by the in-process worker or `/internal/tick`. Redis is optional (rate limits, later caching). |
| Outbox                | Domain change + `outbox_events` row written in one transaction; relay pushes to BullMQ. No lost events, no events for rolled-back changes.                                                                       |
| Webhooks              | Store raw payload in `webhook_events` with unique `(provider, external_event_id)` → idempotent; process asynchronously.                                                                                          |
| WebSockets            | Live notifications and dashboard counters.                                                                                                                                                                       |
| S3-compatible storage | Student documents, imports; expiring signed URLs.                                                                                                                                                                |
| Clock                 | Injected `Clock` service everywhere; tests use a controllable clock (Phase 7 exit gate).                                                                                                                         |

## 4. Core data model (key decisions only — full ERD in Phase 2/4)

- `persons` (org-scoped identity, normalized E.164 phone + raw, email) → `leads` (one open per person per brand: owner, stage, status, score) → `enquiries` (immutable attribution per submission).
- `leads.stage` ∈ 8 diagram stages; `leads.status` ∈ OPEN, ON_HOLD, LOST, IN_RECOVERY, CLOSED_LOST, CONVERTED (D-004).
- `lead_participants` (counsellor, admission officer) — ownership unchanged (A-009).
- Append-only: `lead_assignments` (from, to, type AUTO/MANUAL/RECOVERY, reason, attempt_no, rule_version, sla_instance_id), `lead_stage_history`, `activities`, `payments`, `refunds`, `audit_logs`.
- `sla_instances`: `started_at`, `due_at_calendar`, `due_at_working`, `trigger_basis` (WORKING|CALENDAR), `state` (PENDING/AT_RISK/BREACHED/PAUSED/RESOLVED/CANCELLED), `resolved_at`, `elapsed_calendar_min`, `elapsed_working_min` (D-003).
- `admission_credits`: (admission, user, credit_type FIRST_CONTACT|CLOSER, share_pct) (D-005).
- Money: integer minor units + ISO currency on every amount (INR paise, AED fils).
- Admissions: status DRAFT → CONFIRMED (first verified payment, D-006) → CANCELLED_REFUNDED (full refund, A-007b); also DEFERRED / CANCELLED.
- Refunds: `refunds` (request → approved → paid / rejected), linked to original payment(s); never mutate payments (D-007).

## 5. SLA engine (implemented in Phase 7)

1. First assignment → in the same transaction: `sla_instances` row (policy snapshot), the single first-call task
   (partial unique index), and one job per checkpoint plus the deadline (`sla:{id}:g{generation}:cp{n}`).
2. Due times use the brand calendar (working hours, holidays, time zone) or calendar minutes, per checkpoint (A-003a).
3. A job re-reads the instance under a row lock; if the generation changed (pause/resume) or it is resolved, paused
   or cancelled, it does nothing. Actions: remind owner, alert team leaders, reassign (allocation engine, previous
   owners excluded, at most `max_reassign_attempts`), escalate to managers + priority queue. Every trigger is an
   append-only `sla_events` row.
4. Hold pauses (consumed minutes saved, generation bumped, pending jobs cancelled); resume schedules what is left.
5. A call task outcome resolves the instance and stores both clocks (D-003, A-011, A-032).

## 5a. Engagement (Phase 8)

- Every interaction is an append-only `activities` row; delivery tracking lives beside it (`outbound_messages` +
  append-only `message_events`). The lead timeline merges enquiries, lead events and activities.
- Providers sit behind `WhatsAppProvider` / `TelephonyProvider`; sandbox adapters are registered only when
  `NODE_ENV !== 'production'`. Sending is a `message.send` job: temporary errors retry with backoff, permanent errors
  fail at once, exhausted retries fail the message and dead-letter the job. Receipts only move status forward.

## 5b. Admissions and documents (Phase 11)

- Admission status is driven by the document checklist until approval; approval and confirmation hold batch seats
  (row lock on the batch, capacity check, recorded override). Confirmation (D-006) is one transaction: number,
  seat, lead stage/status, outbox event and LMS handover.
- Document bytes go through `DocumentStorage` (PostgreSQL by default); downloads only via short-lived HMAC links.
- LMS handover through `LmsProvider` (sandbox outside production; manual handover otherwise) — `docs/LMS-CONTRACT.md`.

## 5c. Payments (Phase 12)

- A `payments` row is written only for verified money (signed webhook, server-side reconciliation, or Accounts'
  manual verification) and never changes. Gateway orders live in `payment_attempts`; raw webhooks in append-only
  `payment_events` (unique provider event id → idempotent). Signatures are checked on the raw request body.
- The scheduler tick reconciles pending attempts older than 10 minutes with the gateway (missed webhooks).
- The first verified payment confirms the admission (D-006) in a separate transaction, so a blocked confirmation never
  loses the payment. Refunds are an immutable request plus append-only decisions; a full refund cancels the admission.

## 5d. Reports (Phase 13)

- `ReportsService.collect()` turns the history tables into record sets that all carry the same dimensions (lead, brand,
  course, first-touch source and campaign, attributed user). Summary, breakdowns, drill-downs, target progress and
  incentive runs are all computed from those sets, so their numbers reconcile by construction. No report tables or
  copied totals exist; if reports ever become slow, materialised snapshots can be added behind the same functions.
- Scope is applied to the records (brand and attributed user), from the caller's `report.read` grant; executives without it
  see only their own records.

## 5e. AI assistance (Phase 14)

- `apps/api/src/ai/`: pure scoring functions (`scoring.ts`), feature extraction that never reads personal data
  (`features.ts`), and `AiService` (settings, training, scoring with fallback, overrides, next-best actions, jobs).
- No external AI provider (A-045, O-13). Daily `ai.train` and hourly `ai.rescore` jobs are enqueued from the scheduler
  tick with deterministic keys. The lead page loads the AI panel separately, so AI failures cannot break it. Review:
  `docs/AI-REVIEW.md`.

## 5f. Executive mobile app (A-050)

- `apps/mobile`: Expo (SDK 58) with Expo Router (`src/app`); talks to the same `/api/v1` as the web. It is not in the
  pnpm workspace (Metro and EAS expect a plain npm project); it does not import `packages/contracts` and keeps its few
  constants in `src/lib/logic.ts`, which holds the testable logic (`npm test`, Node's test runner).
- Auth: `x-crm-client: mobile` → refresh token in the response body, stored in SecureStore; access token in memory;
  one refresh on 401. Push: `push_devices` + `push.send` job per notification via `PushProvider` (Expo in production,
  labelled sandbox otherwise). Offline: last GET responses in AsyncStorage, read-only, cleared on sign-out.

## 6. Allocation

Filter → rank → pick → record:

- Filter: active; role Sales Executive in the lead's brand; course/language/region tags match; on shift and available; below max active leads; not in cooldown; not a previous owner of this lead.
- Rank: lowest load ratio (active ÷ capacity), then optional performance weight, then weighted round-robin pointer; final tie-break by user id (deterministic).
- Record: `allocation_runs` with candidates considered, reasons for exclusion, rule version.
- Implemented (Phase 6): eligibility = `lead.receive` in the brand + available toggle + not on leave + below capacity + language + rule pool; strategies LEAST_LOADED / ROUND_ROBIN; performance weighting is not yet used (A-029, A-030).
- No candidate → unassigned queue + manager alert. Attempts > max (A-010) → manager priority queue.
- Allocation runs under a per-lead lock (DB advisory lock) so retries never double-assign; first task created in the same transaction (SRS 11: exactly one initial task).

## 7. Payments and refunds

- Gateway adapter interface (India and UAE providers, O-09); sandbox adapter clearly labelled, never used in production config.
- Payment marked SUCCESS only by signed webhook / server-side verification or Accounts manual verification with evidence.
- First verified payment of an admission-track lead → admission CONFIRMED, admission number generated, credits written, batch seat reserved — one transaction.
- Refund → approval → paid; full refund triggers A-007b in one transaction; all reports event-dated (A-007c).

## 8. Security baseline

Argon2id password hashing; short-lived access token + rotating refresh token in httpOnly cookies; session revocation; login rate limit and lockout; MFA-ready (TOTP); RLS + scoped data access; audit log for auth, assignment, merge, export, payment, refund, permission and configuration changes; secrets only in environment/secret store; signed webhooks with replay window; OWASP headers; PII minimization for AI calls.

## 9. Phase plan

Follows SRS §12, Phases 0–15, unchanged in order. Adjustments:

- Phase 2 adds organization tenancy + RLS (D-001) and its isolation tests.
- Phase 3 business calendar supports India/UAE time zones and per-brand working week.
- Phase 4: website webhook + CSV/XLSX import go live first; Meta/Google/WhatsApp start as labelled sandbox adapters until accounts are available (O-04).
- Phase 7 implements dual clocks (D-003).
- Phase 12 implements advance payments, admission-on-first-payment and refunds (D-006, D-007).
- Phase 13 implements dual credit (D-005) and per-currency reporting (A-012).

**First milestone: Phase 1 + Phase 2** — engineering foundation, then organizations/brands/users/roles/scopes with cross-organization and cross-brand isolation tests.

## 10. Risks

| Risk                                                | Mitigation                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| Meta / Google / WhatsApp onboarding delays          | Adapters + sandbox; website and import first                           |
| SLA timing bugs (time zones, holidays, dual clocks) | Injected clock, table-driven tests across IST/GST boundaries           |
| Tenant data leak                                    | RLS + scoped data layer + automated "change the ID" tests per endpoint |
| Fake call logging defeats SLA                       | Telephony integration (O-06); flag manual-only logs in reports         |
| Refunds distort reports/incentives                  | Event-dated reporting, clawback approval, no silent recalculation      |
| Scope size                                          | Strict phase gates; Phases 1–7 deliver the core promise                |
