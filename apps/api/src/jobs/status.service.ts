import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock';
import { Db } from '../db/db.service';

const MIN = 60_000;
/** A due job older than this means the scheduler is not running (GitHub runs every 5 min, may be late). */
export const STALE_JOB_MINUTES = 30;

/**
 * Operational status for monitoring (Phase 15, docs/RUNBOOK.md). Counts only — no tenant data — so it reads across
 * organizations with the system scope, behind the scheduler secret.
 */
@Injectable()
export class StatusService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async status() {
    const now = this.clock.now();
    const since = new Date(now.getTime() - 24 * 60 * MIN);
    const staleBefore = new Date(now.getTime() - STALE_JOB_MINUTES * MIN);
    const r = await this.db.system(async (tx) => {
      const [dead, dead24h, stale, oldest, lastDone, running] = await Promise.all([
        tx.job.groupBy({ by: ['type'], where: { status: 'DEAD' }, _count: { _all: true } }),
        tx.job.count({ where: { status: 'DEAD', finishedAt: { gte: since } } }),
        tx.job.count({ where: { status: 'PENDING', runAt: { lt: staleBefore } } }),
        tx.job.findFirst({
          where: { status: 'PENDING', runAt: { lte: now } },
          orderBy: { runAt: 'asc' },
          select: { runAt: true },
        }),
        tx.job.findFirst({
          where: { status: 'DONE' },
          orderBy: { finishedAt: 'desc' },
          select: { finishedAt: true },
        }),
        tx.job.count({ where: { status: 'RUNNING', lockedAt: { lt: staleBefore } } }),
      ]);
      return { dead, dead24h, stale, oldest, lastDone, running };
    });
    const problems: string[] = [];
    if (r.stale)
      problems.push(
        `${r.stale} job(s) overdue by more than ${STALE_JOB_MINUTES} minutes: the scheduler is not running`,
      );
    if (r.running)
      problems.push(
        `${r.running} job(s) stuck in RUNNING for more than ${STALE_JOB_MINUTES} minutes`,
      );
    if (r.dead24h)
      problems.push(`${r.dead24h} job(s) failed permanently in the last 24 hours (dead-lettered)`);
    return {
      ok: problems.length === 0,
      problems,
      checkedAt: now,
      jobs: {
        deadByType: Object.fromEntries(r.dead.map((d) => [d.type, d._count._all])),
        deadLast24h: r.dead24h,
        overdue: r.stale,
        oldestDueMinutes: r.oldest
          ? Math.round((now.getTime() - r.oldest.runAt.getTime()) / MIN)
          : 0,
        lastCompletedAt: r.lastDone?.finishedAt ?? null,
      },
    };
  }
}
