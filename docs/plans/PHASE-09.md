# Phase 9 plan — Pipeline and counselling

Approved by owner: 2026-11-27 ("approve Phase 9").
Scope: SRS §3.2 (stage table), FR-011, §9.1. Exit gate: invalid stage transitions are blocked; valid transitions are
audited.

## Stage rules

The eight stages and their required fields come from each brand's pipeline settings (Phase 3, editable).

- A lead moves only while its status is OPEN (on-hold, lost and merged leads cannot move).
- **Forward** (also skipping stages): allowed with `pipeline.transition` on a lead the user can edit, when the required
  fields of **every stage up to the target** are present (ASSUMED A-037: requirements are cumulative, so a stage can't
  be skipped without its data).
- **Backward**: needs a reason and `task.manage` in the brand (team leader / manager) (ASSUMED A-037).
- **Admission Confirmed is system-only**: it is set by the admission/payment workflow (Phases 11–12, D-006), never by
  hand.
- Every move is an append-only `lead_stage_history` row (from, to, direction, actor, reason, field snapshot) plus an
  audit-log entry and a timeline event. A refused move returns the missing fields
  (`400 STAGE_REQUIREMENTS_MISSING`).

How each required field is satisfied:

| Field                                   | Satisfied by                                                            |
| --------------------------------------- | ----------------------------------------------------------------------- |
| name, mobile, source                    | person name, phone, original enquiry                                    |
| contactOutcome                          | at least one logged call (attempt; "connected" shown separately)        |
| qualification, eligibility, requirement | qualification record: highest qualification, eligibility notes, goal    |
| interestLevel, coursePreference         | qualification record: interest level; preferred course (or lead course) |
| counsellingDate, counsellingRemarks     | a completed (attended) counselling session with a summary               |
| course, batch, feeQuote                 | an open or accepted quotation for a course and batch                    |
| amountDue, paymentStatus                | an accepted quotation (amount due; payment pending)                     |
| admissionId, paymentVerified            | Phases 11–12 (not satisfiable yet)                                      |

## Qualification (FR-011)

One record per lead: highest qualification, eligibility notes, student goal/requirement, interest level
(hot / warm / cold), preferred courses, intended intake, budget/fee readiness, objections. Every change is a timeline
event with the changed fields, and audited.

## Counselling sessions

Booked sessions are the Phase 8 appointments. A walk-in or unscheduled session can be recorded directly (counsellor,
time, mode, attended, summary, optional next task). The counsellor becomes a lead participant and can see the lead
(A-009).

## Quotations (course selection)

A quotation = course + batch (open or planned) + list fee + discount (reason required) = total, in the brand's currency
(integer minor units), valid until a date, numbered per organization (Q-000001). Issued quotations are never edited;
several can be open at once (alternatives). Accepting one supersedes the others; rejecting needs a reason. Discounts
above 10% of the list fee need `task.manage` (ASSUMED A-038; full approval workflow with fee plans in Phase 12).

## Views and bulk actions

- Pipeline board (kanban): open leads per stage with counts, filtered by brand, owner, course, my leads.
- List view: the leads list gains stage and owner filters.
- Saved views per user (name, page, filters).
- Bulk move to a stage: each lead is checked individually; the result lists moved and refused leads with reasons.

## Data (migration `pipeline`)

`leads.stage_changed_at` · `lead_stage_history` (append-only) · `lead_qualifications` · `quotations` · `saved_views`.

## API

`GET /leads/:id/stage`, `POST /leads/:id/stage-transitions`, `POST /leads/bulk-transition`, `GET /pipeline`,
`GET/PUT /leads/:id/qualification`, `POST /leads/:id/counselling`, `GET/POST /leads/:id/quotations`,
`POST /quotations/:id/accept|reject`, `GET/POST/DELETE /saved-views`.

## Tests

Integration: forward move with data · missing fields refused with the list · skipping blocked without data · backward
needs reason and manager · Admission Confirmed refused · on-hold lead can't move · history append-only and audited ·
qualification updates logged · counselling record satisfies counselling fields and grants the counsellor visibility ·
quotation totals, discount rules, accept supersedes alternatives · bulk move mixed results · board grouping and scope ·
saved views are private. e2e: qualify a lead and move it through stages on the lead page.
