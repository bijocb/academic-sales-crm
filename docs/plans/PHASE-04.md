# Phase 4 plan — Lead capture and import

Approved by owner: 2026-11-27. Scope: SRS §12 Phase 4 (FR-003, FR-004; identity part of FR-005).
Exit gate: idempotency, validation and import tests pass.

## Data model (D-004: Person → Lead → Enquiry)

| Table               | Purpose                                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persons`           | Identity per organization: name, phone (E.164 + raw), email, preferred language, `do_not_contact`. One person per normalized phone per org (A-021).                                                                                                                  |
| `leads`             | Sales record per person per brand: lead number, stage (8 diagram keys), status (OPEN / ON_HOLD / LOST / IN_RECOVERY / CLOSED_LOST / CONVERTED), owner (empty until Phase 6), course interest, first/last enquiry time. At most one active lead per person per brand. |
| `enquiries`         | **Append-only** submission record: channel, source, campaign, UTM fields, ad/form IDs, landing page, course interest, message, consent, raw values as submitted, dedup key. Never updated (trigger).                                                                 |
| `lead_sources`      | Per brand: name, channel (META_ADS, GOOGLE_ADS, WEBSITE, WHATSAPP, CALL, REFERRAL, EVENT, IMPORT, MANUAL, OTHER), paid/organic.                                                                                                                                      |
| `campaigns`         | Per brand: name, UTM campaign code, external ID, dates, status.                                                                                                                                                                                                      |
| `intake_keys`       | Per-source API keys for website/landing-page posts and Google lead-form webhooks (hashed; shown once).                                                                                                                                                               |
| `intake_exceptions` | Invalid submissions with errors — never discarded silently; resolve (fix & resubmit) or discard with reason.                                                                                                                                                         |
| `lead_imports`      | CSV/XLSX import batches with counters and duplicate policy.                                                                                                                                                                                                          |
| `outbox_events`     | `lead.created` / `enquiry.received` written in the same transaction (consumed by allocation in Phase 6).                                                                                                                                                             |
| `org_counters`      | Per-organization sequence for human-readable lead numbers (L-000001).                                                                                                                                                                                                |

All tenant tables: `organization_id`, RLS, composite FKs.

## Intake pipeline (one code path for every channel)

1. Idempotency — dedup key = provider/external ID, import row (`import:<id>:<row>`), or SHA-256 of the canonical payload. Same key ⇒ same result, nothing new created.
2. Validate — name; phone or email; phone normalized with the brand country as default (India/UAE); email format. Failures ⇒ `intake_exceptions`.
3. Resolve person — exact normalized phone, else exact email (fuzzy matching is Phase 5).
4. Resolve lead — active lead for person+brand gets a new enquiry (classification EXISTING_LEAD); otherwise a new lead (NEW, or RETURNING if an earlier lead was closed).
5. Write enquiry (immutable attribution), audit, outbox event — one transaction; unique-key races retried once.

## Channels in this phase

- **Intake API** `POST /api/v1/intake/leads` with `Authorization: Bearer <intake key>` — website forms, landing pages, Zapier/Make bridges.
- **Google Ads lead-form webhook** `POST /api/v1/webhooks/google-ads/:keyId` — verifies `google_key`, maps `user_column_data`.
- **Manual entry** `POST /leads` (staff).
- **CSV/XLSX import** — browser parses and maps columns; server validates (dry run) and imports in chunks of ≤ 500 rows; failed rows go to the exception queue; downloadable error report.
- Meta Lead Ads and WhatsApp need the owner's Meta app / WhatsApp Business account (O-04, O-06): deferred; no fake connector in production paths.

## API

`/lead-sources`, `/campaigns`, `/intake-keys` (create/list/revoke), `/intake/leads`, `/webhooks/google-ads/:keyId`,
`/leads` (list, get with enquiries, manual create), `/intake-exceptions` (list, resolve, discard),
`/lead-imports` (validate, create, rows, complete, get).

Permissions: `lead.read` / `lead.read_own`, `lead.create`, `lead.import`, `campaign.manage`, `integration.manage`, `pii.view_full`
(phones/emails masked without it).

## Web

Leads list + detail (enquiry timeline), New lead, Import wizard (upload → map → validate → import → report),
Exception queue, Sources & campaigns (with intake keys and copy-paste example).

## Tests

Unit: phone/email normalization, dedup key, CSV mapping. Integration: intake idempotency (replay), invalid → exception,
existing person new enquiry, returning lead, cross-brand separation, key revocation, Google webhook, import with
duplicates/invalid rows and retry safety, permissions/masking, enquiry immutability. E2E: manual lead + import.
