# Phase 15 plan — Hardening and production release

Approved by owner: 2026-11-28 ("Yes" to Phase 15).
Scope: SRS §8 (non-functional requirements), §8.1 (security and privacy baseline), Phase 15.
Exit gate: signed UAT, rollback plan, verified backups and production readiness approval.

Some of the exit gate can only be given by the owner: UAT sign-off, verifying backups on the production Neon account,
and the go-live approval. This phase prepares and verifies everything else, and hands over checklists for those items.

| Work                | Done here                                                                                                                                                                              | Owner action                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Security review     | Dependency audit, secret scan of Git history, a test that every tenant table has RLS, review of authz, headers, CSRF, sessions, uploads and webhooks; fixes; `docs/SECURITY-REVIEW.md` | —                                                            |
| Load test           | DEV-only volume seed and a repeatable load script (lists, detail, reports, intake burst, job queue); p95 per action in `docs/PERFORMANCE.md`                                           | Agree the production test load (SRS §8)                      |
| Accessibility       | axe-core scan of the main screens in e2e (no serious or critical violations), keyboard checks, fixes                                                                                   | —                                                            |
| Backup and restore  | Scripted dump → restore → verify (row counts, append-only triggers, RLS) rehearsal; Neon point-in-time restore procedure                                                               | Confirm Neon plan / retention; run the restore drill on Neon |
| Migration rehearsal | Apply the full migration history to an empty database and forward from the previous release with data; checks for destructive SQL                                                      | —                                                            |
| Monitoring          | Protected status endpoint (failed / stale jobs, last tick); the scheduler workflow fails and alerts when unhealthy; runbook                                                            | Add the `CRON_SECRET` GitHub secret                          |
| UAT                 | `docs/UAT.md`: scripted cases per role with expected results and sign-off table                                                                                                        | Run and sign                                                 |
| Release             | `docs/RELEASE.md`: production configuration, go-live checklist, rollback plan (application and database)                                                                               | Approve go-live; switch off demo settings                    |

Targets used until the owner agrees others (ASSUMED, A-046): p95 < 2 s for list and detail actions at 50 concurrent
users on 20,000 leads; RPO ≤ 24 h (Neon point-in-time restore gives less); RTO ≤ 4 h; availability objective 99.5 %
monthly, maintenance on Sundays 02:00–04:00 IST.

Tests: RLS coverage and append-only coverage integration tests; axe e2e spec; load and restore scripts with recorded
results. All of lint, typecheck, tests, build and e2e run at the end, and their results are reported.
