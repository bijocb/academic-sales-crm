import { Injectable } from '@nestjs/common';
import type { NewTaskInput } from '@crm/contracts';
import type { Task } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../allocation/notifications.service';
import { Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { SlaClockService } from './sla-clock.service';

const DEFAULT_TITLES: Record<string, string> = {
  FIRST_CALL: 'First call',
  CALL_BACK: 'Call back',
  WHATSAPP: 'WhatsApp follow-up',
  EMAIL: 'Email follow-up',
  COUNSELLING: 'Counselling session',
  DOCUMENT_COLLECTION: 'Collect documents',
  PAYMENT_FOLLOW_UP: 'Payment follow-up',
  ADMISSION_CONFIRMATION: 'Confirm admission',
  CUSTOM: 'Follow-up',
};

export interface LeadRef {
  id: string;
  organizationId: string;
  brandId: string;
  leadNumber: string;
  person: { fullName: string };
}

/**
 * Transaction-level task operations shared by allocation hooks, the task API and
 * merge handling. Never opens its own transaction.
 */
@Injectable()
export class TaskCoreService {
  constructor(
    private readonly sla: SlaClockService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Called inside the allocation transaction after an owner change.
   * First assignment: start the SLA clock and create the single first-call task.
   * Reassignment: open tasks follow the lead; a manual reassignment restarts the clock (override).
   */
  async onAssigned(
    tx: Tx,
    a: {
      lead: LeadRef;
      fromUserId: string | null;
      toUserId: string;
      type: 'AUTO' | 'MANUAL' | 'REASSIGN_AUTO' | 'RECOVERY';
      actorUserId: string | null;
      now: Date;
    },
  ): Promise<void> {
    const { lead, now } = a;
    if (a.fromUserId) await this.transferOpen(tx, lead, a.fromUserId, a.toUserId, now);
    // Recovery re-engagement has no first-response clock or first-call task (FR-012).
    if (a.type === 'RECOVERY') return;
    const status = (await tx.lead.findUnique({ where: { id: lead.id }, select: { status: true } }))
      ?.status;
    if (status === 'IN_RECOVERY' || status === 'LOST') return;
    if (a.type === 'REASSIGN_AUTO') {
      const inst = await this.sla.active(tx, lead.id);
      if (inst) {
        await tx.slaInstance.update({ where: { id: inst.id }, data: { ownerId: a.toUserId } });
        await this.sla.event(tx, inst, 'OWNER_CHANGED', now, {
          fromUserId: a.fromUserId,
          toUserId: a.toUserId,
        });
      }
    } else if (a.type === 'MANUAL' && a.fromUserId) {
      await this.sla.restart(tx, lead, a.toUserId, now);
    } else {
      await this.sla.start(tx, lead, a.toUserId, now);
    }

    const initial = await tx.task.findFirst({ where: { leadId: lead.id, isInitial: true } });
    if (!initial) {
      const inst = await this.sla.active(tx, lead.id);
      await this.create(tx, {
        lead,
        ownerId: a.toUserId,
        input: { type: 'FIRST_CALL', dueAt: (inst?.dueAt ?? now).toISOString(), priority: 'HIGH' },
        isInitial: true,
        createdById: a.actorUserId,
        now,
        notifyOwner: false, // the assignment notification already tells them
      });
    }
  }

  async create(
    tx: Tx,
    c: {
      lead: LeadRef;
      ownerId: string;
      input:
        | NewTaskInput
        | (Omit<NewTaskInput, 'priority'> & { priority?: NewTaskInput['priority'] });
      isInitial?: boolean;
      createdById: string | null;
      now: Date;
      notifyOwner?: boolean;
    },
  ): Promise<Task> {
    const { lead, input, now } = c;
    const task = await tx.task.create({
      data: {
        organizationId: lead.organizationId,
        brandId: lead.brandId,
        leadId: lead.id,
        ownerId: c.ownerId,
        type: input.type,
        title: input.title?.trim() || DEFAULT_TITLES[input.type],
        priority: input.priority ?? 'NORMAL',
        dueAt: new Date(input.dueAt),
        notes: input.notes ?? null,
        isInitial: c.isInitial ?? false,
        createdById: c.createdById,
        createdAt: now,
      },
    });
    await this.scheduleDue(tx, task);
    await this.leadEvent(tx, task, 'TASK_CREATED', `${task.title} due`, c.createdById, now, {
      dueAt: task.dueAt,
      ownerId: task.ownerId,
      isInitial: task.isInitial,
    });
    if (c.notifyOwner !== false && c.ownerId !== c.createdById) {
      await this.notifications.create(tx, {
        organizationId: lead.organizationId,
        userId: c.ownerId,
        type: 'TASK_ASSIGNED',
        title: `New task: ${task.title} — ${lead.person.fullName} (${lead.leadNumber})`,
        link: `/leads/${lead.id}`,
        dedupKey: `task-new:${task.id}`,
        now,
      });
    }
    return task;
  }

  /** A reminder when the task falls due (key includes the due time, so a reschedule gets a new job). */
  scheduleDue(tx: Tx, task: Task) {
    return this.jobs.enqueue(tx, {
      organizationId: task.organizationId,
      type: 'task.due',
      key: `task:${task.id}:due:${task.dueAt.toISOString()}`,
      payload: { taskId: task.id, dueAt: task.dueAt.toISOString() },
      runAt: task.dueAt,
    });
  }

  private async transferOpen(
    tx: Tx,
    lead: LeadRef,
    fromUserId: string,
    toUserId: string,
    now: Date,
  ) {
    const moved = await tx.task.updateMany({
      where: { leadId: lead.id, status: 'OPEN', ownerId: fromUserId },
      data: { ownerId: toUserId },
    });
    if (moved.count) {
      await tx.leadEvent.create({
        data: {
          organizationId: lead.organizationId,
          leadId: lead.id,
          type: 'TASKS_TRANSFERRED',
          body: `${moved.count} open task(s) moved to the new owner`,
          data: { fromUserId, toUserId, count: moved.count },
          occurredAt: now,
        },
      });
    }
  }

  /** The lead is no longer worked (merged / closed): stop the clock and cancel open tasks. */
  async closeLead(tx: Tx, leadId: string, reason: string, actorUserId: string | null, now: Date) {
    await this.sla.cancel(tx, leadId, reason, now);
    await tx.task.updateMany({
      where: { leadId, status: 'OPEN' },
      data: {
        status: 'CANCELLED',
        cancelReason: reason,
        cancelledAt: now,
        cancelledById: actorUserId,
      },
    });
  }

  leadEvent(
    tx: Tx,
    task: { organizationId: string; leadId: string; id: string; type: string },
    type: string,
    body: string,
    actorUserId: string | null,
    now: Date,
    data: Record<string, unknown> = {},
  ) {
    return tx.leadEvent.create({
      data: {
        organizationId: task.organizationId,
        leadId: task.leadId,
        type,
        actorUserId,
        body,
        data: JSON.parse(JSON.stringify({ taskId: task.id, taskType: task.type, ...data })),
        occurredAt: now,
      },
    });
  }

  auditTask(
    tx: Tx,
    task: { organizationId: string; brandId: string; id: string },
    action: string,
    actorUserId: string,
    after: Record<string, unknown>,
    reason?: string,
  ) {
    return this.audit.record(tx, {
      organizationId: task.organizationId,
      brandId: task.brandId,
      actorUserId,
      action,
      entityType: 'task',
      entityId: task.id,
      after,
      reason,
    });
  }
}
