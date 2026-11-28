# Accessibility — Phase 15

Target: WCAG 2.1 AA where practical (SRS §8). Check: `tests/e2e/a11y.spec.ts` runs axe-core (tags `wcag2a`, `wcag2aa`,
`wcag21a`, `wcag21aa`) on the sign-in page, dashboard, leads, lead page, tasks, pipeline, appointments, recovery,
reports, targets, incentives, settings and users. It fails on any serious or critical violation and prints the rest.
It runs in CI with every e2e run, together with a keyboard check (open "New lead", type, Tab between fields).

## Result (2026-11-28)

The first scan found 5 failing screens. After the fixes, all 13 screens report **no violations at any level**.

| Issue                                                                  | Where                                          | Fix                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| Selects without an accessible name (critical)                          | Leads filters, SLA reminder rows, users filter | `aria-label` on each select               |
| Text contrast below 4.5:1 (serious)                                    | Grey helper text (`slate-400`) in 10 files     | Darker grey (`slate-500`, 4.8:1 on white) |
| Accessible name did not contain the visible text (serious, WCAG 2.5.3) | Report KPI tiles ("5" vs "Leads created")      | Name now "Leads created 5: show records"  |

## Not covered by automated checks

Screen-reader walkthroughs (NVDA / VoiceOver), zoom to 200 % and right-to-left layouts have not been tested. Include
them in UAT (`docs/UAT.md`, A11Y cases). Forms use visible labels; focus is visible on all interactive elements
(browser default plus brand outline); tables have header rows.
