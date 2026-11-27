import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Lead, Task } from '@prisma/client';
import {
  CALL_TASK_TYPES,
  CancelTaskSchema,
  CompleteTaskSchema,
  CreateTaskSchema,
  HoldLeadSchema,
  NewTaskInput,
  outcomesFor,
  RescheduleTaskSchema,
  ResumeLeadSchema,
  TaskListQuerySchema,
  z,
} from '@crm/contracts';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { LeadsService } from '../leads/leads.service';
import { SettingsService } from '../settings/settings.service';
import { ACTIVE_STATES, SlaClockService } from './sla-clock.service';
import { TaskCoreService } from './task-core.service';
import { recordActivity } from '../engagement/activity-writer';

const WORKABLE = ['OPEN', 'ON_HOLD', 'IN_RECOVERY'];

/** Task and SLA API (FR-008, FR-009). See docs/plans/PHASE-07.md. */
@Injectable()
export class WorkService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly leads: LeadsService,
    private readonly core: TaskCoreService,
    private readonly sla: SlaClockService,
    private readonly jobs: JobsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  private auditLead(
    tx: Tx,
    p: OrgPrincipal,
    lead: { id: string; brandId: string; status: string },
    action: string,
    after: Record<string, unknown>,
    reason?: string,
  ) {
    return this.audit.record(tx, {
      organizationId: p.organizationId,
      brandId: lead.brandId,
      actorUserId: p.userId,
      action,
      entityType: 'lead',
      entityId: lead.id,
      before: { status: lead.status },
      after,
      reason,
    });
  }

  // ------------------------------------------------------------- access
  /** task.manage over the task's brand, or over the teams the task owner belongs to. */
  private async canManage(tx: Tx, p: OrgPrincipal, t: { brandId: string; ownerId: string }) {
    if (p.authz.can('task.manage', { brandId: t.brandId })) return true;
    const s = p.authz.scope('task.manage');
    if (!s.teamIds.length && !s.branchIds.length) return false;
    const m = await tx.teamMember.findFirst({
      where: {
        userId: t.ownerId,
        leftAt: null,
        team: { OR: [{ id: { in: s.teamIds } }, { branchId: { in: s.branchIds } }] },
      },
    });
    return !!m;
  }

  /** Owner or manager may act; anyone else gets 404 (out of scope). */
  private async taskForAction(tx: Tx, p: OrgPrincipal, id: string): Promise<Task> {
    const t = await tx.task.findUnique({ where: { id } });
    if (!t || (t.ownerId !== p.userId && !(await this.canManage(tx, p, t)))) throw notFound('Task');
    if (t.status !== 'OPEN') throw badRequest('TASK_NOT_OPEN', 'This task is already closed');
    return t;
  }

  private async teamWhere(tx: Tx, p: OrgPrincipal): Promise<Prisma.TaskWhereInput> {
    const s = p.authz.scope('task.manage');
    if (s.all) return {};
    const or: Prisma.TaskWhereInput[] = [];
    if (s.brandIds.length) or.push({ brandId: { in: s.brandIds } });
    if (s.teamIds.length || s.branchIds.length) {
      const members = await tx.teamMember.findMany({
        where: {
          leftAt: null,
          team: { OR: [{ id: { in: s.teamIds } }, { branchId: { in: s.branchIds } }] },
        },
        select: { userId: true },
      });
      if (members.length) or.push({ ownerId: { in: members.map((m) => m.userId) } });
    }
    if (!or.length) throw forbidden();
    return { OR: or };
  }

  /** Next-action rule (FR-008): an open lead must keep an open task unless a next one is given. */
  private async assertNextAction(
    tx: Tx,
    lead: Pick<Lead, 'id' | 'status'>,
    closingTaskId: string | null,
    nextTask: unknown,
  ) {
    if (lead.status !== 'OPEN' || nextTask) return;
    const others = await tx.task.count({
      where: {
        leadId: lead.id,
        status: 'OPEN',
        ...(closingTaskId ? { id: { not: closingTaskId } } : {}),
      },
    });
    if (!others)
      throw badRequest(
        'NEXT_ACTION_REQUIRED',
        'This is the last open task on an open lead: schedule the next action (or put the lead on hold).',
      );
  }

  private leadRef(tx: Tx, leadId: string) {
    return tx.lead.findUniqueOrThrow({
      where: { id: leadId },
      include: { person: { select: { fullName: true } } },
    });
  }

  private nextOwner(
    lead: Pick<Lead, 'ownerId'>,
    task: Pick<Task, 'ownerId'> | null,
    p: OrgPrincipal,
  ) {
    return lead.ownerId ?? task?.ownerId ?? p.userId;
  }

  // -------------------------------------------------------------- reads
  list(p: OrgPrincipal, q: z.infer<typeof TaskListQuerySchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const scope = q.view === 'mine' ? { ownerId: p.userId } : await this.teamWhere(tx, p);
      const due: Prisma.DateTimeFilter = {};
      if (q.due === 'overdue') due.lt = now;
      if (q.due === 'upcoming') due.gte = now;
      if (q.dueBefore) due.lt = new Date(q.dueBefore);
      const tasks = await tx.task.findMany({
        where: {
          AND: [
            scope,
            { status: q.status },
            q.ownerId ? { ownerId: q.ownerId } : {},
            q.brandId ? { brandId: q.brandId } : {},
            Object.keys(due).length ? { dueAt: due } : {},
          ],
        },
        orderBy: q.status === 'OPEN' ? { dueAt: 'asc' } : { updatedAt: 'desc' },
        take: 200,
      });
      return this.present(tx, tasks, now);
    });
  }

  forLead(p: OrgPrincipal, leadId: string) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.leads.visibleLead(tx, p, leadId);
      const tasks = await tx.task.findMany({
        where: { leadId },
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
      });
      return this.present(tx, tasks, now);
    });
  }

  private async present(tx: Tx, tasks: Task[], now: Date) {
    const ids = [...new Set(tasks.map((t) => t.ownerId))];
    const leads = new Map(
      (
        await tx.lead.findMany({
          where: { id: { in: [...new Set(tasks.map((t) => t.leadId))] } },
          select: {
            id: true,
            leadNumber: true,
            status: true,
            person: { select: { fullName: true } },
          },
        })
      ).map((l) => [l.id, l]),
    );
    const names = new Map(
      (
        await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      ).map((u) => [u.id, u.name]),
    );
    return tasks.map((t) => ({
      ...t,
      ownerName: names.get(t.ownerId) ?? null,
      lead: leads.get(t.leadId) ?? null,
      overdue: t.status === 'OPEN' && t.dueAt < now,
      allowedOutcomes: outcomesFor(t.type),
    }));
  }

  // ------------------------------------------------------------- writes
  create(p: OrgPrincipal, leadId: string, input: z.infer<typeof CreateTaskSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      if (!WORKABLE.includes(lead.status))
        throw badRequest('LEAD_NOT_ACTIVE', 'Tasks can only be added to active leads');
      const ownerId = input.ownerId ?? lead.ownerId ?? p.userId;
      const selfOrOwner = ownerId === p.userId && (lead.ownerId === p.userId || !lead.ownerId);
      const manager = await this.canManage(tx, p, { brandId: lead.brandId, ownerId });
      if (!manager && !(selfOrOwner && this.leads.canEdit(p, lead.brandId))) throw forbidden();
      const owner = await tx.user.findFirst({ where: { id: ownerId, status: 'ACTIVE' } });
      if (!owner) throw badRequest('INVALID_OWNER', 'The task owner must be an active user');
      const { ownerId: _ignored, ...task } = input;
      void _ignored;
      return this.core.create(tx, { lead, ownerId, input: task, createdById: p.userId, now });
    });
  }

  complete(p: OrgPrincipal, id: string, input: z.infer<typeof CompleteTaskSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const task = await this.taskForAction(tx, p, id);
      if (!outcomesFor(task.type).includes(input.outcome))
        throw badRequest(
          'INVALID_OUTCOME',
          `Outcome ${input.outcome} does not fit a ${task.type} task`,
          {
            allowed: outcomesFor(task.type),
          },
        );
      const lead = await this.leadRef(tx, task.leadId);
      await this.assertNextAction(tx, lead, task.id, input.nextTask);
      const done = await tx.task.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          outcome: input.outcome,
          notes: input.notes ? [task.notes, input.notes].filter(Boolean).join('\n') : task.notes,
          completedAt: now,
          completedById: p.userId,
        },
      });
      await this.core.leadEvent(
        tx,
        task,
        'TASK_COMPLETED',
        `${task.title}: ${input.outcome.replace(/_/g, ' ').toLowerCase()}${input.notes ? ` — ${input.notes}` : ''}`,
        p.userId,
        now,
        { outcome: input.outcome },
      );
      // Phase 8: a completed call task is also a call in the interaction history.
      if (CALL_TASK_TYPES.includes(task.type))
        await recordActivity(tx, {
          lead,
          type: 'CALL',
          direction: 'OUTBOUND',
          actorUserId: p.userId,
          now,
          startedAt: now,
          outcome: input.outcome,
          body: input.notes ?? null,
          provider: 'manual',
          taskId: task.id,
        });
      // A-011: any call attempt is the first response; "connected" is kept as the outcome.
      const sla = CALL_TASK_TYPES.includes(task.type)
        ? await this.sla.resolve(tx, lead.id, {
            resolution: input.outcome,
            byUserId: p.userId,
            now,
          })
        : null;
      const next = input.nextTask
        ? await this.core.create(tx, {
            lead,
            ownerId: this.nextOwner(lead, task, p),
            input: input.nextTask,
            createdById: p.userId,
            now,
          })
        : null;
      await this.core.auditTask(tx, task, 'task.completed', p.userId, {
        outcome: input.outcome,
        nextTaskId: next?.id ?? null,
      });
      return { task: done, nextTask: next, slaResolved: !!sla };
    });
  }

  reschedule(p: OrgPrincipal, id: string, input: z.infer<typeof RescheduleTaskSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const task = await this.taskForAction(tx, p, id);
      const dueAt = new Date(input.dueAt);
      const updated = await tx.task.update({
        where: { id },
        data: { dueAt, rescheduleCount: { increment: 1 } },
      });
      await this.core.scheduleDue(tx, updated);
      await this.core.leadEvent(
        tx,
        task,
        'TASK_RESCHEDULED',
        `${task.title} moved${input.reason ? ` — ${input.reason}` : ''}`,
        p.userId,
        now,
        { from: task.dueAt, to: dueAt },
      );
      await this.core.auditTask(
        tx,
        task,
        'task.rescheduled',
        p.userId,
        { from: task.dueAt, to: dueAt },
        input.reason,
      );
      return updated;
    });
  }

  cancel(p: OrgPrincipal, id: string, input: z.infer<typeof CancelTaskSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const task = await this.taskForAction(tx, p, id);
      const lead = await this.leadRef(tx, task.leadId);
      await this.assertNextAction(tx, lead, task.id, input.nextTask);
      const cancelled = await tx.task.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelReason: input.reason,
          cancelledAt: now,
          cancelledById: p.userId,
        },
      });
      await this.core.leadEvent(
        tx,
        task,
        'TASK_CANCELLED',
        `${task.title} cancelled — ${input.reason}`,
        p.userId,
        now,
      );
      const next = input.nextTask
        ? await this.core.create(tx, {
            lead,
            ownerId: this.nextOwner(lead, task, p),
            input: input.nextTask,
            createdById: p.userId,
            now,
          })
        : null;
      await this.core.auditTask(
        tx,
        task,
        'task.cancelled',
        p.userId,
        { nextTaskId: next?.id ?? null },
        input.reason,
      );
      return { task: cancelled, nextTask: next };
    });
  }

  // ---------------------------------------------------------- hold/resume
  hold(p: OrgPrincipal, leadId: string, input: z.infer<typeof HoldLeadSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      if (!this.leads.canEdit(p, lead.brandId)) throw forbidden();
      if (lead.status !== 'OPEN')
        throw badRequest('LEAD_NOT_OPEN', 'Only open leads can be put on hold');
      await tx.lead.update({ where: { id: leadId }, data: { status: 'ON_HOLD' } });
      await this.sla.pause(tx, leadId, input.reason, now);
      if (input.until && lead.ownerId) {
        const cal = await this.settings.calendar(tx, lead.brandId);
        const runAt = DateTime.fromISO(input.until, { zone: cal.timezone })
          .startOf('day')
          .plus({ hours: 9 })
          .toJSDate();
        await this.jobs.enqueue(tx, {
          organizationId: lead.organizationId,
          type: 'lead.hold_review',
          key: `hold:${leadId}:${now.toISOString()}`,
          payload: { leadId, holdStartedAt: now.toISOString() },
          runAt,
        });
      }
      await tx.leadEvent.create({
        data: {
          organizationId: lead.organizationId,
          leadId,
          type: 'LEAD_ON_HOLD',
          actorUserId: p.userId,
          body: `On hold${input.until ? ` until ${input.until}` : ''} — ${input.reason}`,
          data: { reason: input.reason, until: input.until ?? null },
          occurredAt: now,
        },
      });
      await this.auditLead(
        tx,
        p,
        lead,
        'lead.on_hold',
        { status: 'ON_HOLD', until: input.until },
        input.reason,
      );
      return { status: 'ON_HOLD' };
    });
  }

  resume(p: OrgPrincipal, leadId: string, input: z.infer<typeof ResumeLeadSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      if (!this.leads.canEdit(p, lead.brandId)) throw forbidden();
      if (lead.status !== 'ON_HOLD')
        throw badRequest('LEAD_NOT_ON_HOLD', 'This lead is not on hold');
      await this.assertNextAction(tx, { id: leadId, status: 'OPEN' }, null, input.nextTask);
      await tx.lead.update({ where: { id: leadId }, data: { status: 'OPEN' } });
      await this.sla.resume(tx, leadId, now);
      const next = input.nextTask
        ? await this.core.create(tx, {
            lead,
            ownerId: this.nextOwner(lead, null, p),
            input: input.nextTask as NewTaskInput,
            createdById: p.userId,
            now,
          })
        : null;
      await tx.leadEvent.create({
        data: {
          organizationId: lead.organizationId,
          leadId,
          type: 'LEAD_RESUMED',
          actorUserId: p.userId,
          body: 'Back from hold',
          occurredAt: now,
        },
      });
      await this.auditLead(tx, p, lead, 'lead.resumed', { status: 'OPEN' });
      return { status: 'OPEN', nextTask: next };
    });
  }

  // ----------------------------------------------------------------- SLA
  leadSla(p: OrgPrincipal, leadId: string) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.leads.visibleLead(tx, p, leadId);
      const inst = await tx.slaInstance.findFirst({
        where: { leadId },
        orderBy: { startedAt: 'desc' },
      });
      if (!inst) return { current: null };
      const events = await tx.slaEvent.findMany({
        where: { slaInstanceId: inst.id },
        orderBy: { occurredAt: 'asc' },
      });
      const elapsed = ACTIVE_STATES.includes(inst.state)
        ? await this.sla.elapsed(tx, inst, now)
        : { calendar: inst.calendarMinutes, working: inst.workingMinutes };
      return { current: { ...inst, elapsed, events } };
    });
  }

  /** Brands where the caller may watch SLAs (task.manage or allocation.manage). */
  private slaBrands(p: OrgPrincipal, brandId?: string): Prisma.SlaInstanceWhereInput {
    const a = p.authz.visibleBrandIds('task.manage');
    const b = p.authz.visibleBrandIds('allocation.manage');
    const all = a.all || b.all;
    const ids = new Set([...a.brandIds, ...b.brandIds]);
    if (brandId) {
      if (!all && !ids.has(brandId)) throw notFound('Brand');
      return { brandId };
    }
    if (all) return {};
    if (!ids.size) throw forbidden();
    return { brandId: { in: [...ids] } };
  }

  overview(p: OrgPrincipal, brandId?: string) {
    const now = this.clock.now();
    const scope = this.slaBrands(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const since = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
      const [byState, watch, resolved] = await Promise.all([
        tx.slaInstance.groupBy({
          by: ['state'],
          where: { ...scope, state: { in: ACTIVE_STATES } },
          _count: { _all: true },
        }),
        tx.slaInstance.findMany({
          where: {
            ...scope,
            OR: [
              { state: { in: ['AT_RISK', 'BREACHED'] } },
              { escalatedAt: { not: null }, state: { in: ACTIVE_STATES } },
            ],
          },
          orderBy: [{ escalatedAt: { sort: 'desc', nulls: 'last' } }, { dueAt: 'asc' }],
          take: 200,
        }),
        tx.slaInstance.findMany({
          where: { ...scope, state: 'RESOLVED', resolvedAt: { gte: since } },
          select: {
            breachedAt: true,
            workingMinutes: true,
            calendarMinutes: true,
            resolution: true,
          },
        }),
      ]);
      const leadIds = watch.map((w) => w.leadId);
      const [leads, users] = await Promise.all([
        tx.lead.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, leadNumber: true, person: { select: { fullName: true } } },
        }),
        tx.user.findMany({
          where: { id: { in: [...new Set(watch.map((w) => w.ownerId))] } },
          select: { id: true, name: true },
        }),
      ]);
      const leadMap = new Map(leads.map((l) => [l.id, l]));
      const userMap = new Map(users.map((u) => [u.id, u.name]));
      const rows = [];
      for (const w of watch) {
        rows.push({
          id: w.id,
          leadId: w.leadId,
          leadNumber: leadMap.get(w.leadId)?.leadNumber,
          leadName: leadMap.get(w.leadId)?.person.fullName,
          ownerName: userMap.get(w.ownerId) ?? null,
          state: w.state,
          dueAt: w.dueAt,
          escalatedAt: w.escalatedAt,
          breachedAt: w.breachedAt,
          elapsed: await this.sla.elapsed(tx, w, now),
        });
      }
      const avg = (xs: Array<number | null>) => {
        const v = xs.filter((x): x is number => x !== null);
        return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
      };
      return {
        active: Object.fromEntries(byState.map((s) => [s.state, s._count._all])),
        last30Days: {
          resolved: resolved.length,
          withinTarget: resolved.filter((r) => !r.breachedAt).length,
          connected: resolved.filter((r) => r.resolution === 'CONNECTED').length,
          avgWorkingMinutes: avg(resolved.map((r) => r.workingMinutes)),
          avgCalendarMinutes: avg(resolved.map((r) => r.calendarMinutes)),
        },
        priorityQueue: rows.filter((r) => r.escalatedAt),
        watchList: rows.filter((r) => !r.escalatedAt),
      };
    });
  }

  /** Job queue health for operations (organization-wide settings.manage). */
  private assertOps(p: OrgPrincipal) {
    if (!p.authz.can('settings.manage') && !p.authz.can('allocation.manage')) throw forbidden();
  }

  jobsList(p: OrgPrincipal, status?: string) {
    this.assertOps(p);
    return Promise.all([
      this.jobs.list(p.organizationId, status),
      this.jobs.counts(p.organizationId),
    ]).then(([items, counts]) => ({ items, counts }));
  }

  retryJob(p: OrgPrincipal, id: string) {
    this.assertOps(p);
    return this.jobs.retry(p.organizationId, id);
  }
}
