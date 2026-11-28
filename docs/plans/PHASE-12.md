# Phase 12 plan — Payments and finance

Approved by owner: 2026-11-28 ("approve Phase 12").
Scope: FR-015, D-006, D-007, A-006a, A-007a–c, A-012. Exit gate: payment status cannot be forged by the frontend;
reconciliation tests pass.

O-09 is open (gateway, tax invoices, refund approval levels): the gateway is an interface with a labelled **sandbox**
adapter (never in production), receipts are explicitly _not_ tax invoices, and refund approval is one level with
maker–checker (A-043).

## Fee plan and instalments

- Every admission gets a fee plan in the brand currency (integer minor units): base = accepted quotation total, else
  the course list fee. Default schedule: one instalment due in 7 days (ASSUMED); the schedule can be replaced (equal
  split or custom amounts that add up to the total) until the first payment.
- **Fee adjustments** (concession, penalty, correction) are signed, append-only entries with a reason — `payment.record`
  only. Net fee = base + adjustments.
- Payments are applied to instalments oldest-first; each instalment shows paid / due / overdue. Outstanding = net fee −
  (verified payments − refunds paid) (ASSUMED, A-043).
- A reminder job per instalment due date creates a "Payment follow-up" task for the lead owner when it is still unpaid.

## Payments (append-only)

A `payments` row exists **only for verified money** and is never edited or deleted. It has amount, currency, method,
reference, receipt number (per-brand format, default `{BRAND}-RCPT-{YYYY}-{SEQ:6}`, ASSUMED) and how it was verified:

1. **Gateway**: sales create a payment link → `payment_attempts` (INITIATED → PENDING → SUCCEEDED / FAILED / DISPUTED /
   EXPIRED). Success is accepted **only** from a gateway webhook whose signature is valid (HMAC over the raw body) or
   from server-side reconciliation (`fetchOrder` against the gateway). Browser redirects and client calls never change
   a status. Webhook events are stored once per provider event id (idempotent); amount or currency mismatches are
   flagged, not paid.
2. **Manual** (cash, bank transfer, UPI, cheque, card machine): recorded and verified by Accounts (`payment.record`).

**Reconciliation**: pending attempts older than 10 minutes are checked with the gateway on every scheduler tick; the
reconciliation view lists flagged attempts and gateway successes with no payment.

**D-006**: the first verified payment of at least the brand minimum (default > 0, A-006a) confirms the admission
(Phase 11 step: number, seat, Admission Confirmed, LMS handover). If confirmation is blocked (full batch, approval
required, no batch) the payment stays recorded, admission officers are notified, and they can retry
(`POST /admissions/:id/confirm`, only when a verified payment exists).

## Refunds (A-007a/b)

Request (amount ≤ refundable part of one payment, reason; `refund.request`) → approve or reject (`refund.approve`,
by a different person — maker–checker, ASSUMED) → paid (method, reference, date). The request row is immutable;
decisions are append-only events. When everything paid has been refunded, the admission becomes
`CANCELLED_REFUNDED`, the seat is released and the lead is CLOSED_LOST with reason "Refunded"; a partial refund keeps
the admission confirmed. Original payments are never changed.

## Data (migration `finance`)

`finance_settings` · `fee_plans` · `fee_adjustments` (append-only) · `instalments` · `payment_attempts` ·
`payment_events` (append-only) · `payments` (append-only) · `refunds` (immutable) · `refund_events` (append-only) ·
admission status `CANCELLED_REFUNDED`.

## API

`GET /admissions/:id/finance`, `PUT /fee-plans/:id/schedule`, `POST /fee-plans/:id/adjustments`,
`POST /fee-plans/:id/payment-links`, `GET /payment-attempts/:id`, `POST /payment-attempts/:id/check`,
`POST /fee-plans/:id/payments` (manual), `GET /payments/:id/receipt`, `POST /payments/:id/refunds`,
`POST /refunds/:id/approve|reject|paid`, `POST /webhooks/payments/:provider`, `GET /finance/reconciliation`,
`GET /finance/refunds`, `POST /admissions/:id/confirm`, `GET/PUT /finance-settings`; sandbox checkout pages
(development/test only).

## Web

Admission panel: fees (plan, instalments, outstanding), payment link, record payment, receipts, refunds. Finance page:
pending refunds, reconciliation, settings.

## Tests

Integration: plan from quotation · schedule rules · webhook with a bad signature refused · forged client "success"
changes nothing · valid webhook creates one payment and confirms the admission (D-006) · duplicate webhook ignored ·
amount mismatch flagged · reconciliation pays a missed webhook exactly once · manual payment needs `payment.record` ·
receipts numbered · instalment allocation and outstanding · adjustments append-only and restricted · refund maker–checker,
partial vs full refund (A-007b) · payments/refunds history append-only · blocked confirmation and retry. e2e: record a
manual payment and see the admission confirmed.
