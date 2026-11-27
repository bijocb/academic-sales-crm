# Phase 3 plan — Course catalogue and operational configuration

Approved by owner: 2026-11-27. Scope: SRS §12 Phase 3 (FR-013 catalogue; calendars and settings used by FR-009/FR-011).

## Data (migration `catalog_and_settings`)

| Table               | Purpose                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `course_categories` | Per brand; code unique per brand                                                                                                             |
| `courses`           | Per brand; optional category; code, name, description, eligibility, delivery mode, duration, list fee (minor units + brand currency), status |
| `batches`           | Per course (and brand, optional branch); code, start/end date, capacity, schedule note, status PLANNED/OPEN/CLOSED/CANCELLED                 |
| `working_hours`     | Per brand: weekday 1–7 (ISO), start/end minute; several shifts per day allowed                                                               |
| `holidays`          | Per brand: local date + name; unique per brand+date                                                                                          |
| `sla_policies`      | One per brand: first-response target, max reassignment attempts, reassignment cooldown                                                       |
| `sla_checkpoints`   | Ordered actions: REMIND_OWNER / ALERT_TEAM_LEADER / REASSIGN / ESCALATE_MANAGER at N minutes, basis WORKING or CALENDAR                      |
| `pipeline_stages`   | Per brand: the 8 diagram stages (fixed keys and order), editable label and required fields                                                   |

All tables: `organization_id`, RLS `tenant_isolation`, composite FKs. Every change audited.

## Defaults (created for every brand, and back-filled idempotently on deploy)

- Working hours — India: Mon–Sat 09:30–18:30; UAE: Mon–Fri 09:00–18:00 (A-018, editable per brand).
- SLA — diagram values: remind owner 5, alert team leader 15 (first-response target), reassign 30, reassign 60, then escalate; basis WORKING (A-003a); max 3 automatic attempts (A-010); cooldown 24 h.
- Pipeline — 8 diagram stages with the SRS §3.2 required fields.

## Business-time engine (pure, unit-tested)

`addWorkingMinutes(start, minutes, calendar)` and `workingMinutesBetween(a, b, calendar)` using brand time zone,
shifts and holidays (Luxon). Phase 7 SLA timers will use it. A preview endpoint shows both clocks
("a lead arriving at 22:00 IST is due at …").

## API (`/api/v1`)

- `GET/POST /course-categories`, `PATCH /course-categories/:id`
- `GET/POST /courses`, `GET/PATCH /courses/:id`
- `GET/POST /batches`, `GET/PATCH /batches/:id`
- `GET/PUT /brands/:id/working-hours`
- `GET/POST /brands/:id/holidays`, `DELETE /holidays/:id`
- `GET/PUT /brands/:id/sla-policy`
- `GET /brands/:id/pipeline-stages`, `PATCH /pipeline-stages/:id`
- `GET /brands/:id/calendar/preview?start=&minutes=`

Permissions: `course.read` / `course.manage`, `settings.manage` — all brand-scoped; out-of-scope IDs → 404.

## Web

Courses page (categories, courses, batches) and Brand settings page (working hours, holidays, SLA policy, pipeline labels, due-time preview).

## Tests (exit gate: admin can configure catalogue and operational rules)

- Unit: business-time maths across IST/GST, shifts, weekends, holidays, after-hours arrival, between-calculation.
- Integration: catalogue CRUD and validation; brand-scope isolation (404/403); defaults for new brands; working-hours/SLA validation; preview endpoint; audit rows.
- E2E: brand manager creates a course and sees brand settings.
