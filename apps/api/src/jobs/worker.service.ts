import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { hostname } from 'node:os';
import { AllocationService } from '../allocation/allocation.service';
import { Clock } from '../common/clock';
import { APP_CONFIG, AppConfig } from '../config';
import { Db } from '../db/db.service';
import { isWorkingTime } from '../settings/business-calendar';
import { SettingsService } from '../settings/settings.service';
import { JobsService, RunSummary } from './jobs.service';
import { FinanceService } from '../finance/finance.service';
import { AiService } from '../ai/ai.service';

const QUEUED = ['OPEN', 'ON_HOLD', 'IN_RECOVERY'] as const;
/** A queued lead is retried at most this often by the background drain. */
const DRAIN_RETRY_MS = 10 * 60_000;

export interface TickResult {
  skipped?: boolean;
  jobs?: RunSummary;
  queue?: { brands: number; attempted: number; assigned: number };
  payments?: { checked: number };
}

/**
 * Runs the job queue and drains unassigned queues. Two triggers share this code:
 * an in-process interval (long-lived server) and the /internal/tick endpoint (serverless cron).
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private readonly workerId = `${hostname()}:${process.pid}`;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jobs: JobsService,
    private readonly allocation: AllocationService,
    private readonly settings: SettingsService,
    private readonly db: Db,
    private readonly clock: Clock,
    @Optional() private readonly finance?: FinanceService,
    @Optional() private readonly ai?: AiService,
  ) {}

  onApplicationBootstrap(): void {
    const mode = this.config.WORKER_MODE ?? (this.config.NODE_ENV === 'test' ? 'off' : 'interval');
    if (mode !== 'interval') return;
    this.timer = setInterval(() => void this.tick(), this.config.WORKER_INTERVAL_MS);
    this.timer.unref();
    this.logger.log(`Background worker every ${this.config.WORKER_INTERVAL_MS} ms`);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<TickResult> {
    if (this.running) return { skipped: true };
    this.running = true;
    try {
      // AI jobs are enqueued first so this tick runs them (deterministic keys: once per day / hour).
      // An AI problem must never stop the scheduler (fallback, FR-021).
      await this.ai?.schedule().catch((e) => this.logger.warn({ err: e }, 'AI scheduling failed'));
      const jobs = await this.jobs.runDue({ workerId: this.workerId });
      const queue = await this.drainQueues();
      const payments = (await this.finance?.reconcilePending()) ?? { checked: 0 };
      if (jobs.claimed || queue.attempted || payments.checked)
        this.logger.log({ jobs, queue, payments }, 'Tick');
      return { jobs, queue, payments };
    } catch (e) {
      this.logger.error({ err: e }, 'Tick failed');
      throw e;
    } finally {
      this.running = false;
    }
  }

  /** Retries queued leads of brands that are in working time (closes A-030). */
  private async drainQueues() {
    const now = this.clock.now();
    const since = new Date(now.getTime() - DRAIN_RETRY_MS);
    // Cross-organization discovery of brands with queued leads (system scope, ids only).
    const brands = await this.db.system((tx) =>
      tx.lead.groupBy({
        by: ['organizationId', 'brandId'],
        where: { ownerId: null, status: { in: [...QUEUED] } },
      }),
    );
    const summary = { brands: 0, attempted: 0, assigned: 0 };
    for (const b of brands) {
      const leadIds = await this.db.tenant(b.organizationId, async (tx) => {
        const s = await tx.allocationSettings.findUnique({ where: { brandId: b.brandId } });
        if (!s?.enabled) return [];
        if (
          s.respectWorkingHours &&
          !isWorkingTime(now, await this.settings.calendar(tx, b.brandId))
        )
          return [];
        const recent = await tx.allocationRun.findMany({
          where: { brandId: b.brandId, createdAt: { gte: since } },
          select: { leadId: true },
        });
        const skip = new Set(recent.map((r) => r.leadId));
        const queued = await tx.lead.findMany({
          where: { brandId: b.brandId, ownerId: null, status: { in: [...QUEUED] } },
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: { id: true },
        });
        return queued.map((l) => l.id).filter((id) => !skip.has(id));
      });
      if (!leadIds.length) continue;
      summary.brands++;
      for (const id of leadIds) {
        const r = await this.allocation.allocate(b.organizationId, id, { trigger: 'QUEUE_DRAIN' });
        summary.attempted++;
        if (r.outcome === 'ASSIGNED') summary.assigned++;
        if (r.outcome === 'OUTSIDE_WORKING_HOURS' || r.outcome === 'DISABLED') break;
      }
    }
    return summary;
  }
}
