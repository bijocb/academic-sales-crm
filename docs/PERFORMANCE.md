# Performance and load test — Phase 15

Target (SRS §8, ASSUMED until the owner agrees a production test load, A-046): common list and detail actions p95 under
2 s with 50 concurrent users on 20,000 leads. Reports are benchmarked separately (SRS §8).

## How to run

```bash
# scratch database (never production): migrate, demo data, then volume (40 extra executives, 20,000 leads)
MIGRATION_DATABASE_URL=…/crm_load APP_DATABASE_URL=…/crm_load pnpm db:migrate
MIGRATION_DATABASE_URL=…/crm_load pnpm db:seed:demo
cd apps/api && MIGRATION_DATABASE_URL=…/crm_load npx tsx scripts/seed-load.ts
# API in production mode against it (high throttle limits for the test only), then:
API_URL=http://localhost:4100/api/v1 CRON_SECRET=… USERS=50 DURATION=60 CONCURRENCY=50 REQUESTS=1000 node tests/load/run.mjs
```

`seed-load.ts` refuses to run in production or on a database whose name does not contain "load".

## Environment

One Node 22 API process (production build, `NODE_ENV=production`) and PostgreSQL 16 on the same 4-vCPU container,
Prisma pool of 9 connections. Data: 21,000 leads, 44 executives, 10,000 calls, 7,000 open tasks. This is a conservative
single-instance rig. On Vercel each request runs in its own function instance with up to 3 pooled Neon connections,
so throughput scales out. Latency then depends on Neon's compute size and on the network to region `sin1`. Repeat
the realistic profile against staging before go-live.

## Results (2026-11-28, final run)

**Realistic profile** — 50 users for 60 s, each doing one action every ~2 s (weighted mix), 1,374 requests:

| Action        | Requests | p50     | p95        | Max     | Errors |
| ------------- | -------- | ------- | ---------- | ------- | ------ |
| Lead list     | 414      | 102 ms  | **350 ms** | 902 ms  | 0      |
| Lead search   | 214      | 213 ms  | **434 ms** | 645 ms  | 0      |
| Lead detail   | 357      | 36 ms   | **281 ms** | 834 ms  | 0      |
| Lead timeline | 132      | 44 ms   | **260 ms** | 510 ms  | 0      |
| My tasks      | 151      | 38 ms   | **235 ms** | 795 ms  | 0      |
| My dashboard  | 68       | 336 ms  | **896 ms** | 1030 ms | 0      |
| Brand report  | 38       | 1279 ms | 1688 ms    | 1938 ms | 0      |

**All common actions meet p95 < 2 s, with no errors.**

**Stress profile** — a fixed number of requests always in flight (no think time; roughly 10× the realistic load):

| Action                      | n          | In flight | p50     | p95     | Throughput     | Errors |
| --------------------------- | ---------- | --------- | ------- | ------- | -------------- | ------ |
| Lead list (newest)          | 1000       | 50        | 1022 ms | 1179 ms | 48 req/s       | 0      |
| Lead list (priority sort)   | 1000       | 50        | 1003 ms | 1236 ms | 48 req/s       | 0      |
| Lead search                 | 1000       | 50        | 3166 ms | 3732 ms | 16 req/s       | 0      |
| My leads (executive)        | 1000       | 50        | 580 ms  | 763 ms  | 83 req/s       | 0      |
| Lead detail                 | 1000       | 50        | 269 ms  | 304 ms  | 185 req/s      | 0      |
| Lead timeline               | 1000       | 50        | 256 ms  | 287 ms  | 194 req/s      | 0      |
| My tasks                    | 1000       | 50        | 420 ms  | 470 ms  | 118 req/s      | 0      |
| Pipeline board              | 300        | 20        | 520 ms  | 669 ms  | 37 req/s       | 0      |
| Report summary (brand)      | 200        | 10        | 2628 ms | 4897 ms | 3 req/s        | 0      |
| Report by executive         | 200        | 10        | 2711 ms | 5057 ms | 3 req/s        | 0      |
| My dashboard (executive)    | 300        | 20        | 1498 ms | 1931 ms | 13 req/s       | 0      |
| Lead intake (new enquiries) | 500        | 20        | 684 ms  | 915 ms  | 29 req/s       | 0      |
| Job queue drain             | 3,778 jobs | —         | —       | —       | 20 ticks, 37 s | 0      |

Under stress, latency is queueing for the 9 database connections of one process. Search and brand-wide reports are the
heaviest requests. Both stay error-free and recover as soon as the burst ends.

## What the load test found and fixed

| Problem                                                                                                                                                               | Fix                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Under bursts, requests failed with "Unable to start a transaction" after waiting 2 s for a connection (up to 143 of 300 dashboard requests).                          | Connection wait raised to 8 s and transaction limit to 15 s (`Db.tenant` / `Db.system` defaults): bursts queue instead of failing.                                                                                                                                  |
| Reports reloaded lead details once per metric and looked up historical owners with a full scan per record (quadratic growth).                                         | Per-request lead cache; owner history grouped by lead; brand and person scope pushed into every query; outstanding fees computed with grouped queries instead of 3 queries per admission. My dashboard p95 went from 4.9 s to 1.9 s under stress (0.9 s realistic). |
| The global throttle (300/min) counted by IP, so an office of 40 behind one NAT would be throttled together; login (10/min per IP) would block a morning sign-in rush. | Throttle per signed-in session (default 300/min), sign-in per IP + e-mail (10/min) with a 100/min per-IP ceiling, flood ceiling 3,000/min per IP; all configurable (`THROTTLE_PER_MINUTE`, `THROTTLE_IP_PER_MINUTE`, `INTAKE_PER_MINUTE`).                          |
| Lead search scans every lead and person (`ILIKE '%…%'`).                                                                                                              | Trigram (`pg_trgm`) GIN indexes on name, e-mail, phone and lead number (migration `20261128080000_search_indexes`). The synthetic data ("Lead N" names) is not selective, so the planner still scans in this test. Real names benefit.                              |
| The deploy-time backfill updated people one by one in a single 5 s transaction; a deploy after a bulk import (20,000 people) failed.                                  | Name-key backfill runs in batches of 500, each in its own transaction (24 s for 20,000).                                                                                                                                                                            |

## Limits and follow-ups

- Brand-wide reports over a long period scan every record in the period. They take about 1 s for a month at this size.
  If reporting periods or volumes grow a lot, add pre-aggregated daily snapshots behind the same report functions
  (`docs/ARCHITECTURE.md` §5d).
- Intake is limited to 120 leads per minute per intake key by default (`INTAKE_PER_MINUTE`); raise it for large ad
  bursts.
