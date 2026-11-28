# KPI dictionary

Definitions follow SRS §10 and DECISIONS. Every KPI is computed by `ReportsService.collect()`
(`apps/api/src/reports/reports.service.ts`) straight from the history tables — there are no copied totals, so the summary,
every breakdown row, the drill-down list and target progress are the same records and always reconcile.

**Rules that apply to every KPI**

- **Period**: `from`–`to` calendar dates, interpreted in the selected brand's time zone, otherwise the organization's
  (A-044). The period, time zone and date basis are returned with (and shown on) every report.
- **Scope** is enforced in the backend: `report.read` at organization or brand level sees those brands; at team or branch
  level only records attributed to the team's current members; everyone else (and `mine=true`) sees only records
  attributed to themselves.
- **Merged leads are excluded**; counts of leads are distinct leads (a lead counts once per metric).
- **Attribution**: source and campaign = first touch (the lead's original enquiry, D-004); executive = the owner at the
  time of the event from the append-only assignment history ("closing"), and for admissions additionally the first
  connected caller ("first contact", D-005, A-005a).
- **Money** in integer minor units, always per currency — INR and AED are never added together (A-012). There is no FX
  conversion (O-10).

| KPI                           | Definition                                                                                                             | Date basis                     | Source                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| Leads created                 | Leads created in the period (attributed to the current owner; unassigned leads shown as "Unassigned")                  | lead created                   | `leads`                                                     |
| Assigned leads                | Distinct leads with an assignment event in the period (every `lead_assignments` row counts, including reassignments)   | assignment                     | `lead_assignments`                                          |
| Reassigned                    | Assignment events with a previous owner                                                                                | assignment                     | `lead_assignments`                                          |
| Contacted leads               | Distinct leads with a CONNECTED call in the period (attempts do not count, A-011)                                      | call                           | `activities`                                                |
| Contact rate                  | Of the leads assigned in the period (cohort), those with a CONNECTED call at any time × 100                            | assignment (cohort)            | `lead_assignments`, `activities`                            |
| First-response SLA compliance | Clocks resolved without breach / clocks started (cancelled clocks excluded) × 100 (D-003)                              | clock started                  | `sla_instances`                                             |
| Average first response        | Mean `working_minutes`, and separately `calendar_minutes`, of resolved first-response clocks                           | clock started                  | `sla_instances`                                             |
| Open / overdue tasks          | Open tasks now; overdue = due before now                                                                               | snapshot (now)                 | `tasks`                                                     |
| Open leads, average age       | Leads now OPEN, ON_HOLD or IN_RECOVERY; age = days since created                                                       | snapshot (now)                 | `leads`                                                     |
| Lost                          | Distinct leads moved from OPEN / ON_HOLD to LOST or CLOSED_LOST                                                        | status change                  | `lead_status_history`                                       |
| Recovered                     | Distinct leads reopened by recovery (reason RECOVERED)                                                                 | status change                  | `lead_status_history`                                       |
| Counselling sessions          | Appointments completed, attributed to the counsellor                                                                   | session start                  | `appointments`                                              |
| Quotations accepted           | Quotations accepted, attributed to the owner at acceptance                                                             | decision                       | `quotations`                                                |
| Admissions confirmed          | Admissions confirmed in the period; credited to the closing executive and, separately, to the first connected caller   | confirmation event (A-007c)    | `admission_status_history`                                  |
| Admissions cancelled          | Admissions that became CANCELLED_REFUNDED in the period (credited to the owner at confirmation)                        | cancellation event (A-007c)    | `admission_status_history`                                  |
| Net admissions                | Confirmed − cancelled in the same period (a cancellation reduces the period in which it happens, not the original one) | events                         | as above                                                    |
| Funnel                        | Leads created, then distinct leads entering each stage by a forward move                                               | stage move                     | `leads`, `lead_stage_history`                               |
| Revenue collected             | Verified payments received, per currency; refunds paid shown separately; net = collected − refunds paid (D-006, D-007) | payment received / refund paid | `payments`, `refunds`, `refund_events`                      |
| Outstanding                   | For confirmed admissions: net fee (plan base + adjustments) − (verified payments − refunds paid), per currency (A-043) | snapshot (now)                 | `fee_plans`, `fee_adjustments`, `payments`, `refund_events` |
| Ad spend                      | Manual spend per campaign and month, for every month the period touches (A-044)                                        | month                          | `ad_spend`                                                  |
| CPL                           | Ad spend / leads created, per campaign or source, per currency                                                         | as above                       | `ad_spend`, `leads`, `enquiries`                            |
| CPA                           | Ad spend / admissions confirmed, per campaign or source, per currency                                                  | as above                       | `ad_spend`, `admission_status_history`                      |

## Not yet reported

These definitions are fixed; the numbers can already be derived from the tables named, but they are not on the reports
yet: follow-up completion (tasks completed on or before `due_at` / tasks due), time in stage (median time between forward
moves), quotation acceptance rate (accepted / decided), counselling attendance (completed / completed + no-show), message
delivery rate (DELIVERED or READ / sent per channel) and recovery conversion (recovered leads that convert / leads
entering recovery).

## Targets and incentives

- **Target progress** uses the same records: ASSIGNED and CONTACTED (distinct leads), COUNSELLING (sessions), ADMISSIONS
  (net admissions), COLLECTIONS (payments received in the target currency) and REVENUE (collections − refunds paid).
- **Incentive runs** use the confirmed admissions (per-admission rules) or payments and refunds paid (percent rules) of the
  brand and period; see A-044 for the split, threshold, cap and clawback rules.
