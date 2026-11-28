# AI assistance — privacy, bias and safety review

Scope: Phase 14 (FR-006, FR-021, SRS §8). Decision A-045; open item O-13. Reviewed 2026-11-28.
Code: `apps/api/src/ai/` (`scoring.ts`, `features.ts`, `ai.service.ts`). Tests: `src/ai/scoring.spec.ts`, `test/ai.int-spec.ts`.

## 1. What it does

| Feature                | How                                                                                                | Human control                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Lead priority (FR-006) | Per-brand naive Bayes model calibrated on the brand's own converted vs lost leads of the last year | Advisory only; anyone who can edit the lead overrides the band with a reason |
| Fallback               | Transparent rule points (`rules-v1`) when there is no usable model or scoring fails                | Labelled "Using simple rules" with the reason                                |
| Next-best actions      | Deterministic rules (call, follow-up, counselling, quotation) with a stated reason                 | Accept creates a task; dismiss is recorded                                   |
| Course suggestion      | Course most often chosen by converted students from the same source (needs ≥ 5)                    | **Requires approval**; only then the lead's course is set (audited)          |

Nothing is automated beyond creating a task the user asked for. The CRM makes no eligibility, fee, admission or
rejection decision from a score. Scores never block, reassign or close a lead.

## 2. Data minimisation (SRS §8, FR-021)

- **No external AI provider is used.** No lead, person or student data leaves the CRM for AI purposes. Using a provider
  (for example to summarise call notes) needs the owner's approval of purpose, provider terms and safeguards first
  (O-13). It would then be added behind a provider interface, switched off by default, and sent only the minimum fields.
- The model reads only these factors, all observed in the first 3 days after the lead is created: source channel, paid
  campaign (yes/no), course chosen at enquiry (yes/no), number of enquiries (1 / 2 / 3+), first-response SLA (on
  time / late / none), and whether a call connected within 3 days.
- `extractFeatures` never queries the `persons` table, the owner, notes or message text. The `Features` type has no
  field that could hold personal data.

## 3. Bias review

| Excluded attribute                                | Why                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Name, phone (including country code), e-mail      | Personal data; names and country codes stand in for ethnicity and nationality |
| City / location, language                         | Can stand in for protected attributes (FR-006 keeps them as tags only)        |
| Age, gender, nationality, religion, qualification | Protected or sensitive (FR-006: never inferred for scoring)                   |
| Owner, counsellor                                 | Would score staff, not the enquiry                                            |
| Notes, messages                                   | Free text may contain anything                                                |

Checks, run on every CI build:

1. `scoring.spec.ts` — the factor list is exactly the six above, and none of the prohibited attributes is a factor.
2. `ai.int-spec.ts` — two leads that differ only in name, phone country (+91 / +971), city, language and e-mail get
   identical probabilities, factors and bands.
3. Outcome leakage — training uses only the first 3 days, so later events (quotation, payment) cannot inflate scores.

Known limits: a channel or campaign can correlate with a region. These factors are kept because they are
business-relevant and visible to users. Managers should review band distributions by brand and source before relying
on them for workload decisions. The score is an estimate from past outcomes, so past bias in follow-up effort can carry
forward. For that reason the score is advisory, and overrides are recorded so they can be reviewed.

## 4. Explainability

Every score shows the probability (or the rule score), the band, a confidence level based on training size (LOW < 150,
MEDIUM < 500, HIGH), the model version, the training sample and date, and each factor's contribution. For the model,
base rate + Σ contributions = the log-odds of the shown probability (tested). Wording on screen: "Advisory only … not a
guarantee. People decide."

## 5. Outage and fallback (exit gate)

- AI switched off for the brand (default) → the lead page shows no AI panel; nothing else changes.
- No usable model (fewer than `min_training_size` decided leads (default 50), or fewer than 5 conversions or 5 losses)
  → the labelled rules are used.
- Scoring error → rules with "The scoring model is unavailable right now". If even that fails, a plain message is shown.
  The lead page loads the panel separately, so an AI error never breaks it (tested).
- Scheduling errors are caught in the scheduler tick, so they never stop jobs, allocation or payment reconciliation.

## 6. Audit and retention

- Audited: settings changes (`ai_settings.updated`), manual training (`ai_model.trained`), overrides
  (`lead_priority.overridden`), approved course suggestions (`ai_suggestion.course_approved`).
- Append-only history: `ai_models`, `lead_scores` (a row only when the result changes), `lead_score_overrides`,
  `ai_suggestion_events`.
- Retention follows the lead's retention (O-11). The tables hold no personal data beyond the lead id; factor values are
  the coarse categories above.
