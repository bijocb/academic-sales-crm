# Decision & Assumptions Register

Companion to `docs/SRS.md`. Where this register and the SRS disagree, this register wins (it records later business-owner decisions).

Status: **DECIDED** = confirmed by business owner · **ASSUMED** = default chosen by engineering, can be changed before the phase that depends on it · **OPEN** = must be answered before the phase listed.

## Decided

| ID | Decision | Date |
|---|---|---|
| D-001 | **Multiple organizations (multi-tenant SaaS).** Organization is the tenant. Brands, branches, teams, users and all business records belong to exactly one organization. A platform-level Super Admin sits above organizations. | 2026-11-27 |
| D-002 | **Markets: India and UAE.** Time zones `Asia/Kolkata` and `Asia/Dubai`; currencies INR and AED; phone numbers normalized to E.164 (+91, +971 and others) while keeping the raw value. Time zone, currency and working week are set per brand (default from organization). | 2026-11-27 |
| D-003 | **SLA time is measured on two clocks: calendar minutes and working minutes, stored and shown separately** for every SLA instance, task and report. | 2026-11-27 |
| D-004 | **Person → Lead → Enquiry model.** Person = identity (normalized phone/email). Lead = one open sales record per person per brand (owner, stage, status, SLA, tasks). Enquiry = each inbound submission, immutable attribution (source, campaign, UTM, course interest). Brands work the same person independently. Lost / On Hold / Recovery are a **status** beside the 8-stage pipeline, not stages. | 2026-11-27 |
| D-005 | **Admission credit goes to both the first-contact executive and the closing executive.** | 2026-11-27 |
| D-006 | **Admission is confirmed on the first verified payment of any amount** (advance/token included). | 2026-11-27 |
| D-007 | **Refunds of advances/payments must be recorded** (a student pays an advance and later asks for the money back). | 2026-11-27 |

## Assumptions (engineering defaults)

| ID | Assumption | Relates to |
|---|---|---|
| A-003a | Escalation checkpoints (5/15/30/60) **fire on working minutes by default**; each SLA rule can be switched to calendar minutes. Both clocks are always recorded regardless of which one fires. | D-003 |
| A-003b | A lead received outside working hours is held in the unassigned queue and allocated at the start of the next shift. Calendar clock starts at receipt; working clock starts at the next working minute. | D-003 |
| A-005a | "First-contact executive" = first executive to record a **connected** contact (not just an attempt). "Closing executive" = lead owner when the admission is confirmed. | D-005 |
| A-005b | Reports show **"first-contact admissions"** and **"closed admissions"** as separate metrics, each counted in full (no double-counting inside one metric). Incentive split is configurable per organization; default 50/50 when the two are different people, 100% when the same. | D-005 |
| A-006a | "Verified" = confirmed by payment-gateway webhook/API reconciliation or by an Accounts user's manual verification (FR-015). A browser redirect never counts. Minimum confirming amount is configurable per brand, default > 0. | D-006 |
| A-007a | Refund flow: request (reason, amount) → approval by Accounts (configurable approver) → paid (method, reference, date). Refunds never edit or delete the original payment row. | D-007 |
| A-007b | **Full refund** of all verified payments ⇒ admission moves to `CANCELLED_REFUNDED`, batch seat is released, lead status becomes `CLOSED_LOST` with reason "Refunded". **Partial refund** reduces net revenue; admission stays confirmed. | D-007 |
| A-007c | Reports are event-dated: an admission cancelled in March still counts as an admission in January and as a cancellation in March. "Net admissions" = confirmed − cancelled in the period. Approved incentives are never silently recalculated; refunds create a clawback item for approval (FR-016). | D-007 |
| A-008 | Isolation: organization isolation enforced twice — application data-access layer **and** PostgreSQL row-level security on `organization_id`. Brand/team scope enforced in the application data-access layer and covered by API tests. | D-001 |
| A-009 | Lead owner does not change when counselling or admission work starts; counsellor and admission officer are added as lead participants. | SRS 2, FR-011 |
| A-010 | Default maximum automatic reassignment attempts = 3 (diagram: attempt 2 at 30 min, attempt 3 at 60 min), then manager priority queue. Previous owners of the same lead are excluded. | FR-007 |
| A-011 | Default first-response rule: a logged call attempt resolves the 5- and 15-minute checkpoints; connected contact is tracked separately (contact rate). Changeable per brand. | SRS 14 |
| A-012 | Multi-currency reports show INR and AED separately. Consolidated cross-currency totals are not shown until an FX policy is decided. | D-002 |

## Open — needed before the phase shown

| ID | Question | Needed by |
|---|---|---|
| O-01 | GitHub repository for this project. | Phase 1 |
| O-02 | Hosting provider and region; data-residency requirements for India (DPDP Act 2023) and UAE (PDPL, plus DIFC/ADGM rules if any organization is in a free zone). | Phase 1 / 15 |
| O-03 | Login method (email + password only, or Google/Microsoft SSO); which roles must use MFA. | Phase 2 |
| O-04 | Which lead sources go live first; Meta and Google ad accounts available for integration. | Phase 4 |
| O-05 | How executive availability is set (manual toggle, shift timetable, leave records). | Phase 6 |
| O-06 | Telephony provider(s) for India and UAE; WhatsApp Business provider; email provider. | Phase 8 |
| O-07 | Recovery rules: attempts, cooldown, expiry. | Phase 10 |
| O-08 | Document checklist per course; LMS product and API. | Phase 11 |
| O-09 | Payment gateways (India e.g. Razorpay/Cashfree/PayU; UAE e.g. Telr/Network International/Stripe/Checkout.com). Are GST (India) / VAT (UAE) tax invoices required from the CRM? Refund approval levels. | Phase 12 |
| O-10 | Incentive rules; FX policy for consolidated reports; source of ad-spend data for CPL/CPA (API sync or manual entry). | Phase 13 |
| O-11 | Data retention periods and consent wording per country. | Phase 15 |
