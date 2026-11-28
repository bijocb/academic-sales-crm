# LMS / batch handover contract (v1)

When an admission is **confirmed** (D-006: first verified payment), the CRM creates one handover per admission
(`lms_handovers`) and sends it to the connected LMS. No LMS is chosen yet (O-08): until one is, handovers stay
**PENDING** and admission officers export the details and press **Mark handed over** (`DONE_MANUALLY`, audited).

## Delivery

- Background job `lms.handover` (key `lms:<handoverId>` — sent at most once per admission), retried with backoff
  (5 attempts), then `FAILED` and visible on the SLA monitor's failed-jobs list for a retry.
- Transport (to be fixed with the chosen LMS): `POST {LMS_BASE_URL}/enrolments` with a bearer token stored as a
  network secret, `Idempotency-Key: <admissionId>`. A 2xx response with `{ "id": "<lms enrolment id>" }` marks the
  handover `SENT` with that reference.
- Optional acknowledgement webhook from the LMS (`ACKNOWLEDGED`), signed with a shared secret — to be added with the
  real adapter.

## Payload

```json
{
  "version": 1,
  "admissionId": "uuid",
  "admissionNumber": "ACAD-IN-2026-00001",
  "confirmedAt": "2026-12-01T06:30:00.000Z",
  "brand": { "id": "uuid", "code": "ACAD-IN", "name": "Academy India" },
  "course": { "id": "uuid", "code": "DS-PRO", "name": "Data Science Professional" },
  "batch": { "id": "uuid", "code": "DS-JAN", "name": "January weekend", "startDate": "2027-01-09" },
  "student": {
    "id": "uuid",
    "legalName": "Ananya Menon",
    "email": "ananya@example.com",
    "phone": "+919846000001",
    "dateOfBirth": "2004-05-17"
  }
}
```

Data minimisation: identity-document numbers, guardian details and documents are **not** sent. Times are UTC ISO-8601;
dates are `YYYY-MM-DD`. Adding fields is backwards compatible; removing or renaming one needs `version: 2`.
