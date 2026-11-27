import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { SlaAction, SlaInstance, SlaState, TimeBasis } from '@prisma/client';
import { Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import {
  addWorkingMinutes,
  CalendarSpec,
  workingMinutesBetween,
} from '../settings/business-calendar';
import { SettingsService } from '../settings/settings.service';

export const RUNNING_STATES: SlaState[] = ['PENDING', 'AT_RISK', 'BREACHED'];
export const ACTIVE_STATES: SlaState[] = [...RUNNING_STATES, 'PAUSED'];
const KIND = 'FIRST_RESPONSE';

export interface CheckpointSnapshot {
  position: number;
  action: SlaAction;
  afterMinutes: number;
  basis: TimeBasis;
}

export const jobKeyPrefix = (instanceId: string, generation?: number) =>
  generation === undefined ? `sla:${instanceId}:` : `sla:${instanceId}:g${generation}:`;

/**
 * First-response SLA clock (FR-009, SRS §5.1). Every method runs inside the caller's
 * transaction. Time is tracked in running segments: `consumed_*` holds the minutes used
 * before the current segment (which started at `segment_started_at`); a hold pauses the
 * clock and is counted on neither clock (A-031).
 */
@Injectable()
export class SlaClockService {
  constructor(
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
  ) {}

  active(tx: Tx, leadId: string) {
    return tx.slaInstance.findFirst({
      where: { leadId, kind: KIND, state: { in: ACTIVE_STATES } },
    });
  }

  /** Starts the clock unless one is running or the first response was already made. */
  async start(
    tx: Tx,
    lead: { id: string; organizationId: string; brandId: string },
    ownerId: string,
    now: Date,
  ): Promise<SlaInstance | null> {
    const existing = await tx.slaInstance.findFirst({
      where: { leadId: lead.id, kind: KIND, state: { in: [...ACTIVE_STATES, 'RESOLVED'] } },
    });
    if (existing) return null;
    const policy = await tx.slaPolicy.findUnique({
      where: { brandId: lead.brandId },
      include: { checkpoints: { orderBy: { position: 'asc' } } },
    });
    if (!policy) return null;
    const checkpoints: CheckpointSnapshot[] = policy.checkpoints.map((c) => ({
      position: c.position,
      action: c.action,
      afterMinutes: c.afterMinutes,
      basis: c.basis,
    }));
    const inst = await tx.slaInstance.create({
      data: {
        organizationId: lead.organizationId,
        brandId: lead.brandId,
        leadId: lead.id,
        kind: KIND,
        ownerId,
        targetMinutes: policy.firstResponseMinutes,
        basis: policy.firstResponseBasis,
        checkpoints: checkpoints as unknown as Prisma.InputJsonValue,
        startedAt: now,
        segmentStartedAt: now,
      },
    });
    await this.event(tx, inst, 'STARTED', now, { ownerId, targetMinutes: inst.targetMinutes });
    return this.schedule(tx, inst);
  }

  /** Enqueues the remaining checkpoints and the deadline for the current generation. */
  private async schedule(tx: Tx, inst: SlaInstance): Promise<SlaInstance> {
    const cal = await this.settings.calendar(tx, inst.brandId);
    const at = (minutes: number, basis: TimeBasis) => this.instantAfter(inst, cal, minutes, basis);
    const prefix = jobKeyPrefix(inst.id, inst.generation);
    for (const cp of inst.checkpoints as unknown as CheckpointSnapshot[]) {
      if (inst.firedPositions.includes(cp.position)) continue;
      await this.jobs.enqueue(tx, {
        organizationId: inst.organizationId,
        type: 'sla.checkpoint',
        key: `${prefix}cp${cp.position}`,
        payload: { instanceId: inst.id, generation: inst.generation, position: cp.position },
        runAt: at(cp.afterMinutes, cp.basis),
      });
    }
    let dueAt = inst.dueAt;
    if (!inst.breachedAt) {
      dueAt = at(inst.targetMinutes, inst.basis);
      await this.jobs.enqueue(tx, {
        organizationId: inst.organizationId,
        type: 'sla.deadline',
        key: `${prefix}deadline`,
        payload: { instanceId: inst.id, generation: inst.generation },
        runAt: dueAt,
      });
    }
    return tx.slaInstance.update({ where: { id: inst.id }, data: { dueAt } });
  }

  /** Instant at which `minutes` of SLA time (on `basis`) will have elapsed, given what is consumed. */
  private instantAfter(
    inst: SlaInstance,
    cal: CalendarSpec,
    minutes: number,
    basis: TimeBasis,
  ): Date {
    if (basis === 'CALENDAR') {
      const remaining = Math.max(0, minutes - inst.consumedCalendarMinutes);
      return new Date(inst.segmentStartedAt.getTime() + remaining * 60_000);
    }
    const remaining = Math.max(0, minutes - inst.consumedWorkingMinutes);
    return addWorkingMinutes(inst.segmentStartedAt, remaining, cal);
  }

  /** Minutes on both clocks up to `now` (D-003). */
  async elapsed(tx: Tx, inst: SlaInstance, now: Date) {
    if (inst.state === 'PAUSED')
      return { calendar: inst.consumedCalendarMinutes, working: inst.consumedWorkingMinutes };
    const cal = await this.settings.calendar(tx, inst.brandId);
    return {
      calendar:
        inst.consumedCalendarMinutes +
        Math.max(0, Math.round((now.getTime() - inst.segmentStartedAt.getTime()) / 60_000)),
      working:
        inst.consumedWorkingMinutes +
        Math.round(workingMinutesBetween(inst.segmentStartedAt, now, cal)),
    };
  }

  /** First response made: stores both clocks and stops all pending checkpoints. */
  async resolve(
    tx: Tx,
    leadId: string,
    r: { resolution: string; byUserId: string | null; now: Date },
  ): Promise<SlaInstance | null> {
    const inst = await this.active(tx, leadId);
    if (!inst) return null;
    const used = await this.elapsed(tx, inst, r.now);
    await this.jobs.cancelPending(tx, jobKeyPrefix(inst.id));
    const done = await tx.slaInstance.update({
      where: { id: inst.id },
      data: {
        state: 'RESOLVED',
        resolvedAt: r.now,
        resolution: r.resolution,
        resolvedById: r.byUserId,
        calendarMinutes: used.calendar,
        workingMinutes: used.working,
        pausedAt: null,
      },
    });
    await this.event(tx, inst, 'RESOLVED', r.now, {
      resolution: r.resolution,
      byUserId: r.byUserId,
      calendarMinutes: used.calendar,
      workingMinutes: used.working,
      withinTarget: !inst.breachedAt,
    });
    return done;
  }

  async cancel(tx: Tx, leadId: string, reason: string, now: Date): Promise<SlaInstance | null> {
    const inst = await this.active(tx, leadId);
    if (!inst) return null;
    await this.jobs.cancelPending(tx, jobKeyPrefix(inst.id));
    const used = await this.elapsed(tx, inst, now);
    await tx.slaInstance.update({
      where: { id: inst.id },
      data: {
        state: 'CANCELLED',
        cancelledAt: now,
        cancelReason: reason,
        calendarMinutes: used.calendar,
        workingMinutes: used.working,
      },
    });
    await this.event(tx, inst, 'CANCELLED', now, { reason });
    return inst;
  }

  /** Approved hold: freeze both clocks and drop this generation's pending jobs. */
  async pause(tx: Tx, leadId: string, reason: string, now: Date): Promise<void> {
    const inst = await this.active(tx, leadId);
    if (!inst || inst.state === 'PAUSED') return;
    const used = await this.elapsed(tx, inst, now);
    await this.jobs.cancelPending(tx, jobKeyPrefix(inst.id, inst.generation));
    await tx.slaInstance.update({
      where: { id: inst.id },
      data: {
        state: 'PAUSED',
        pausedAt: now,
        consumedCalendarMinutes: used.calendar,
        consumedWorkingMinutes: used.working,
        generation: { increment: 1 },
      },
    });
    await this.event(tx, inst, 'PAUSED', now, { reason, ...used });
  }

  /** Restarts a paused clock; checkpoints already fired are not repeated. */
  async resume(tx: Tx, leadId: string, now: Date): Promise<void> {
    const inst = await this.active(tx, leadId);
    if (!inst || inst.state !== 'PAUSED') return;
    const state: SlaState = inst.breachedAt
      ? 'BREACHED'
      : inst.firedPositions.length
        ? 'AT_RISK'
        : 'PENDING';
    const resumed = await tx.slaInstance.update({
      where: { id: inst.id },
      data: { state, pausedAt: null, segmentStartedAt: now },
    });
    await this.event(tx, inst, 'RESUMED', now, {
      pausedMinutes: inst.pausedAt
        ? Math.round((now.getTime() - inst.pausedAt.getTime()) / 60_000)
        : null,
    });
    await this.schedule(tx, resumed);
  }

  /** Manual reassignment overrides the running clock: cancel it and start afresh for the new owner. */
  async restart(
    tx: Tx,
    lead: { id: string; organizationId: string; brandId: string },
    ownerId: string,
    now: Date,
  ): Promise<void> {
    const cancelled = await this.cancel(tx, lead.id, 'Manual reassignment', now);
    if (cancelled) await this.start(tx, lead, ownerId, now);
  }

  event(
    tx: Tx,
    inst: { id: string; organizationId: string; leadId: string },
    type: string,
    now: Date,
    data?: Record<string, unknown>,
    position?: number,
  ) {
    return tx.slaEvent.create({
      data: {
        organizationId: inst.organizationId,
        slaInstanceId: inst.id,
        leadId: inst.leadId,
        type,
        position: position ?? null,
        data: (data ?? undefined) as Prisma.InputJsonValue | undefined,
        occurredAt: now,
      },
    });
  }
}
