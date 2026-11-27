# Phase 5 plan — Duplicate detection, safe merge, lead workspace

Approved by owner: 2026-11-27. Scope: SRS §12 Phase 5, FR-005 (duplicates/merge), lead detail + timeline foundation.
Exit gate: duplicate and multi-enquiry scenarios pass.

## Enquiry classification (FR-005)

| Classification           | When                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| NEW_LEAD                 | Person never seen before in the organization                                                                                |
| EXISTING_PERSON          | Known person (via another brand or an earlier record), first lead in this brand                                             |
| EXISTING_LEAD            | New enquiry on the person's active lead in this brand                                                                       |
| CROSS_CHANNEL_DUPLICATE  | Same active lead, different channel, within 24 h of the previous enquiry (e.g. Google form + website form for one ad click) |
| RETURNING_LEAD           | Earlier lead in this brand was closed                                                                                       |
| (same-enquiry duplicate) | Exact replay — already absorbed by the Phase 4 idempotency key, nothing stored                                              |

## Duplicate suggestions (never auto-merged)

Exact phone matching already prevents most duplicates. Candidates for human review are scored:
same email (0.6) · phone differs by one digit or a swapped pair (0.5) · same normalized name (0.3) ·
shared name word (0.15) · same city with same name (0.1). Pairs scoring ≥ 0.6 enter the review queue.
Detection runs whenever a person is created or their contact details change; a dismissed pair is never re-raised.

## Safe merge (`lead.merge` over every brand involved)

- Preview shows both people, their leads per brand and exactly what will happen.
- The user picks the surviving person and, per field, which name / phone / email / city to keep.
- The other person is **not deleted**: marked `merged_into`, original IDs kept; future enquiries with their old
  phone/email resolve to the survivor.
- Leads: in a brand where both have an active lead, the newer one becomes `MERGED` into the older one (counts and
  dates combined); other leads move to the survivor. Enquiries and their attribution are never modified.
- Recorded in `person_merges`, lead timeline events, audit log and outbox (`person.merged`). One transaction with locks.

## Lead workspace

- Lead page `/leads/:id`: profile, original attribution, status/stage, combined enquiry history (including merged leads),
  possible-duplicate warning, notes, profile edit (phone changes checked against other people).
- Timeline foundation: append-only `lead_events` (NOTE, PROFILE_UPDATED, MERGED, …) + enquiries, in one ordered feed.
  Phase 8 activities (calls/WhatsApp/email) will join the same feed.
- Duplicates review page: side-by-side comparison, merge or "not a duplicate".

## Data (migration `duplicates_and_timeline`)

`persons` + `name_key`, `merged_into_id`, `merged_at` (phone unique only among unmerged people) · `leads` + status
`MERGED`, `merged_into_lead_id` · enquiry classification values · `duplicate_candidates` · `person_merges` ·
`lead_events` (append-only).

## Tests

Unit: name normalization, phone near-match, scoring. Integration: every classification, candidate creation and
non-creation, merge plan + execution, attribution untouched, post-merge intake resolves to survivor, permissions,
dismissal sticks, timeline/notes, phone-conflict on edit. E2E: review and merge a suggested duplicate.
