# AI assistance for team leaders and management (A-051, A-052)

Owner request (2026-11-28): "AI for the assistance of the team leader and management for reporting and assistance".
Owner choices: **both layers**; data sent to the AI provider = **aggregates only**; weekly brief and digest for **team
leaders, brand managers and org admins / management**.

## Layer 1: insights engine (A-051), in-house, no outside AI

- `apps/api/src/insights/rules.ts`: pure functions. Input: the report summary for the period and the previous period of
  the same length, the executive breakdown, the source and campaign breakdowns with ad spend, and target progress.
  Output: a list of insights `{ key, kind, severity, subject, title, detail, evidence, action }`.
- Rules (thresholds ASSUMED, recorded in DECISIONS):

  | Kind                   | Fires when                                                                                        | Severity                    |
  | ---------------------- | ------------------------------------------------------------------------------------------------- | --------------------------- |
  | `FIRST_RESPONSE_DROP`  | first response within target down ≥ 10 points vs previous period (≥ 10 SLA starts in each period) | HIGH if ≥ 20 points         |
  | `CONTACT_RATE_DROP`    | contact rate down ≥ 10 points (≥ 10 leads in each cohort)                                         | HIGH if ≥ 20 points         |
  | `ADMISSIONS_DROP`      | confirmed admissions down ≥ 25 % (≥ 4 in the previous period)                                     | HIGH if ≥ 50 %              |
  | `EXEC_OVERDUE`         | an executive has ≥ 5 overdue tasks and ≥ 2× the team median                                       | HIGH if ≥ 4× median or ≥ 20 |
  | `EXEC_LOW_CONTACT`     | an executive's contacted / assigned is ≥ 15 points below the scope's rate (≥ 10 assigned)         | MEDIUM                      |
  | `EXEC_SLA_BREACHES`    | ≥ 30 % of an executive's first responses missed the target (≥ 5 SLA starts)                       | HIGH if ≥ 50 %              |
  | `SOURCE_COST_SPIKE`    | a source's or campaign's cost per admission is up ≥ 50 % (spend in both periods, ≥ 2 admissions)  | MEDIUM                      |
  | `SOURCE_NO_ADMISSIONS` | a source or campaign spent money and brought ≥ 20 leads but no admission                          | MEDIUM                      |
  | `TARGET_AT_RISK`       | ≥ 25 % of a target's period has passed and achieved < 80 % of the linear pace                     | HIGH if < 50 % of the pace  |
  | `STUCK_LEADS`          | open leads in scope average ≥ 14 days old (≥ 10 open leads)                                       | MEDIUM                      |

- `GET /insights?from&to&brandId&teamId`. Needs `report.read` with team, branch, brand or organization scope.
  Executives whose scope is their own numbers get 403. Without dates the period is the last 7 days (including today),
  compared with the 7 days before. Scope follows the report engine (`ReportsService.context`), so nobody sees insights
  outside their scope.
- **Weekly digest:** the scheduler tick enqueues `insights.digest:<org>:<week>` on Mondays from 08:00 in the
  organization's time zone. That job enqueues one `insights.digest.user:<user>:<week>` job per recipient: an active user
  with `report.read` at team level or above. Each recipient gets an in-app notification (pushed to the phone) and an
  e-mail covering the last 7 complete days. When the assistant is on, the e-mail also carries the AI-written brief. If
  the AI fails, the digest goes out without it.

## Layer 2: "Ask the CRM" assistant and weekly brief (A-052), with Claude

- **Settings:** `assistant_settings`, one row per organization. Off by default. Fields: `briefEnabled` (default on),
  `monthlyQuestionLimit` (default 500, ASSUMED). Changed by `settings.manage` at organization scope and audited.
- **Provider:** `AssistantProvider`.
  - `AnthropicAssistantProvider` is used in production when `ANTHROPIC_API_KEY` is set. It calls the official
    `@anthropic-ai/sdk` with model `claude-opus-5-5`, effort `medium` and server-side refusal fallback
    (`fallbacks: "default"`). It runs a manual tool loop of at most 8 rounds, with a cached system prompt.
  - `SandboxAssistantProvider` is clearly labelled `[SANDBOX]` and answers deterministically from one tool call. It is
    used in development and tests, never in production.
  - In production without a key the assistant reports "not configured".
- **Tools** (strict JSON schemas). Each runs as the asking user through the scoped report engine and returns aggregates
  only. Lead-level drill-down is never offered.
  - `get_summary(from, to, brandId?, teamId?)`: KPI summary and funnel.
  - `get_breakdown(by: executive|course|source|campaign|brand, from, to, brandId?, teamId?)`.
  - `get_insights(from?, to?, brandId?, teamId?)`.
  - `get_targets(brandId?)`: targets with achieved values.
  - `list_scope()`: brands and teams the user can see, today's date and the time zone.
- **`POST /assistant/ask` `{ question, history? }` → `{ answer, toolsUsed, usage }`.**
  - Needs `report.read` above own scope, and the organization's assistant must be on.
  - Rate limits: 20 questions per user per hour, plus the monthly organization limit. 429 `ASSISTANT_LIMIT`.
  - Every question is recorded in `assistant_questions` (append-only): user, question, answer, tools used, model,
    tokens in and out, status. It is also written to `audit_logs`.
- **`GET /assistant/questions`:** the user's own recent questions. An org admin can list all of them for review.
- **Weekly brief:** in the digest job, when the assistant and `briefEnabled` are on, the provider writes a short brief
  from the recipient's insights and summary.

## Data protection

Only aggregate numbers go to Anthropic, plus names of brands, teams, executives, courses, sources and campaigns. Never
student names, phone numbers, e-mails or notes. The system prompt says so, and the tools structurally cannot return
lead-level data. The question text is the user's own: the page warns not to type student details. Provider terms,
retention, and processing outside India / UAE are listed for the owner in O-13 and O-02.

## Migrations

`assistant_settings` and `assistant_questions`, both with RLS `tenant_isolation`, composite FKs to users, and grants
(no UPDATE / DELETE on questions).

## Tests

- Unit: every insight rule (fires, stays quiet below the minimum sample, severity), and the tool loop with a fake
  client.
- Integration:
  - Insights scope: a team leader sees only their team; an executive gets 403.
  - Digest: idempotent per week, notification plus e-mail, recipients correct.
  - Assistant: off → 409, on → sandbox answer recorded, limit → 429, executive → 403, tools respect scope, nothing
    lead-level.
- e2e: insights card and assistant page.

## Risks

- Model answers can be wrong. Mitigations: answers come only from tool data; tools used are shown; it is advisory.
- Cost: bounded by the monthly question limit; tokens are recorded per question.
- No real Claude call runs in CI (no key). The production path is unit-tested with a fake client, and the owner checks
  one real question after adding the key.
