# Plan — personal performance report on every dashboard

Requested by the owner after Phase 15 (2026-11-28): "Each user dashboard needs a performance report". Owner decisions
(recorded as D-008):

- Every user: period picker (this week, this month, last month, custom) with the change against the previous period of
  the same length; a daily trend; their own funnel and first-response SLA.
- Comparison with colleagues: the **team average only**, no names, no ranking.
- Managers and team leaders: their own numbers **plus** a per-executive table for the people in their scope.

## Backend

`GET /reports/me?from&to` — same KPI engine and definitions as the reports (`docs/KPI.md`), own scope only:

- `current` and `previous` metrics (previous = the same number of days immediately before `from`);
- `trend`: per local day (brand/organization time zone) — leads assigned, leads contacted, admissions confirmed;
- `funnel`: assigned → contacted → counselling completed → quotation accepted → admission confirmed;
- `teamAverage`: for the teams the user belongs to, team totals ÷ current members (rates such as SLA % are the team's
  rate). Aggregates only; `null` when the user is in no team. A team with fewer than 3 members shows no average
  (otherwise a colleague's numbers could be worked out; ASSUMED).

The manager table reuses `GET /reports/breakdown?by=executive` (scope-checked, `report.read`).

## Web

Home dashboard: period picker; KPI tiles with Δ vs previous and the team average; three small trend charts (one per
measure, one scale each, hover values, table view); funnel; for `report.read` holders, the team table.

## Tests

Integration: previous-period values; trend sums equal the totals; funnel; team average (and hidden below 3 members);
the response holds no other person's identity; scope (user without a team). e2e: dashboard shows the report.
