# User acceptance test (UAT) script

Run on a **staging** deployment with production settings and real-looking (not real) data, by people in each role.
Mark each case Pass / Fail and note the defect. Go-live needs every **Must** case passed and the sign-off at the end
(SRS Phase 15 exit gate). Automated tests already cover these flows (`docs/plans/PHASE-*.md`); UAT confirms they fit
how the teams work.

Accounts: one user per role per brand (India and UAE): Org admin, Brand manager, Sales manager, Team leader, Sales
executive (×2), Counsellor, Admission officer, Accounts officer (×2), Marketing manager, Management viewer.

## 0. Smoke (after every deploy) — Must

| #   | Case                                     | Expected                                                  | Result |
| --- | ---------------------------------------- | --------------------------------------------------------- | ------ |
| 0.1 | Open the site, sign in, sign out         | Dashboard shows your numbers; sign-out returns to sign-in |        |
| 0.2 | `/api/v1/health`                         | `status: ok`                                              |        |
| 0.3 | Scheduler run in GitHub Actions is green | Tick and status checks pass                               |        |

## 1. Access and administration — Must

| #   | Role        | Case                                                         | Expected                                                 | Result |
| --- | ----------- | ------------------------------------------------------------ | -------------------------------------------------------- | ------ |
| 1.1 | Org admin   | Invite a user, assign a role with brand / team scope         | Invite e-mail arrives; user sets a password and signs in |        |
| 1.2 | Any         | Five wrong passwords                                         | Account locked for 15 minutes; reset by e-mail works     |        |
| 1.3 | Executive   | Open another team's lead by URL                              | "Not found"                                              |        |
| 1.4 | UAE manager | Look for India brand leads, reports or settings              | Not visible                                              |        |
| 1.5 | Org admin   | Audit log shows role changes, assignments, exports, payments | Entries with who / when / before / after                 |        |

## 2. Lead capture and allocation — Must

| #   | Role          | Case                                                                    | Expected                                                           | Result |
| --- | ------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| 2.1 | Marketing     | Website form / intake API, Google Ads and CSV import each create a lead | Lead with source, campaign, UTM; rejected rows listed with reasons |        |
| 2.2 | Marketing     | Same phone again within the window                                      | No second lead; the enquiry is added to the existing lead          |        |
| 2.3 | Brand manager | Allocation rule by course / language; executive on leave or at capacity | Lead goes to the right available executive; history shows why      |        |
| 2.4 | Brand manager | Reassign with a reason                                                  | Both owners kept in history; both notified                         |        |
| 2.5 | Admin         | Possible duplicates: merge two leads                                    | One lead with both histories; merge is audited                     |        |

## 3. Working leads and SLA — Must

| #   | Role        | Case                                                                        | Expected                                                                     | Result |
| --- | ----------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| 3.1 | Executive   | New lead: first-call task; log a call                                       | First-response SLA resolved; working and calendar minutes shown              |        |
| 3.2 | Team leader | Leave a lead uncalled past the SLA                                          | Reminders, then breach and escalation per brand policy; SLA monitor shows it |        |
| 3.3 | Executive   | WhatsApp / e-mail from a template; book counselling                         | In the timeline; opt-out respected                                           |        |
| 3.4 | Executive   | Move through stages; required fields enforced; backward move needs a reason | Stage history kept                                                           |        |
| 3.5 | Executive   | Quotation: issue, student accepts                                           | Terms fixed after issue                                                      |        |
| 3.6 | Executive   | Mark lost with a reason → recovery after the cooldown                       | Recovery attempts, then reopen or close as lost                              |        |

## 4. Admission and payments — Must

| #   | Role              | Case                                                          | Expected                                                                           | Result |
| --- | ----------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| 4.1 | Admission officer | Start an admission, upload documents (PDF/JPG ≤ 4 MB), review | Checklist status; downloads work only through short-lived links                    |        |
| 4.2 | Accounts          | Record a manual payment (UPI / bank)                          | Receipt numbered (not a tax invoice); first payment confirms the admission (D-006) |        |
| 4.3 | Accounts          | Instalment schedule and a concession adjustment               | Outstanding correct; adjustment needs a reason                                     |        |
| 4.4 | Accounts ×2       | Refund: one requests, the other approves and pays             | Same person cannot approve; full refund cancels the admission and frees the seat   |        |
| 4.5 | Accounts          | Try to change or delete a payment                             | Not possible                                                                       |        |

## 5. Reports, targets, incentives, AI — Must

| #   | Role          | Case                                                                                         | Expected                                                                       | Result |
| --- | ------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| 5.1 | Brand manager | Reports for last month: compare 5 numbers with your own records (leads, admissions, revenue) | Match; click a number → the same count of records                              |        |
| 5.2 | Executive     | Home dashboard                                                                               | Only own numbers and targets                                                   |        |
| 5.3 | Brand manager | CSV export                                                                                   | Opens in Excel; export is in the audit log                                     |        |
| 5.4 | Sales manager | Target and incentive preview; another manager approves                                       | Split 50/50 first contact / closer; approved run cannot change                 |        |
| 5.5 | Brand manager | Switch on AI assistance; open a lead                                                         | Advisory score with factors; override needs a reason; suggestions create tasks |        |

## 6. Non-functional — Should

| #   | Case                                                                                 | Expected                                           | Result |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------- | ------ |
| 6.1 | Phone (Android / iPhone) and tablet: leads list, lead page, log a call               | Usable without horizontal scrolling of the page    |        |
| 6.2 | Chrome, Edge, Firefox, Safari (current)                                              | Same behaviour                                     |        |
| 6.3 | A11Y: keyboard only (Tab / Enter) through sign-in, new lead, log a call              | Every control reachable, focus visible             |        |
| 6.4 | A11Y: screen reader (NVDA or VoiceOver) on the lead page; zoom to 200 %              | Labels read correctly; content reflows             |        |
| 6.5 | Time zones: an IST user and a GST user see the same appointment at their local times | Correct local times; brand working hours respected |        |
| 6.6 | Busy hour: 20+ people working at once                                                | Lists and lead pages respond within ~2 s           |        |

## Defects

| #   | Case | Description | Severity (blocker / major / minor) | Owner | Status |
| --- | ---- | ----------- | ---------------------------------- | ----- | ------ |
|     |      |             |                                    |       |        |

## Sign-off

| Role                         | Name | Decision (accept / accept with listed minor defects / reject) | Date | Signature |
| ---------------------------- | ---- | ------------------------------------------------------------- | ---- | --------- |
| Business owner               |      |                                                               |      |           |
| Sales head (India)           |      |                                                               |      |           |
| Sales head (UAE)             |      |                                                               |      |           |
| Admissions / Accounts lead   |      |                                                               |      |           |
| IT / data protection contact |      |                                                               |      |           |
