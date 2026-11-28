# Phase 11 plan — Student, admission and documents

Approved by owner: 2026-11-28 ("Approve Phase 11").
Scope: FR-013 (capacity), FR-014, SRS §3.2 (Admission Confirmed), §9 security (documents). Exit gate: admission
workflow and capacity checks pass.

O-08 (document checklist per course, LMS product) is open: checklists are editable per brand and course with ASSUMED
defaults, and the LMS handover is a documented contract with a manual fallback (A-041, A-042).

## Admission workflow

`DRAFT → DOCUMENTS_PENDING ⇄ UNDER_VERIFICATION → APPROVED → CONFIRMED`, plus `DEFERRED` and `CANCELLED`.

- **Start admission** (sales with `lead.edit` + `pipeline.transition`, or `admission.manage`) on an open lead with a
  course and batch — taken from the accepted quotation when there is one. Creates or links the **student profile**
  (one per person) and the document checklist for the course.
- The document phase is automatic: any required document missing or rejected → DOCUMENTS_PENDING; all required
  documents submitted and some not yet checked → UNDER_VERIFICATION; all required verified → ready for approval.
- **Approve** (`admission.manage`): needs every required document verified; **holds a batch seat**. A full batch is
  refused unless an authorised override is recorded (`course.manage` + reason) — FR-013.
- **Confirm**: per **D-006** the first verified payment confirms the admission (Phase 12 calls this step). It
  generates the **admission number**, holds a seat (capacity check again if it was not approved first), moves the lead
  to the system stage _Admission Confirmed_ and status CONVERTED, and starts the LMS handover. ASSUMED (A-041): by
  default confirmation does not wait for documents (D-006); a brand can require approval first.
- **Defer** (reason, optional later batch) releases the seat; **resume** continues. **Cancel** (reason) releases the
  seat; cancelling a confirmed admission belongs to the refund flow (Phase 12, A-007b).
- Every status change is an append-only `admission_status_history` row, an audit entry and a lead timeline event.

## Admission number

Per-brand format with tokens `{BRAND}`, `{YYYY}`, `{YY}`, `{SEQ:n}`; default `{BRAND}-{YYYY}-{SEQ:5}` (e.g.
`ACAD-IN-2026-00001`, ASSUMED). Sequence per brand and year; unique per organization.

## Documents

- **Document types** per brand (code, label, required by default, accepted file types). ASSUMED defaults: passport-size
  photo, government ID (Aadhaar / Emirates ID / passport), highest qualification certificate or mark sheet (all
  required); address proof, passport and visa copy (optional). Each course can mark types required or optional.
- **Upload** (sales or admission officer): PDF, JPG, PNG, WEBP up to 4 MB (the hosting request limit). Files are
  versioned — a re-upload never deletes the earlier file (append-only `document_files`, SHA-256 stored).
- **Verify / reject with reason** (`admission.manage`); every decision is an append-only `document_reviews` row.
- **Viewing** needs `document.view`. Downloads use short-lived signed links (5 minutes, HMAC), served with
  `Content-Disposition: attachment` and `nosniff`; every download is audited.
- **Storage** (ASSUMED A-042): file contents in PostgreSQL behind a `DocumentStorage` interface so an S3-compatible
  store with signed URLs can replace it without changing the API. Retention and deletion rules stay open (O-11).

## Batch handover and LMS contract

On confirmation an `lms_handovers` row is created with a snapshot (student, course, batch, admission number) and a job
sends it through `LmsProvider`. No LMS is chosen (O-08): production keeps the handover **pending for manual handover**
(admission officers export it and mark it handed over); a labelled sandbox provider runs only in development and tests.
The payload and acknowledgement are documented in `docs/LMS-CONTRACT.md`.

## Data (migration `admissions`)

`students` · `admission_settings` · `document_types` · `course_document_requirements` · `admissions` ·
`admission_status_history` (append-only) · `admission_documents` · `document_files` (append-only) · `document_blobs` ·
`document_reviews` (append-only) · `lms_handovers`.

## API

`POST /leads/:id/admission`, `GET /admissions`, `GET /admissions/:id`, `GET /leads/:id/admission`,
`PATCH /admissions/:id/student`, `POST /admissions/:id/approve|defer|resume|cancel`, `PATCH /admissions/:id/batch`,
`POST /admissions/:id/documents/:typeId` (multipart), `POST /admission-documents/:id/verify|reject`,
`POST /document-files/:id/link`, `GET /documents/download?token=`, `GET/POST/PATCH /document-types`,
`GET/PUT /courses/:id/document-requirements`, `GET/PUT /admission-settings`, `GET /admissions/:id/handover`,
`POST /lms-handovers/:id/mark-done`, `GET /batches/:id/seats`.

## Web

Lead page: "Start admission" and an admission panel (status, checklist with upload/verify/reject, approve, defer,
cancel, student profile). Admissions page (queue by status). Settings: document types, course checklists, admission
number format.

## Tests

Integration: start admission from an accepted quotation (student linked, checklist built) · document phase moves
automatically · upload limits and file types · versioned re-upload · verify/reject with reason · approval needs all
required documents · seat capacity: full batch refused, override recorded · confirm generates sequential admission
numbers, sets the system stage and CONVERTED, creates the handover · defer/cancel release seats · signed links expire
and require `document.view` · append-only history tables · scope (out-of-scope admission 404). e2e: start an admission,
upload a document, verify it.
