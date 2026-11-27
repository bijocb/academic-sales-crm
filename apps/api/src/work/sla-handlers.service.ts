import { Injectable, OnModuleInit } from '@nestjs/common';
import type { SlaInstance } from '@prisma/client';
import { AllocationService } from '../allocation/allocation.service';
import { NotificationsService } from '../allocation/notifications.service';
import { Clock } from '../common/clock';
import { Db, Tx } from '../db/db.service';
import { JobRow, JobsService } from '../jobs/jobs.service';
import { addWorkingMinutes, isWorkingTime } from '../settings/business-calendar';
import { SettingsService } from '../settings/settings.service';
import { brandManagers, teamLeadersOf } from './recipients';
import { CheckpointSnapshot, RUNNING_STATES, SlaClockService } from './sla-clock.service';

type LeadForSla = {
  id: string;
  organizationId: string;
  brandId: string;
  leadNumber: string;
  status: string;
  ownerId: string | null;
  person: { fullName: string };
};

/**
 * Background handlers for the SLA ladder (SRS §5) and task reminders. Every handler
 * re-reads state under a row lock and does nothing if the work is no longer due, so
 * late, repeated or concurrent runs are harmless (rule 7).
 */
@Injectable()
export class SlaHandlersService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly jobs: JobsService,
    private readonly sla: SlaClockService,
    private readonly allocation: AllocationService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('sla.checkpoint', (j) => this.checkpoint(j));
    this.jobs.register('sla.deadline', (j) => this.deadline(j));
    this.jobs.register('task.due', (j) => this.taskDue(j));
    this.jobs.register('lead.hold_review', (j) => this.holdReview(j));
  }

  private async lockInstance(tx: Tx, id: string): Promise<SlaInstance | null> {
    await tx.$queryRaw`SELECT id FROM sla_instances WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.slaInstance.findUnique({ where: { id } });
  }

  private lead(tx: Tx, id: string): Promise<LeadForSla | null> {
    return tx.lead.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        brandId: true,
        leadNumber: true,
        status: true,
        ownerId: true,
        person: { select: { fullName: true } },
      },
    });
  }

  // ------------------------------------------------------------ checkpoint
  async checkpoint(job: JobRow): Promise<void | { retryAt: Date }> {
    const { instanceId, generation, position } = job.payload as {
      instanceId: string;
      generation: number;
      position: number;
    };
    const org = job.organizationId!;
    const now = this.clock.now();

    const step = await this.db.tenant(org, async (tx) => {
      const inst = await this.lockInstance(tx, instanceId);
      if (
        !inst ||
        inst.generation !== generation ||
        !RUNNING_STATES.includes(inst.state) ||
        inst.firedPositions.includes(position)
      )
        return { kind: 'skip' as const };
      const cp = (inst.checkpoints as unknown as CheckpointSnapshot[]).find(
        (c) => c.position === position,
      );
      const lead = await this.lead(tx, inst.leadId);
      if (!cp || !lead) return { kind: 'skip' as const };
      if (lead.status !== 'OPEN') {
        await this.sla.cancel(tx, lead.id, `Lead is ${lead.status.toLowerCase()}`, now);
        return { kind: 'skip' as const };
      }
      if (cp.action !== 'REASSIGN') {
        await this.fire(tx, inst, lead, cp, now);
        return { kind: 'skip' as const };
      }
      // Reassignment happens only in working time (calendar-basis checkpoints may fall outside it).
      const cal = await this.settings.calendar(tx, lead.brandId);
      if (!isWorkingTime(now, cal))
        return { kind: 'retry' as const, at: addWorkingMinutes(now, 0, cal) };
      const policy = await tx.slaPolicy.findUnique({ where: { brandId: lead.brandId } });
      const used = await tx.leadAssignment.count({
        where: { leadId: lead.id, type: 'REASSIGN_AUTO' },
      });
      if (used >= (policy?.maxReassignAttempts ?? 0)) {
        await this.markFired(tx, inst, cp, now, { outcome: 'MAX_ATTEMPTS', attemptsUsed: used });
        await this.escalate(tx, inst, lead, 'Maximum automatic reassignments reached', now);
        return { kind: 'skip' as const };
      }
      return { kind: 'reassign' as const, ownerId: inst.ownerId, leadId: lead.id, cal };
    });

    if (step.kind === 'retry') return { retryAt: step.at };
    if (step.kind !== 'reassign') return;

    // Allocation opens its own transaction; it refuses if the owner changed meanwhile.
    const r = await this.allocation.allocate(org, step.leadId, {
      trigger: 'SLA_REASSIGN',
      reassignFrom: step.ownerId,
    });
    if (r.outcome === 'OUTSIDE_WORKING_HOURS')
      return { retryAt: addWorkingMinutes(now, 0, step.cal) };

    await this.db.tenant(org, async (tx) => {
      const inst = await this.lockInstance(tx, instanceId);
      const lead = await this.lead(tx, step.leadId);
      if (!inst || !lead || inst.firedPositions.includes(position)) return;
      const cp = (inst.checkpoints as unknown as CheckpointSnapshot[]).find(
        (c) => c.position === position,
      )!;
      await this.markFired(tx, inst, cp, now, {
        outcome: r.outcome,
        toUserId: r.ownerId ?? null,
        runId: r.runId ?? null,
      });
      if (r.outcome === 'ASSIGNED') {
        await this.sla.event(
          tx,
          inst,
          'REASSIGNED',
          now,
          { fromUserId: step.ownerId, toUserId: r.ownerId },
          position,
        );
      } else if (r.outcome === 'ALREADY_ASSIGNED') {
        await this.sla.event(
          tx,
          inst,
          'REASSIGN_SKIPPED',
          now,
          { reason: 'Owner changed meanwhile' },
          position,
        );
      } else {
        await this.sla.event(tx, inst, 'REASSIGN_FAILED', now, { outcome: r.outcome }, position);
        if (RUNNING_STATES.includes(inst.state))
          await this.escalate(tx, inst, lead, 'No eligible executive for reassignment', now);
      }
    });
  }

  private async markFired(
    tx: Tx,
    inst: SlaInstance,
    cp: CheckpointSnapshot,
    now: Date,
    data: Record<string, unknown> = {},
  ) {
    await tx.slaInstance.update({
      where: { id: inst.id },
      data: {
        firedPositions: { push: cp.position },
        ...(inst.state === 'PENDING' ? { state: 'AT_RISK' } : {}),
      },
    });
    await this.sla.event(
      tx,
      inst,
      'CHECKPOINT',
      now,
      { action: cp.action, afterMinutes: cp.afterMinutes, basis: cp.basis, ...data },
      cp.position,
    );
  }

  private async fire(
    tx: Tx,
    inst: SlaInstance,
    lead: LeadForSla,
    cp: CheckpointSnapshot,
    now: Date,
  ) {
    await this.markFired(tx, inst, cp, now);
    const who = `${lead.person.fullName} (${lead.leadNumber})`;
    if (cp.action === 'REMIND_OWNER') {
      await this.notifications.create(tx, {
        organizationId: lead.organizationId,
        userId: inst.ownerId,
        type: 'SLA_REMINDER',
        title: `Call ${who} now`,
        body: `No call logged yet — ${cp.afterMinutes} min since assignment.`,
        link: `/leads/${lead.id}`,
        dedupKey: `sla:${inst.id}:cp${cp.position}`,
        now,
      });
      await this.sla.event(
        tx,
        inst,
        'REMINDER_SENT',
        now,
        { userIds: [inst.ownerId] },
        cp.position,
      );
    } else if (cp.action === 'ALERT_TEAM_LEADER') {
      let to = await teamLeadersOf(tx, inst.ownerId, lead.brandId);
      if (!to.length) to = await brandManagers(tx, lead.brandId, 'lead.reassign');
      const owner = await tx.user.findUnique({
        where: { id: inst.ownerId },
        select: { name: true },
      });
      for (const userId of to) {
        await this.notifications.create(tx, {
          organizationId: lead.organizationId,
          userId,
          type: 'SLA_ALERT',
          title: `No first call yet: ${who}`,
          body: `${owner?.name ?? 'The owner'} has not called within ${cp.afterMinutes} min.`,
          link: `/leads/${lead.id}`,
          dedupKey: `sla:${inst.id}:cp${cp.position}`,
          now,
        });
      }
      await this.sla.event(tx, inst, 'ALERT_SENT', now, { userIds: to }, cp.position);
    } else if (cp.action === 'ESCALATE_MANAGER') {
      await this.escalate(tx, inst, lead, `No first response after ${cp.afterMinutes} min`, now);
    }
  }

  /** Manager alert + priority queue (escalated_at). Once per SLA instance. */
  private async escalate(tx: Tx, inst: SlaInstance, lead: LeadForSla, reason: string, now: Date) {
    const fresh = await tx.slaInstance.findUniqueOrThrow({ where: { id: inst.id } });
    if (fresh.escalatedAt) return;
    await tx.slaInstance.update({ where: { id: inst.id }, data: { escalatedAt: now } });
    const managers = await brandManagers(tx, lead.brandId, 'lead.reassign');
    for (const userId of managers) {
      await this.notifications.create(tx, {
        organizationId: lead.organizationId,
        userId,
        type: 'SLA_ESCALATED',
        title: `Escalated: ${lead.person.fullName} (${lead.leadNumber})`,
        body: reason,
        link: '/sla',
        dedupKey: `sla-escalated:${inst.id}`,
        now,
      });
    }
    await this.sla.event(tx, inst, 'ESCALATED', now, { reason, userIds: managers });
    await tx.leadEvent.create({
      data: {
        organizationId: lead.organizationId,
        leadId: lead.id,
        type: 'SLA_ESCALATED',
        body: `Escalated to managers — ${reason}`,
        data: { slaInstanceId: inst.id },
        occurredAt: now,
      },
    });
  }

  // -------------------------------------------------------------- deadline
  async deadline(job: JobRow): Promise<void> {
    const { instanceId, generation } = job.payload as { instanceId: string; generation: number };
    const now = this.clock.now();
    await this.db.tenant(job.organizationId!, async (tx) => {
      const inst = await this.lockInstance(tx, instanceId);
      if (
        !inst ||
        inst.generation !== generation ||
        inst.breachedAt ||
        !RUNNING_STATES.includes(inst.state)
      )
        return;
      const used = await this.sla.elapsed(tx, inst, now);
      await tx.slaInstance.update({
        where: { id: inst.id },
        data: { state: 'BREACHED', breachedAt: now },
      });
      await this.sla.event(tx, inst, 'BREACHED', now, {
        targetMinutes: inst.targetMinutes,
        ...used,
      });
      await tx.leadEvent.create({
        data: {
          organizationId: inst.organizationId,
          leadId: inst.leadId,
          type: 'SLA_BREACHED',
          body: `First-response target of ${inst.targetMinutes} ${inst.basis.toLowerCase()} minutes missed`,
          data: { slaInstanceId: inst.id },
          occurredAt: now,
        },
      });
    });
  }

  // ----------------------------------------------------------- reminders
  async taskDue(job: JobRow): Promise<void> {
    const { taskId, dueAt } = job.payload as { taskId: string; dueAt: string };
    const now = this.clock.now();
    await this.db.tenant(job.organizationId!, async (tx) => {
      const task = await tx.task.findUnique({ where: { id: taskId } });
      if (!task || task.status !== 'OPEN' || task.dueAt.toISOString() !== dueAt) return;
      const lead = await this.lead(tx, task.leadId);
      if (!lead) return;
      await this.notifications.create(tx, {
        organizationId: task.organizationId,
        userId: task.ownerId,
        type: 'TASK_DUE',
        title: `Due now: ${task.title} — ${lead.person.fullName} (${lead.leadNumber})`,
        link: `/leads/${task.leadId}`,
        dedupKey: `task-due:${task.id}:${dueAt}`,
        now,
      });
    });
  }

  async holdReview(job: JobRow): Promise<void> {
    const { leadId, holdStartedAt } = job.payload as { leadId: string; holdStartedAt: string };
    const now = this.clock.now();
    await this.db.tenant(job.organizationId!, async (tx) => {
      const lead = await this.lead(tx, leadId);
      if (!lead || lead.status !== 'ON_HOLD' || !lead.ownerId) return;
      await this.notifications.create(tx, {
        organizationId: lead.organizationId,
        userId: lead.ownerId,
        type: 'HOLD_ENDED',
        title: `Hold period ended: ${lead.person.fullName} (${lead.leadNumber})`,
        body: 'Resume the lead or extend the hold.',
        link: `/leads/${lead.id}`,
        dedupKey: `hold:${lead.id}:${holdStartedAt}`,
        now,
      });
    });
  }
}
