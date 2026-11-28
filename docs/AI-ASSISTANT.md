# Insights and "Ask the CRM" — owner guide (A-051, A-052)

## What team leaders and management get

- **Insights** (Dashboard card and the _Insights & assistant_ page). Rules built into the CRM compare a period with
  the previous one and list what needs attention, each with its numbers and a suggested action:
  - first response, contact rate or admissions falling;
  - executives with many overdue tasks, a low contact rate or many missed first responses;
  - sources and campaigns whose cost per admission rose, or that spent money without admissions;
  - targets behind pace;
  - old open leads.

  Everyone sees only their own scope: a team leader sees their team, a brand manager their brand, management the
  organization. Executives do not get insights.

- **Weekly digest**: every Monday from 08:00 (organization time), an in-app notification, phone push and e-mail with
  last week's insights. It goes to everyone with team-level report access or above: team leaders, brand managers,
  organization admins and management viewers, plus marketing managers and accounts officers, whose roles include
  report access.
- **Ask the CRM**: questions in plain language, answered by Claude (Anthropic) from the report figures, for example:
  "Who in my team needs help this week?", "Why did admissions drop this month?", "Which campaigns give the cheapest
  admissions?". The answer lists what it looked at. The Monday e-mail can include a short AI-written summary.

## Switching on the assistant

1. Create an API key in the Anthropic Console, under the organization's own account.
2. In Vercel, open the API project → Settings → Environment Variables. Add `ANTHROPIC_API_KEY`, marked
   **sensitive**, for Production. Then redeploy the API. Never put the key in Git or in chat.
3. Sign in as an organization admin and open **Insights & assistant**. Under **Assistant settings**, tick
   _Assistant on_, check the monthly limit (default 500 questions and briefs), and save.
4. Ask one question and check the answer against **Reports**.

Without the key, insights and the digest still work, and the assistant says it is not set up. In development and tests
a **sandbox** answers instead (marked "Sandbox — not the real AI").

## Data and cost

- **What is sent to Anthropic:** only totals, rates and money totals, and the names of brands, teams, executives,
  courses, sources and campaigns. The assistant's tools cannot read individual leads, so no student names, phone
  numbers, e-mails or notes are sent. The page asks users not to type student details into questions.
- **Data protection (still open, O-13 / O-02):** before using this with real data, accept Anthropic's commercial terms
  and data retention, and note that the data is processed outside India and the UAE.
- **Audit:** every question, answer and brief is stored, append-only, with tokens used. Admins can review them all
  (`GET /assistant/questions?all=true`).
- **Cost:** each question uses Claude Opus 5.5 (about $4 per million input tokens and $20 per million output tokens at
  list price). A typical question reads 20–40 thousand tokens of figures, so roughly $0.10–0.25. Measure the real cost
  from the stored token counts after the first weeks. The monthly limit caps the total.
- **Limits (ASSUMED, changeable):** 20 questions per person per hour; the monthly organization limit is set on the
  page.
