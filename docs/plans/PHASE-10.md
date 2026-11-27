# Phase 10 plan — Lost lead recovery

Approved by owner: 2026-11-27 ("approve Phase 10").
Scope: FR-012, SRS §3.2 (Lost / Not Interested), §11 (lost recovery acceptance). Exit gate: recovery and closure
scenarios pass.

O-07 (recovery rules) is still open, so every rule below is a **per-brand setting with an ASSUMED default** that a
manager can change (A-040).

## Statuses (beside the 8-stage pipeline, D-004)

`OPEN` → **mark lost** → `LOST` (cooldown) → `IN_RECOVERY` (being re-worked) → back to `OPEN` (recovered) or
`CLOSED_LOST` (final). Every status change is an append-only `lead_status_history` row (from, to, reason, notes,
actor), so a recovered lead keeps its lost history.

## Mark lost

- Needs a **loss reason** (per-brand list) and **notes**; plan = recover or close.
- Stops the SLA clock and cancels open tasks ("Lead marked lost"); the pipeline stage is kept.
- Recover: allowed only for a _recoverable_ reason, when recovery is enabled and the person has not opted out
  ("valid contact permission"). A recovery case is scheduled for the end of the cooldown.
- Close at once: needs `recovery.manage` (manager approval), except for non-recoverable reasons (e.g. invalid or fake
  enquiry), which close directly.

## Recovery

- When the cooldown ends a background job starts the case: status `IN_RECOVERY`, a **recovery owner** is chosen and a
  "Recovery call" task is created. Owner modes: a different executive (allocation engine, previous owners excluded;
  ASSUMED default), the same owner, or an unowned recovery queue for managers. Outside working hours it waits.
- A manager can start a case early.
- Each **attempt** records channel, result, notes, optional alternative course, and the next recovery date; attempts are
  append-only. Results: no response, call back later, not interested, interested, opted out. A call attempt is also a
  call activity.
- **Interested** → the lead reopens (`OPEN`) with the recovery owner and a next task; prior lost history is kept;
  alternative course/batch quotations can be issued as usual.
- **Opted out** (or the person opts out by any route) → do-not-contact is set and the case closes; no recovery
  messages can be sent after an opt-out.
- No success after the maximum attempts → closed as `CLOSED_LOST` (auto-close ASSUMED on; if switched off the case
  waits for a manager).
- A manager can close a case at any time with a reason.
- A person who enquires again while their lead is lost (cooldown) gets a new linked lead (existing behaviour); the
  waiting recovery case is cancelled and the old lead closed as "Returned with a new enquiry".

## Settings (per brand, back-filled)

- Loss reasons (code, label, recoverable, active, order). Defaults: not interested now, fee too high, chose another
  institute, course not suitable, timing / later intake, location or mode, not reachable, already enrolled elsewhere
  (not recoverable), invalid or fake enquiry (not recoverable), other.
- Recovery policy: enabled, cooldown 7 days, max 3 attempts, 3 days between attempts, owner mode "different executive",
  auto-close after the last attempt — all ASSUMED.

## Data (migration `recovery`)

`loss_reasons` · `recovery_policies` · `lead_status_history` (append-only) · `recovery_cases` · `recovery_attempts`
(append-only).

## API

`GET/POST /loss-reasons`, `PATCH /loss-reasons/:id`, `GET/PUT /recovery/policy`, `POST /leads/:id/lost`,
`GET /leads/:id/recovery`, `GET /recovery` (queue), `POST /recovery/:id/start`, `POST /recovery/:id/attempts`,
`POST /recovery/:id/close`.

## Web

Lead page: "Mark lost" dialog, recovery panel (case, attempts, log attempt, close). Recovery queue page. Brand settings:
loss reasons and recovery policy.

## Tests

Integration (controllable clock): lost needs reason + notes · SLA stops and tasks cancel · cooldown → job starts the
case with a different executive and a task · outside working hours waits · attempts up to the maximum → auto-close ·
interested → reopen with history kept · opt-out blocks recovery start and messages, opt-out during recovery closes the
case · non-recoverable reason closes directly; recoverable close needs a manager · manager early start and close ·
returning enquiry cancels the waiting case · history tables append-only · queue scoping. e2e: mark lost, start recovery,
log an interested attempt, lead reopens.
