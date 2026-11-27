# Phase 7 plan — Tasks and SLA engine

Approved by owner: 2026-11-27 ("approve Phase 7").
Scope: SRS §12 Phase 7, FR-008, FR-009, §5 / §5.1. Exit gate: time-bound tests pass using a controllable test clock.

## Tasks (FR-008)

- Types: first call, call back, WhatsApp, email, counselling, document collection, payment follow-up, admission
  confirmation, custom. Fields: owner, due, priority, status (open / completed / cancelled; **overdue** = open and past
  due), lead, channel, outcome, notes.
- **Exactly one first-call task per lead**, created in the same transaction as the first assignment (partial unique
  index — safe under allocation retries). Open tasks follow the lead when it is reassigned.
- Complete needs an **outcome** (call tasks: connected / no answer / busy / switched off / wrong number / call back
  requested; other tasks: done / message sent). Cancel needs a reason. Reschedule keeps a count.
- **Next action rule:** an open lead must keep at least one open task. Completing or cancelling the last open task
  requires a next task in the same request, unless the lead is on hold.
- **Hold:** `POST /leads/:id/hold` (reason, optional until-date) pauses the SLA; resume restarts it and needs an open or
  new next task. ASSUMED: no separate approval step yet (anyone with `lead.edit` on the lead; audited).
- Who: owners work their own tasks; `task.manage` sees and manages tasks in scope (brand, or own teams' members).

## SLA (FR-009, SRS §5)

- An SLA instance starts at first assignment, with a snapshot of the brand's policy (first-response target, ladder of
  checkpoints, each on working or calendar minutes — A-003a, A-019).
- States: PENDING → AT_RISK (first reminder) → BREACHED (first-response deadline passed) · PAUSED (hold) · RESOLVED ·
  CANCELLED (lead merged / closed / manual reassignment restarts it).
- **Resolved by** completing the first-call task with any call outcome (A-011: an attempt counts; "connected" is stored
  separately as the outcome). Phase 8 call logging will resolve through the same hook.
- Both clocks are stored on resolution: calendar minutes and working minutes (D-003). Hold time counts on neither
  (ASSUMED).
- Checkpoint actions: remind owner · alert team leader(s) (falls back to brand managers) · reassign (allocation engine,
  excluding current and previous owners; at most `max reassign attempts`; no one eligible → escalate) · escalate to
  managers and the **priority queue**.
- Manual reassignment = "manual override": the running SLA is cancelled and a new one starts for the new owner.

## Background jobs (rule 7)

Production has no Redis and Vercel functions cannot run timers, so jobs live in PostgreSQL (`jobs` table):

- Deterministic unique key per job (e.g. `sla:<id>:g<gen>:cp<n>`) → enqueueing twice is a no-op.
- Claimed with `FOR UPDATE SKIP LOCKED` (safe with several workers); stuck jobs are reclaimed after 5 minutes.
- Failures retry with exponential backoff (5 attempts) and then become **DEAD** (visible, retryable from the SLA page).
- Every handler re-checks state, so a late or repeated run does nothing harmful.
- Triggers: an in-process worker every 15 s when the API runs as a normal server (local, Docker, any always-on host);
  and `GET/POST /api/v1/internal/tick` protected by `CRON_SECRET` for serverless hosting. Each tick also drains the
  unassigned queues of brands that are in working hours (closes A-030).
- Production on Vercel: a GitHub Actions schedule calls the tick every 5 minutes (free; GitHub may delay runs).
  Minute-accurate reminders need Vercel Pro cron (every minute) or a small always-on worker — owner decision O-12.

## Data (migration `tasks_and_sla`)

`tasks` · `sla_instances` · `sla_events` (append-only) · `jobs`. Hand-written partial unique indexes:
`tasks_one_initial_per_lead`, `sla_instances_one_active_per_lead`.

## API

`GET /tasks` (mine / owner / overdue / status / brand), `POST /leads/:id/tasks`, `GET /leads/:id/tasks`,
`POST /tasks/:id/complete|reschedule|cancel`, `GET /leads/:id/sla`, `POST /leads/:id/hold|resume`,
`GET /sla/overview`, `GET /sla/priority-queue`, `GET /ops/jobs`, `POST /ops/jobs/:id/retry`, `/internal/tick`.

## Web

My tasks (overdue / today / upcoming; team view for managers), lead page tasks + SLA status + hold/resume, SLA monitor
(at risk, breached, priority queue, failed jobs).

## Tests

Integration with `FixedClock`: one first-call task even when allocation retries · 5/15/30/60 ladder on working time,
including end-of-day and holiday roll-over · calendar-basis checkpoint · resolution stops later checkpoints and stores
both clocks · reassignment excludes previous owners, keeps history and attempt numbers, stops at the maximum →
escalation · no eligible user → escalation · hold pauses and resume reschedules the remaining ladder · repeated ticks
are idempotent · failing job retries then goes DEAD · next-action rule · merge cancels SLA and tasks. e2e: complete a
first-call task with a next task.
