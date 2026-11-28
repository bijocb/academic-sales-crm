# Release and go-live — Phase 15

Exit gate (SRS Phase 15): **signed UAT, rollback plan, verified backups and production readiness approval.**
The current deployment (Vercel + Neon, `docs/DEPLOYMENT.md`) is a **demo**. Real student data must wait until every
item marked **Owner** below is done.

## 1. Readiness status (2026-11-28)

| Area                           | Status                                                                                      | Evidence                  |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------- |
| Functional scope (Phases 1–14) | Done; 254 unit and integration tests in 25 suites, 31 e2e tests                             | CI                        |
| Security review                | Done; dependency advisories fixed; database baseline tested                                 | `docs/SECURITY-REVIEW.md` |
| Load test                      | Done locally (realistic profile meets p95 < 2 s); **repeat on staging**                     | `docs/PERFORMANCE.md`     |
| Accessibility                  | Done; automated scan clean; screen-reader check in UAT                                      | `docs/ACCESSIBILITY.md`   |
| Backup / restore               | Drill and migration rehearsal pass locally; **Owner: drill on a Neon branch of production** | `docs/BACKUP-RESTORE.md`  |
| Monitoring                     | Status endpoint and alerting workflow ready; **Owner: add `CRON_SECRET` GitHub secret**     | `docs/RUNBOOK.md`         |
| Rollback plan                  | Below (§4)                                                                                  | this file                 |
| UAT                            | Script ready; **Owner: run and sign**                                                       | `docs/UAT.md`             |
| Production approval            | **Owner**                                                                                   | §5                        |

## 2. Production configuration (API project on Vercel)

| Setting                                                              | Production value                                                                                                                                                                   | Now (demo)                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `NODE_ENV`                                                           | `production`                                                                                                                                                                       | production                           |
| `ALLOW_DEMO_SEED`                                                    | **remove** (otherwise a `[DEMO]` organization with a shared password is created)                                                                                                   | `true` — release blocker             |
| `ALLOW_LOG_MAILER`                                                   | **remove**                                                                                                                                                                         | `true` — release blocker             |
| `SMTP_URL`, `MAIL_FROM`                                              | real mail provider (O-06), sender on the organization's domain                                                                                                                     | not set                              |
| `JWT_ACCESS_SECRET`, `CRON_SECRET`, `CRM_APP_DB_PASSWORD`            | long random values, only in Vercel (sensitive); `CRON_SECRET` also in GitHub secrets                                                                                               | set (GitHub missing)                 |
| `SEED_PLATFORM_ADMIN_*`                                              | the first real platform admin; remove the password variable after first sign-in                                                                                                    | set                                  |
| `DATABASE_URL*`                                                      | Neon production branch, paid plan with point-in-time history covering the RPO; region per O-02                                                                                     | Neon free                            |
| `META_APP_SECRET`, `META_VERIFY_TOKEN`, `SECRETS_KEY`                | needed for Facebook / Instagram Lead Ads (`docs/LEAD-SOURCES.md` §3); `SECRETS_KEY` = 32 random bytes, keep a copy in the password vault (losing it means re-entering page tokens) | not set                              |
| `REDIS_URL`                                                          | recommended (shared rate limits, S3)                                                                                                                                               | not set                              |
| `THROTTLE_PER_MINUTE`, `THROTTLE_IP_PER_MINUTE`, `INTAKE_PER_MINUTE` | defaults 300 / 3,000 / 120                                                                                                                                                         | defaults                             |
| `ENABLE_API_DOCS`                                                    | unset (docs off)                                                                                                                                                                   | unset                                |
| Scheduler                                                            | GitHub Actions every 5 min plus daily Vercel cron; minute accuracy needs O-12                                                                                                      | daily only until the secret is added |
| Custom domain + TLS                                                  | Vercel domain for web (API stays behind the web rewrite)                                                                                                                           | `*.vercel.app`                       |

Decisions still open that affect go-live: O-02 (hosting region / data residency for India DPDP Act and UAE PDPL),
O-06 (WhatsApp, telephony, e-mail providers), O-09 (payment gateway, tax invoices), O-11 (retention and consent wording),
O-12 (scheduler accuracy). Each has a safe default, listed in `docs/DECISIONS.md`.

## 3. Go-live checklist

1. [ ] UAT signed (`docs/UAT.md`) on staging with production settings.
2. [ ] Production variables set as in §2; demo settings removed; a fresh production database (no `[DEMO]` data).
3. [ ] `CRON_SECRET` in GitHub; "Scheduler tick" green; alert e-mails reach the owner.
4. [ ] Neon plan and retention confirmed; restore drill run on a branch of production (`docs/BACKUP-RESTORE.md` §2 A), time recorded.
5. [ ] `migration-rehearsal.sh` run on a copy of the production database for this release.
6. [ ] Load test (realistic profile) repeated against staging; p95 < 2 s.
7. [ ] Organization, brands, branches, teams, users and roles created; working hours, holidays, SLA, pipeline, courses, fees, document checklist, allocation rules and loss reasons reviewed per brand.
8. [ ] Intake keys issued per source; website and ad forms pointed at production; test enquiry end to end.
9. [ ] Privacy notice and consent wording published (O-11); data protection contact named.
10. [ ] Release tagged in Git (`git tag v1.0.0`); the deployment IDs of web and API recorded for rollback.
11. [ ] Go / no-go meeting: §5 signed.
12. [ ] Hypercare for two weeks: daily check of errors, status and dead jobs (`docs/RUNBOOK.md`).

## 4. Rollback plan

**Application (minutes).** In Vercel, open the API project → Deployments → the previous production deployment →
"Promote to Production" (Instant Rollback); repeat for the web project if the UI changed. Both projects deploy from the
same commit, so roll both back to the same release. Verify with the smoke cases (`docs/UAT.md` §0).

**Database.** Migrations are forward-only and additive ("expand / contract", `docs/BACKUP-RESTORE.md` §4). The
previous application version therefore keeps working on the new schema, and a code rollback needs no database change.
If a migration itself is faulty:

1. Prefer fix-forward: a new migration that corrects it, released through the normal pipeline.
2. If data was damaged: restore to a point before the release (Neon branch, `docs/BACKUP-RESTORE.md` §2 A). Data entered
   since then is lost. Use the append-only history and audit logs to re-enter it, and inform the business owner first.

**Decision.** The release owner decides within 30 minutes of a failed smoke test or a sustained error spike. Default:
roll back first, investigate after.

## 5. Production readiness approval

| Item                                                              | Name / evidence | Date |
| ----------------------------------------------------------------- | --------------- | ---- |
| UAT signed                                                        |                 |      |
| Backups verified on production (drill time: )                     |                 |      |
| Rollback plan reviewed                                            |                 |      |
| Open decisions accepted for launch (O-02, O-06, O-09, O-11, O-12) |                 |      |
| **Approved for production by (business owner)**                   |                 |      |
