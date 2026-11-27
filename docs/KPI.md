# KPI dictionary

Definitions follow SRS §10 and DECISIONS. Each KPI names the tables it is computed from. Dashboards and reports are
built in Phase 13; until then this file records how each number will be calculated from data already captured.
All periods are evaluated in the brand's time zone; money in integer minor units per currency (A-012: INR and AED are
never added together).

| KPI                           | Definition                                                                                                                                        | Source (phase)                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Assigned leads                | Distinct leads with an assignment event in the period (all `lead_assignments` rows count; current owner shown separately)                         | `lead_assignments` (6)               |
| Contact rate                  | Distinct leads with a CONNECTED call / distinct leads assigned in the cohort × 100 (attempts do not count, A-011)                                 | `activities`, `lead_assignments` (8) |
| First-response SLA compliance | Resolved first-response clocks without breach / clocks started in the period × 100; both working and calendar minutes reported (D-003)            | `sla_instances` (7)                  |
| Average first response        | Mean `working_minutes` (and separately `calendar_minutes`) of resolved first-response clocks                                                      | `sla_instances` (7)                  |
| Follow-up completion          | Tasks completed at or before `due_at` / tasks due in the period × 100 (cancelled tasks excluded)                                                  | `tasks` (7)                          |
| Overdue tasks                 | Open tasks with `due_at` in the past; leads on hold excluded                                                                                      | `tasks`, `leads.status` (7)          |
| Stage conversion              | Distinct leads that entered stage N+1 / distinct leads that were in stage N during the period × 100; forward moves only                           | `lead_stage_history` (9)             |
| Time in stage                 | Median time between entering a stage and the next forward move                                                                                    | `lead_stage_history` (9)             |
| Quotation acceptance          | Accepted quotations / quotations decided (accepted + rejected) in the period × 100                                                                | `quotations` (9)                     |
| Counselling attendance        | Completed sessions / (completed + no-show) sessions in the period × 100                                                                           | `appointments` (8–9)                 |
| Message delivery rate         | Messages DELIVERED or READ / messages sent per channel × 100                                                                                      | `outbound_messages` (8)              |
| Admission conversion          | Confirmed admissions from a lead cohort / eligible leads in the cohort × 100; first-contact and closing credit counted separately (D-005, A-005b) | admissions (11–12)                   |
| Recovery conversion           | Recovered leads converted / leads entering recovery × 100                                                                                         | recovery (10)                        |
| Revenue collected             | Verified payments net of refunds in the period, per currency (D-006, D-007)                                                                       | payments, refunds (12)               |
| Outstanding                   | Approved amount due − verified collections − approved credits/refunds, per currency                                                               | fee plans, payments (12)             |
