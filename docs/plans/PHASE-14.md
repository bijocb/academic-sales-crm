# Phase 14 plan — AI assistance

Approved by owner: 2026-11-28 ("Yes" to Phase 14).
Scope: FR-006 (scoring, explainability, override), FR-021, SRS §8 (no personal data to AI services without approval).
Exit gate: AI outage fallback, audit and bias/safety review pass.

## Approach (A-045, ASSUMED)

No external AI provider is used. SRS §8 forbids sending personal or student data to AI services until the purpose,
provider terms and safeguards are approved, and none have been (**O-13**). Everything runs inside the CRM, on CRM data,
and is fully explainable:

- **Lead priority score**: a per-brand model calibrated on the brand's own historical outcomes (naive Bayes with Laplace
  smoothing over a fixed list of non-personal factors). Each factor's contribution to the log-odds is shown, together
  with the probability, a confidence level, the training sample size and the model version.
- **Fallback**: when AI is off, there is not enough history (fewer than 50 decided leads, or fewer than 5 conversions or
  5 losses), or scoring fails, a transparent rule-based score (`rules-v1`) is shown instead, labelled as such. Lead pages
  and lists never depend on AI: if the AI endpoint errors, the panel says so and the rest of the page works.
- **Next-best actions**: deterministic rules with a stated reason. Accepting creates a task for the lead owner; a course
  suggestion needs explicit human approval and only then sets the lead's course (audited). Dismissals are recorded.

## Factors (fixed list, bias review)

Only engagement and enquiry facts observed in the **first 3 days** after the lead is created (so the score is
comparable for new leads, and outcomes cannot leak into training):

source channel · paid campaign (yes/no) · course chosen at enquiry (yes/no) · repeat enquiry (1 / 2 / 3+) ·
first-response SLA (on time / late / none) · connected within 3 days (yes/no).

**Never used**: name, phone or e-mail (including country code), city or location, language, age, gender, nationality,
religion, qualification, notes or message text, the owner or counsellor. Location and language stay classification tags
(FR-006) but are excluded from scoring because they can stand in for protected attributes. A test proves that leads
differing only in personal attributes get identical scores and factors.

## Settings (per brand, `settings.manage`)

`enabled` (default **off**, A-045) · scoring on/off · next actions on/off · High threshold (default 25 %) · Medium
threshold (default 10 %) · minimum decided leads to train (default 50). Changes are audited.

## Data (migration `ai`)

- `ai_settings` (one per brand, back-filled by `ensureBrandDefaults`).
- `ai_models` — **append-only** trained versions: sample size, conversions, factor statistics, trained at.
- `lead_scores` — **append-only**: score 0–100, band, probability, confidence, method (MODEL / RULES), model version,
  factors; a new row only when the result changes.
- `lead_score_overrides` — **append-only**: band, reason (required), by whom; the latest override wins until the next
  one. `leads.priority_band` / `priority_score` hold the effective value for sorting lists.
- `ai_suggestion_events` — **append-only**: accepted / dismissed, kind, reason, created task or course.

## Jobs

`ai.train` per brand per day and `ai.rescore` per brand per hour (open leads, at most 500 per run), enqueued from the
scheduler tick with deterministic keys; idempotent and retried like every job.

## API

`GET /leads/:id/ai` (score, factors, override, suggestions; `{enabled:false}` when off) ·
`POST /leads/:id/ai/override` (`lead.edit`) · `POST /leads/:id/ai/suggestions/:kind/accept|dismiss` ·
`GET/PUT /ai-settings?brandId` · `POST /ai-settings/:brandId/train` · `GET /ai-models?brandId`.
Lead list: `priority` column and `sort=priority`.

## Web

Lead page "AI assistance" panel (advisory wording, factors, confidence, model version, override with reason, next actions
with Accept / Dismiss, course suggestion with Approve). Lead list priority badge and sort. Settings: AI section per brand
with model status and "Train now".

## Tests

Integration: training and probability match a hand-computed fixture · factor contributions add up to the logit ·
identical scores for leads differing only in personal data · fallback when disabled, untrained or failing · override
needs a reason and permission, is append-only and audited, and drives list sorting · suggestions: accept creates one task
(idempotent), course suggestion only after approval, dismiss recorded · jobs idempotent · out-of-scope lead 404.
e2e: see the AI panel and override the band. Docs: `docs/AI-REVIEW.md` (data minimisation, retention, bias review).
