import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../common/clock';
import { Db, Tx } from '../db/db.service';

export interface JobRow {
  id: string;
  organizationId: string | null;
  type: string;
  key: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/** A handler may ask to run again later (e.g. outside working hours) without counting a failure. */
export type JobHandler = (job: JobRow) => Promise<void | { retryAt: Date }>;

export interface RunSummary {
  claimed: number;
  done: number;
  rescheduled: number;
  failed: number;
  dead: number;
}

const STALE_LOCK_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/**
 * Durable job queue in PostgreSQL (CLAUDE.md rule 7). Deterministic keys make enqueueing
 * idempotent; claiming uses FOR UPDATE SKIP LOCKED so several workers can run safely;
 * failures retry with exponential backoff and end as DEAD after `max_attempts`.
 * The queue spans organizations, so claiming runs under Db.system (RLS bypass); every
 * handler does its own work inside Db.tenant(job.organizationId).
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /** Inside the caller's transaction, so the job exists only if the business change commits. */
  async enqueue(
    tx: Tx,
    j: {
      organizationId: string;
      type: string;
      key: string;
      payload: Record<string, unknown>;
      runAt: Date;
      maxAttempts?: number;
    },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO jobs (id, organization_id, type, key, payload, status, run_at, attempts, max_attempts, created_at)
      VALUES (gen_random_uuid(), ${j.organizationId}::uuid, ${j.type}, ${j.key}, ${JSON.stringify(j.payload)}::jsonb,
              'PENDING', ${j.runAt}, 0, ${j.maxAttempts ?? 5}, ${this.clock.now()})
      ON CONFLICT (key) DO NOTHING`;
  }

  /** Cancels pending jobs whose key starts with `prefix` (e.g. all checkpoints of an SLA generation). */
  async cancelPending(tx: Tx, prefix: string): Promise<number> {
    return tx.$executeRaw`
      UPDATE jobs SET status = 'CANCELLED', finished_at = ${this.clock.now()}
      WHERE status = 'PENDING' AND starts_with(key, ${prefix})`;
  }

  /** Claims and runs due jobs until none are left or `maxJobs` ran. */
  async runDue(opts: { workerId: string; maxJobs?: number; batch?: number }): Promise<RunSummary> {
    const summary: RunSummary = { claimed: 0, done: 0, rescheduled: 0, failed: 0, dead: 0 };
    const maxJobs = opts.maxJobs ?? 200;
    while (summary.claimed < maxJobs) {
      const batch = await this.claim(
        opts.workerId,
        Math.min(opts.batch ?? 20, maxJobs - summary.claimed),
      );
      if (!batch.length) break;
      summary.claimed += batch.length;
      for (const job of batch) await this.execute(job, summary);
    }
    return summary;
  }

  private claim(workerId: string, limit: number): Promise<JobRow[]> {
    const now = this.clock.now();
    const stale = new Date(now.getTime() - STALE_LOCK_MS);
    return this.db.system(
      (tx) => tx.$queryRaw<JobRow[]>`
        UPDATE jobs SET status = 'RUNNING', locked_at = ${now}, locked_by = ${workerId}, attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM jobs
          WHERE (status = 'PENDING' AND run_at <= ${now}) OR (status = 'RUNNING' AND locked_at < ${stale})
          ORDER BY run_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
        RETURNING id, organization_id AS "organizationId", type, key, payload, attempts,
                  max_attempts AS "maxAttempts"`,
    );
  }

  private async execute(job: JobRow, summary: RunSummary): Promise<void> {
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
      const r = await handler(job);
      const now = this.clock.now();
      if (r && 'retryAt' in r) {
        summary.rescheduled++;
        await this.db.system(
          (tx) => tx.$executeRaw`
            UPDATE jobs SET status = 'PENDING', run_at = ${r.retryAt}, attempts = attempts - 1,
                            locked_at = NULL, locked_by = NULL
            WHERE id = ${job.id}::uuid`,
        );
        return;
      }
      summary.done++;
      await this.db.system(
        (tx) => tx.$executeRaw`
          UPDATE jobs SET status = 'DONE', finished_at = ${now}, locked_at = NULL, locked_by = NULL
          WHERE id = ${job.id}::uuid`,
      );
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
      const now = this.clock.now();
      const dead = !handler || job.attempts >= job.maxAttempts;
      if (dead) summary.dead++;
      else summary.failed++;
      this.logger.error(
        { jobId: job.id, type: job.type, attempts: job.attempts, err: message },
        dead ? 'Job dead-lettered' : 'Job failed; will retry',
      );
      const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (job.attempts - 1), BACKOFF_MAX_MS);
      await this.db.system(
        (tx) => tx.$executeRaw`
          UPDATE jobs SET status = ${dead ? 'DEAD' : 'PENDING'}::"JobStatus", last_error = ${message},
                          run_at = ${new Date(now.getTime() + backoff)}, locked_at = NULL, locked_by = NULL,
                          finished_at = ${dead ? now : null}
          WHERE id = ${job.id}::uuid`,
      );
    }
  }

  // ------------------------------------------------------- operations view
  list(organizationId: string, status?: string) {
    return this.db.tenant(organizationId, (tx) =>
      tx.job.findMany({
        where: status
          ? { status: status as never }
          : { status: { in: ['DEAD', 'PENDING', 'RUNNING'] } },
        orderBy: { runAt: 'desc' },
        take: 100,
        select: {
          id: true,
          type: true,
          key: true,
          status: true,
          runAt: true,
          attempts: true,
          maxAttempts: true,
          lastError: true,
          createdAt: true,
          finishedAt: true,
        },
      }),
    );
  }

  counts(organizationId: string) {
    return this.db.tenant(organizationId, async (tx) => {
      const rows = await tx.job.groupBy({ by: ['status'], _count: { _all: true } });
      return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
    });
  }

  /** Puts a dead job back in the queue with a fresh attempt budget. */
  retry(organizationId: string, id: string) {
    return this.db.tenant(organizationId, async (tx) => {
      const r = await tx.job.updateMany({
        where: { id, status: 'DEAD' },
        data: { status: 'PENDING', attempts: 0, runAt: this.clock.now(), finishedAt: null },
      });
      return { requeued: r.count };
    });
  }
}
