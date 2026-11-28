# Operations runbook

## Signals

| Signal             | Where                                                                                                                                                            | Healthy                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| API health         | `GET /api/v1/health` (public)                                                                                                                                    | 200 `{"status":"ok","database":"up"}`  |
| Operational status | `GET /api/v1/internal/status` with `Authorization: Bearer $CRON_SECRET`                                                                                          | 200 `ok: true`; 503 lists the problems |
| Scheduler + alert  | GitHub Actions "Scheduler tick" every 5 min: runs jobs, then checks health and status. A failed run e-mails the repository owner (GitHub notification settings). | Green runs                             |
| Errors and logs    | Vercel → API project → Logs / Observability (JSON logs with `req.id` correlation ids; secrets redacted)                                                          | No 5xx bursts                          |
| CI                 | GitHub Actions "CI" on every push                                                                                                                                | Green                                  |
| Audit trail        | Audit log page (`audit.read`)                                                                                                                                    | —                                      |

`/internal/status` reports:

- **overdue** — jobs due more than 30 minutes ago: the scheduler is not running.
- **stuck** — jobs RUNNING for more than 30 minutes.
- **deadLast24h** / **deadByType** — jobs that failed all retries and are dead-lettered.
- **oldestDueMinutes** and **lastCompletedAt**.

## Incidents

| Symptom                                                      | Likely cause                                                       | Action                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status: jobs overdue; SLA reminders and follow-up tasks late | Scheduler not calling `/internal/tick`                             | Check the "Scheduler tick" workflow (is `CRON_SECRET` set in GitHub and identical to Vercel?). Run it manually (Actions → Scheduler tick → Run workflow). Long term: O-12 (Vercel Pro cron or an always-on worker).                                           |
| Status: dead-lettered jobs                                   | A job failed 5 times (bug or bad data)                             | Find the error: `SELECT type, key, last_error, finished_at FROM jobs WHERE status = 'DEAD' ORDER BY finished_at DESC LIMIT 20;` Fix the cause, then retry by setting `status = 'PENDING', attempts = 0, run_at = now()` for those rows (jobs are idempotent). |
| Health 503, `database: down`                                 | Neon unavailable, credentials changed, or connection limit reached | Neon console status; check `DATABASE_URL*` on Vercel; restart by redeploying. If data is damaged see `docs/BACKUP-RESTORE.md`.                                                                                                                                |
| Everything fails after a deploy                              | Bad release                                                        | Roll back (`docs/RELEASE.md` §4): promote the previous deployment in Vercel. Migrations are additive, so the previous code runs on the new schema.                                                                                                            |
| Users see "Too many requests" (429)                          | Rate limits                                                        | Signed-in users have 300 requests/min each; sign-in 10/min per account per IP; 3,000/min per IP. Raise `THROTTLE_PER_MINUTE` / `THROTTLE_IP_PER_MINUTE` on Vercel if a legitimate office hits them.                                                           |
| A user is locked out                                         | 5 wrong passwords → 15 min lock                                    | Wait, or an admin sends a password reset.                                                                                                                                                                                                                     |
| Ad leads rejected with 429                                   | Intake limit per key (120/min)                                     | Raise `INTAKE_PER_MINUTE`; rejected enquiries are retried by the sender or appear under Rejected leads.                                                                                                                                                       |
| Payment marked paid at the gateway but not in the CRM        | Missed webhook                                                     | Finance → Reconciliation; pending attempts are checked with the gateway on every tick. Never mark a payment paid by hand without verification.                                                                                                                |
| AI panel says "unavailable" or uses simple rules             | No usable model or a scoring error                                 | Nothing breaks. Settings → AI assistance → Train now; check logs for "Scoring failed".                                                                                                                                                                        |
| Emails not arriving                                          | SMTP not configured (`ALLOW_LOG_MAILER` writes them to logs)       | Configure `SMTP_URL` and remove `ALLOW_LOG_MAILER` (release blocker S2).                                                                                                                                                                                      |

## Routine

- Daily: glance at the scheduler runs and Vercel errors.
- Weekly: dead-lettered jobs, failed logins and lockouts in the audit log, the CI "Dependency audit" step (reports high advisories without blocking).
- Quarterly: restore drill (`docs/BACKUP-RESTORE.md`), access review of role assignments, dependency upgrades.
