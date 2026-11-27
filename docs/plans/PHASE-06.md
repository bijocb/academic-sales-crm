# Phase 6 plan — Lead allocation engine

Approved by owner: 2026-11-27 (availability option **(c)**: working hours + leave + personal toggle).
Scope: SRS §12 Phase 6, FR-007. Exit gate: deterministic allocation and no-eligible-user tests pass.

## Who can receive leads

New permission `lead.receive` ("can be allocated new leads"), in the Sales Executive role template. Eligible =
active user holding `lead.receive` on any scope inside the lead's brand, **and** all of:

| Check                                                                                          | Exclusion reason                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Personal availability toggle is on                                                             | `UNAVAILABLE`                              |
| Not on approved leave today (brand time zone)                                                  | `ON_LEAVE`                                 |
| Brand is in working time (unless the brand turns this off)                                     | whole lead queued: `OUTSIDE_WORKING_HOURS` |
| Active leads < `max_active_leads` (empty = no limit)                                           | `AT_CAPACITY`                              |
| Speaks the lead's language (users with no languages accept all)                                | `LANGUAGE_MISMATCH`                        |
| Not excluded for this lead (previous owner within the cooldown — used by Phase 7 reassignment) | `EXCLUDED`                                 |
| In the pool of the first matching rule                                                         | `NOT_IN_RULE_POOL`                         |

## Rules (per brand, ordered; first match wins)

Conditions: courses, channels, languages, cities (all optional, empty = any). Pool: a team or named users.
Strategy: `LEAST_LOADED` (default: lowest active/capacity, then least recently assigned) or `ROUND_ROBIN`
(least recently assigned). Final tie-break: user id — fully deterministic. No rule matches → whole brand pool.
Each rule change bumps the brand's rule version, stored with every allocation.

## Flow

1. Lead created (any channel) → allocation runs right after the intake transaction commits.
2. Per-lead lock; skipped if the lead already has an owner (idempotent).
3. Every attempt is recorded in `allocation_runs` (candidates considered, why each was excluded, rule, version).
4. Success → owner set, `lead_assignments` row (append-only), lead event, notification to the executive, outbox event.
5. Nobody eligible / outside hours → lead stays in the **unassigned queue**; brand managers are notified once per lead.
6. Queue is drained: by a manager ("Allocate queued leads"), on each new lead of the brand during working hours,
   and (Phase 7) every minute by the background worker.

## Manual assignment

`lead.assign` (unassigned leads) / `lead.reassign` (change owner) inside scope; team leaders only within their team.
Reason required. Target must hold `lead.receive` in the brand; exceeding capacity is allowed with the reason recorded.
Old and new owner notified. History is never overwritten.

## Data (migration `allocation`)

`users.is_available`, `availability_changed_at` · `user_leaves` · `allocation_settings` (per brand: enabled,
respect working hours, rule version) · `allocation_rules` · `allocation_runs` (append-only) · `lead_assignments`
(append-only) · `notifications`. System role permissions are re-synced to the templates on every deploy.

## API / web

`/allocation/settings|rules|queue|executives|runs`, `POST /leads/:id/assign`, `POST /leads/:id/allocate`,
`POST /allocation/queue/allocate`, `/me/availability`, `/users/:id/leaves`, `/notifications`.
Web: Allocation page (queue, executives & capacity, rules, settings, recent decisions), lead page owner + history +
assign, availability switch and notification bell in the header, leave management on Users.

## Tests

Unit: ranking/filters. Integration: auto-assign, least-loaded and round-robin order, capacity, toggle, leave, language,
rule pools, outside hours → queue → drain, no eligible → queue + manager notified, idempotency, manual assign rules,
team-leader scope, cross-brand isolation, append-only history, notifications. E2E: queue → manual assign → history.
