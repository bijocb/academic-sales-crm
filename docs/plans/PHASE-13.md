# Phase 13 plan — Targets, incentives and reports

Approved by owner: 2026-11-28 ("approve Phase 13").
Scope: FR-016, FR-017, SRS §10 (KPI rules). Exit gate: report values reconcile to fixtures and underlying records.

O-10 is open (incentive rules, FX policy, ad-spend source): incentive rules are configurable with ASSUMED defaults,
money is never added across currencies (A-012), and ad spend is entered manually per campaign and month (A-044).

## Report engine

One `ReportsService` computes every KPI straight from the history tables (no copies, so numbers always reconcile).
Each KPI states its **date basis** and is defined in `docs/KPI.md`.

- Period: `from`–`to` dates, interpreted in the brand's time zone when one brand is selected, otherwise the
  organization's (ASSUMED); shown on every report.
- Filters: brand, team, executive, course, source, campaign.
- Scope (backend-enforced): `report.read` at organization/brand level sees those brands; at team level only the team's
  members and their leads; anyone else sees only their own numbers ("My dashboard").
- Merged leads are excluded; duplicates count once (distinct lead ids).

KPIs: leads created · assigned · contacted (connected calls) · contact rate (cohort) · first-response SLA compliance
and average working/calendar minutes · open and overdue tasks (snapshot) · reassigned · lost · recovered · counselling
completed · quotations accepted · admissions confirmed / cancelled / net (event-dated, A-007c) · first-contact and
closing admissions (D-005, A-005a/b) · revenue collected net of refunds paid and outstanding, per currency · funnel
(distinct leads entering each stage) · CPL and CPA per campaign (first-touch attribution, ASSUMED).

Dashboards: **My dashboard** (own numbers), **Team** (per-executive comparison, workload, ageing), **Management**
(brand / course / source / campaign breakdown, funnel, revenue, collections, CPL/CPA, recovery).

**Drill-down**: each count links to the underlying records (leads, admissions, payments), filtered by the same
scope — the list length equals the number shown.

**Exports**: CSV (`report.export`), every export audited with its filters. XLSX/PDF follow later (ASSUMED).

## Targets (FR-016)

Per organization / brand / team / executive, optional course, period, metric (assigned, contacted, counselling,
admissions, revenue, collections), value (count or money with currency). Progress uses the same KPI functions.
`target.manage` creates and edits; changes are audited.

## Incentives (FR-016)

- Versioned rules with effective dates: metric (confirmed admissions or collections), amount per admission or percent of
  collections, threshold, cap per person per run, exclusions (courses), and the first-contact / closing split (A-005b,
  default 50 / 50, 100 % when the same person).
- A **run** for a brand and period computes a preview: one line per person with the inputs (admission and payment ids)
  and the rule version stored. Approve (by someone other than the creator) locks it — approved runs are never
  recalculated. Refunds after approval create **clawback** lines in the next run for approval (A-007c).

## Data (migration `reports`)

`targets` · `ad_spend` · `incentive_rules` · `incentive_runs` · `incentive_lines` (append-only).

## API

`GET /reports/summary`, `GET /reports/breakdown?by=executive|course|source|campaign|brand`, `GET /reports/funnel`,
`GET /reports/drilldown?metric=`, `GET /reports/export?report=`, `GET/POST/PATCH /targets`, `GET /targets/progress`,
`GET/POST /ad-spend`, `GET/POST /incentive-rules`, `POST /incentive-runs`, `GET /incentive-runs/:id`,
`POST /incentive-runs/:id/approve`.

## Web

Dashboard home: my numbers and targets. Reports page: filters, KPI tiles, funnel, breakdowns, drill-down, CSV
export. Targets page. Incentives page (rules, runs, approval).

## Tests

Integration with a fixed fixture (known leads, assignments, calls, SLA clocks, stage moves, admissions, payments,
refunds across two brands and currencies): every KPI equals the hand-computed value · breakdown rows add up to the
total · drill-down lengths equal the counts · currencies never mixed · team-scoped and own-only views · target
progress · incentive preview, split, threshold, cap, approval lock, clawback after refund · export audited and
permission-checked.
