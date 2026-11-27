# Phase 8 plan — Sales engagement

Approved by owner: 2026-11-27 ("Approve Phase 8").
Scope: SRS §12 Phase 8, FR-010, §9.1 (lead workspace actions). Exit gate: activity history and provider failure tests
pass.

Providers are not chosen yet (O-06), so every external channel sits behind an interface with a clearly labelled
**sandbox** adapter that only runs outside production (rule 10). In production, channels without a real provider are
shown as "not configured"; manual logging always works.

## Activities (append-only interaction history)

`activities` — one row per interaction, never updated or deleted: type CALL / WHATSAPP / EMAIL / SMS, direction
(outbound / inbound), actor, when, start/end/duration (calls), outcome, subject/body, template, provider and provider
reference, linked task. The lead timeline shows activities beside enquiries and lead events.

- **Manual call log:** direction, start time, duration, outcome (same outcomes as call tasks), notes, optional provider
  reference. An outbound call attempt resolves the first-response SLA (A-011).
- **Completing a call task** also writes a CALL activity, so every call appears once in the history.
- **Click-to-call:** `TelephonyProvider.dial(agent, customer)` → provider reference; the user then logs the outcome.
  Sandbox adapter only; production returns `TELEPHONY_NOT_CONFIGURED` until a provider is chosen.
- **No call recordings are stored** (FR-010) until consent, retention and access rules are approved.

## Messages (WhatsApp, email)

- `message_templates` per brand and channel, with `{{first_name}}`, `{{course}}`, `{{owner_name}}`, `{{brand}}`
  placeholders; status DRAFT / APPROVED / ARCHIVED. WhatsApp outbound **requires an approved template** (ASSUMED:
  approval is recorded in the CRM by a manager after the provider approves it; provider sync comes with the real
  provider). Email may use a template or free text.
- Sending = activity (append-only) + `outbound_messages` row (QUEUED → SENT → DELIVERED → READ, or FAILED) + a job.
  The job calls the provider: success → SENT with provider reference; temporary failure → retried with backoff;
  permanent failure (invalid number, rejected) → FAILED at once; retries exhausted → FAILED and the job is DEAD.
  The sender is notified of failures.
- Delivery receipts arrive through a provider webhook; status only moves forward (late or out-of-order receipts are
  ignored); every receipt is stored in `message_events` (append-only).
- **Opt-out:** a person marked do-not-contact cannot be messaged (409 `OPTED_OUT`). An inbound "STOP" (WhatsApp) or a
  manual opt-out on the lead page sets it, with reason, time and actor (audited). Calls stay possible but are flagged.
- Email uses the existing mail service (SMTP; log-only mailer in the demo). Attachments wait for document storage
  (Phase 11).

## Appointments (counselling)

`appointments`: lead, counsellor, start, duration, mode (in person / phone / video), location or link, status
SCHEDULED / COMPLETED / NO_SHOW / CANCELLED, outcome summary. Overlapping appointments for the same counsellor are
refused. Reschedule and cancel (reason) keep history in lead events. A reminder job notifies the counsellor and the
lead owner 60 minutes before (ASSUMED default).

## API

`POST /leads/:id/calls`, `POST /leads/:id/calls/dial`, `POST /leads/:id/messages`, `GET /leads/:id/messages`,
`POST /leads/:id/contact-preference`, `GET/POST/PATCH /message-templates`, `GET /appointments`,
`POST /leads/:id/appointments`, `POST /appointments/:id/complete|cancel|reschedule`,
`POST /webhooks/sandbox/whatsapp` (dev/test only), `GET /engagement/providers` (which channels are live).

## Web

Lead page actions: Log call, Call (when telephony exists), WhatsApp, Email, Schedule appointment, opt-out switch;
message status on the timeline. Templates page. Appointments list ("My appointments").

## Tests

Integration: manual call log (history + SLA resolution) · call task completion writes one activity · activities are
append-only (database refuses update/delete) · WhatsApp needs an approved template; placeholders render · opt-out
blocks sending and inbound STOP sets it · temporary provider failure retries then SENT · repeated failure → FAILED +
DEAD + sender notified · permanent failure → FAILED without retry · delivery receipts move forward only · email send
and failure · telephony not configured in production mode · appointment overlap, complete, no-show, cancel, reminder
job · permissions (out-of-scope lead 404). e2e: log a call and schedule an appointment from the lead page.
