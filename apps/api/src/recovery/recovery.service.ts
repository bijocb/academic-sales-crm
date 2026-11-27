import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RecoveryCase } from '@prisma/client';
import {
  CloseRecoverySchema,
  LossReasonSchema,
  MarkLostSchema,
  RecoveryAttemptSchema,
  RecoveryPolicySchema,
  RecoveryQueueQuerySchema,
  UpdateLossReasonSchema,
  z,
} from '@crm/contracts';
import { AllocationService } from '../allocation/allocation.service';
import { NotificationsService } from '../allocation/notifications.service';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { recordActivity } from '../engagement/activity-writer';
import { JobRow, JobsService } from '../jobs/jobs.service';
import { LeadsService } from '../leads/leads.service';
import { changeLeadStatus } from '../leads/status-history';
import { addWorkingMinutes, isWorkingTime } from '../settings/business-calendar';
import { SettingsService } from '../settings/settings.service';
import { brandManagers } from '../work/recipients';
import { SlaClockService } from '../work/sla-clock.service';
import { TaskCoreService } from '../work/task-core.service';
import { closeRecoveryCase } from './recovery-hooks';

const DAY = 24 * 60 * 60_000;
const CALL_OUTCOME: Record<string, string> = {
  NO_RESPONSE: 'NO_ANSWER',
  CALL_BACK_LATER: 'CALL_BACK_REQUESTED',
  NOT_INTERESTED: 'CONNECTED',
  INTERESTED: 'CONNECTED',
  OPTED_OUT: 'CONNECTED',
};

/** Lost leads, recovery cases and closure (FR-012). See docs/plans/PHASE-10.md. */
@Injectable()
export class RecoveryService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly leads: LeadsService,
    private readonly allocation: AllocationService,
    private readonly tasks: TaskCoreService,
    private readonly sla: SlaClockService,
    private readonly jobs: JobsService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('recovery.start', (j) => this.onStartJob(j));
  }

  // -------------------------------------------------------------- access
  private canManage(p: OrgPrincipal, brandId: string) {
    const v = p.authz.visibleBrandIds('recovery.manage');
    return v.all || v.brandIds.includes(brandId);
  }

  private canWork(p: OrgPrincipal, brandId: string) {
    const v = p.authz.visibleBrandIds('pipeline.transition');
    return this.leads.canEdit(p, brandId) && (v.all || v.brandIds.includes(brandId));
  }

  private policy(tx: Tx, brandId: string) {
    return tx.recoveryPolicy.findUniqueOrThrow({ where: { brandId } });
  }

  private leadEvent(
    tx: Tx,
    lead: { id: string; organizationId: string },
    type: string,
    body: string,
    actorUserId: string | null,
    now: Date,
    data: Record<string, unknown> = {},
  ) {
    return tx.leadEvent.create({
      data: {
        organizationId: lead.organizationId,
        leadId: lead.id,
        type,
        actorUserId,
        body,
        data: JSON.parse(JSON.stringify(data)),
        occurredAt: now,
      },
    });
  }

  // ------------------------------------------------------------ mark lost
  markLost(p: OrgPrincipal, leadId: string, input: z.infer<typeof MarkLostSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM leads WHERE id = ${leadId}::uuid FOR UPDATE`;
      const lead = await this.leads.visibleLead(tx, p, leadId);
      if (!this.canWork(p, lead.brandId)) throw forbidden();
      if (lead.status !== 'OPEN' && lead.status !== 'ON_HOLD')
        throw badRequest('LEAD_NOT_OPEN', 'Only open or on-hold leads can be marked lost');
      const reason = await tx.lossReason.findFirst({
        where: { id: input.lossReasonId, brandId: lead.brandId, active: true },
      });
      if (!reason)
        throw badRequest('INVALID_LOSS_REASON', 'Choose an active loss reason of this brand');
      const policy = await this.policy(tx, lead.brandId);
      if (input.plan === 'RECOVER') {
        if (!reason.recoverable)
          throw badRequest(
            'REASON_NOT_RECOVERABLE',
            `"${reason.label}" leads are closed, not recovered`,
          );
        if (!policy.enabled)
          throw badRequest('RECOVERY_DISABLED', 'Recovery is switched off for this brand');
        if (lead.person.doNotContact)
          throw conflict(
            'OPTED_OUT',
            'This person asked not to be contacted, so recovery is not allowed',
          );
      } else if (reason.recoverable && !this.canManage(p, lead.brandId)) {
        throw forbidden('Closing a lead without recovery needs a manager');
      }

      await this.sla.cancel(tx, leadId, 'Lead marked lost', now);
      await tx.task.updateMany({
        where: { leadId, status: 'OPEN' },
        data: {
          status: 'CANCELLED',
          cancelReason: 'Lead marked lost',
          cancelledAt: now,
          cancelledById: p.userId,
        },
      });

      let recoveryCase: RecoveryCase | null = null;
      if (input.plan === 'RECOVER') {
        await changeLeadStatus(tx, {
          lead,
          to: 'LOST',
          reasonCode: reason.code,
          notes: input.notes,
          actorUserId: p.userId,
          now,
        });
        recoveryCase = await tx.recoveryCase.create({
          data: {
            organizationId: lead.organizationId,
            brandId: lead.brandId,
            leadId,
            lossReasonId: reason.id,
            lossNotes: input.notes,
            lostById: p.userId,
            lostAt: now,
            previousOwnerId: lead.ownerId,
            startsAt: new Date(now.getTime() + policy.cooldownDays * DAY),
            maxAttempts: policy.maxAttempts,
            createdAt: now,
          },
        });
        await this.jobs.enqueue(tx, {
          organizationId: lead.organizationId,
          type: 'recovery.start',
          key: `recovery:${recoveryCase.id}:start`,
          payload: { caseId: recoveryCase.id },
          runAt: recoveryCase.startsAt,
        });
      } else {
        await changeLeadStatus(tx, {
          lead,
          to: 'CLOSED_LOST',
          reasonCode: reason.code,
          notes: input.notes,
          actorUserId: p.userId,
          now,
        });
      }
      await this.leadEvent(
        tx,
        lead,
        'LEAD_LOST',
        `Lost — ${reason.label}: ${input.notes}${recoveryCase ? ` · recovery from ${recoveryCase.startsAt.toISOString().slice(0, 10)}` : ' · closed'}`,
        p.userId,
        now,
        { reasonCode: reason.code, plan: input.plan, recoveryCaseId: recoveryCase?.id ?? null },
      );
      await this.audit.record(tx, {
        organizationId: lead.organizationId,
        brandId: lead.brandId,
        actorUserId: p.userId,
        action: input.plan === 'RECOVER' ? 'lead.lost' : 'lead.closed_lost',
        entityType: 'lead',
        entityId: leadId,
        before: { status: lead.status },
        after: {
          status: input.plan === 'RECOVER' ? 'LOST' : 'CLOSED_LOST',
          reasonCode: reason.code,
        },
        reason: input.notes,
      });
      return { status: input.plan === 'RECOVER' ? 'LOST' : 'CLOSED_LOST', recoveryCase };
    });
  }

  // ------------------------------------------------------------ start case
  private async onStartJob(job: JobRow): Promise<void | { retryAt: Date }> {
    const { caseId } = job.payload as { caseId: string };
    return this.start(job.organizationId!, caseId, null);
  }

  /** Cooldown over (or manager starts early): put the lead back in someone's hands. */
  private async start(
    orgId: string,
    caseId: string,
    actorUserId: string | null,
  ): Promise<void | { retryAt: Date }> {
    const now = this.clock.now();
    const step = await this.db.tenant(orgId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM recovery_cases WHERE id = ${caseId}::uuid FOR UPDATE`;
      const c = await tx.recoveryCase.findUnique({ where: { id: caseId } });
      if (!c || c.status !== 'SCHEDULED') return { kind: 'skip' as const };
      const lead = await tx.lead.findUniqueOrThrow({
        where: { id: c.leadId },
        include: { person: true },
      });
      if (lead.status !== 'LOST') {
        await tx.recoveryCase.update({
          where: { id: c.id },
          data: { status: 'CANCELLED', closedAt: now, closeReason: `Lead is ${lead.status}` },
        });
        return { kind: 'skip' as const };
      }
      if (lead.person.doNotContact) {
        await closeRecoveryCase(
          tx,
          c,
          'The person opted out of contact',
          'OPTED_OUT',
          actorUserId,
          now,
        );
        return { kind: 'skip' as const };
      }
      const policy = await this.policy(tx, c.brandId);
      if (policy.ownerMode === 'DIFFERENT_EXECUTIVE') {
        const alloc = await tx.allocationSettings.findUnique({ where: { brandId: c.brandId } });
        const cal = await this.settings.calendar(tx, c.brandId);
        if (alloc?.respectWorkingHours !== false && !isWorkingTime(now, cal))
          return { kind: 'retry' as const, at: addWorkingMinutes(now, 0, cal) };
      }
      await changeLeadStatus(tx, {
        lead,
        to: 'IN_RECOVERY',
        reasonCode: 'RECOVERY_STARTED',
        actorUserId,
        now,
      });
      await tx.recoveryCase.update({
        where: { id: c.id },
        data: {
          status: 'ACTIVE',
          startedAt: now,
          nextAttemptAt: now,
          ownerId: policy.ownerMode === 'SAME_OWNER' ? lead.ownerId : null,
        },
      });
      return { kind: 'started' as const, mode: policy.ownerMode, leadId: lead.id };
    });
    if (step.kind === 'retry') return { retryAt: step.at };
    if (step.kind !== 'started') return;

    // Allocation opens its own transaction and records the RECOVERY assignment (previous owners excluded).
    if (step.mode === 'DIFFERENT_EXECUTIVE')
      await this.allocation.allocate(orgId, step.leadId, { trigger: 'RECOVERY', actorUserId });

    await this.db.tenant(orgId, async (tx) => {
      const c = await tx.recoveryCase.findUniqueOrThrow({ where: { id: caseId } });
      const lead = await tx.lead.findUniqueOrThrow({
        where: { id: c.leadId },
        include: { person: { select: { fullName: true } } },
      });
      const reason = await tx.lossReason.findUnique({ where: { id: c.lossReasonId } });
      if (c.ownerId) {
        await this.tasks.create(tx, {
          lead,
          ownerId: c.ownerId,
          input: {
            type: 'CALL_BACK',
            title: 'Recovery call 1',
            dueAt: now.toISOString(),
            priority: 'HIGH',
            notes: `Lost: ${reason?.label ?? ''} — ${c.lossNotes}`,
          },
          createdById: actorUserId,
          now,
        });
      } else {
        for (const userId of await brandManagers(tx, c.brandId, 'recovery.manage'))
          await this.notifications.create(tx, {
            organizationId: c.organizationId,
            userId,
            type: 'RECOVERY_UNASSIGNED',
            title: `Recovery needs an owner: ${lead.person.fullName} (${lead.leadNumber})`,
            link: '/recovery',
            dedupKey: `recovery-owner:${c.id}`,
            now,
          });
      }
      await this.leadEvent(
        tx,
        lead,
        'RECOVERY_STARTED',
        c.ownerId ? 'Recovery started' : 'Recovery started — waiting for an owner',
        actorUserId,
        now,
        { recoveryCaseId: c.id, ownerId: c.ownerId },
      );
    });
  }

  startNow(p: OrgPrincipal, caseId: string) {
    return this.db
      .tenant(p.organizationId, async (tx) => {
        const c = await tx.recoveryCase.findUnique({ where: { id: caseId } });
        if (!c) throw notFound('Recovery case');
        await this.leads.visibleLead(tx, p, c.leadId);
        if (!this.canManage(p, c.brandId))
          throw forbidden('Starting recovery early needs a manager');
        if (c.status !== 'SCHEDULED')
          throw badRequest('CASE_NOT_SCHEDULED', 'This recovery case is not waiting');
        return c;
      })
      .then(async () => {
        const r = await this.start(p.organizationId, caseId, p.userId);
        if (r && 'retryAt' in r)
          throw badRequest(
            'OUTSIDE_WORKING_HOURS',
            'Recovery can start in working hours (a different executive is needed)',
          );
        return this.db.tenant(p.organizationId, (tx) =>
          tx.recoveryCase.findUniqueOrThrow({ where: { id: caseId } }),
        );
      });
  }

  // -------------------------------------------------------------- attempts
  attempt(p: OrgPrincipal, caseId: string, input: z.infer<typeof RecoveryAttemptSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM recovery_cases WHERE id = ${caseId}::uuid FOR UPDATE`;
      const c = await tx.recoveryCase.findUnique({ where: { id: caseId } });
      if (!c) throw notFound('Recovery case');
      const lead = await this.leads.visibleLead(tx, p, c.leadId);
      if (
        !this.leads.canEdit(p, c.brandId) ||
        (c.ownerId !== p.userId && !this.canManage(p, c.brandId))
      )
        throw forbidden('Only the recovery owner or a manager can log attempts');
      if (c.status !== 'ACTIVE')
        throw badRequest('CASE_NOT_ACTIVE', 'This recovery case is not active');
      if (lead.person.doNotContact && input.outcome !== 'OPTED_OUT')
        throw conflict('OPTED_OUT', 'This person asked not to be contacted');
      if (input.outcome === 'INTERESTED' && !input.nextTask)
        throw badRequest('NEXT_ACTION_REQUIRED', 'A recovered lead needs its next sales action');
      if (input.offeredCourseId) {
        const ok = await tx.course.count({
          where: { id: input.offeredCourseId, brandId: c.brandId },
        });
        if (!ok) throw badRequest('INVALID_COURSE', 'The offered course must belong to this brand');
      }
      const policy = await this.policy(tx, c.brandId);
      const attemptNo = c.attempts + 1;
      const last = attemptNo >= c.maxAttempts;
      const nextAt =
        input.outcome === 'INTERESTED' || input.outcome === 'OPTED_OUT' || last
          ? null
          : input.nextAttemptAt
            ? new Date(input.nextAttemptAt)
            : new Date(now.getTime() + policy.attemptIntervalDays * DAY);
      if (nextAt && nextAt <= now)
        throw badRequest('NEXT_ATTEMPT_IN_PAST', 'The next attempt must be in the future');

      await tx.recoveryAttempt.create({
        data: {
          organizationId: c.organizationId,
          caseId: c.id,
          leadId: c.leadId,
          attemptNo,
          channel: input.channel,
          outcome: input.outcome,
          notes: input.notes ?? null,
          offeredCourseId: input.offeredCourseId ?? null,
          nextAttemptAt: nextAt,
          actorUserId: p.userId,
          occurredAt: now,
        },
      });
      if (input.channel === 'CALL')
        await recordActivity(tx, {
          lead,
          type: 'CALL',
          direction: 'OUTBOUND',
          actorUserId: p.userId,
          now,
          startedAt: now,
          outcome: CALL_OUTCOME[input.outcome],
          body: `Recovery attempt ${attemptNo}: ${input.outcome.replace(/_/g, ' ').toLowerCase()}${input.notes ? ` — ${input.notes}` : ''}`,
          provider: 'manual',
        });
      await tx.task.updateMany({
        where: { leadId: c.leadId, status: 'OPEN' },
        data: {
          status: 'CANCELLED',
          cancelReason: `Recovery attempt ${attemptNo} logged`,
          cancelledAt: now,
          cancelledById: p.userId,
        },
      });
      await tx.recoveryCase.update({
        where: { id: c.id },
        data: { attempts: attemptNo, nextAttemptAt: nextAt },
      });
      await this.leadEvent(
        tx,
        lead,
        'RECOVERY_ATTEMPT',
        `Attempt ${attemptNo} (${input.channel.toLowerCase()}): ${input.outcome.replace(/_/g, ' ').toLowerCase()}${input.notes ? ` — ${input.notes}` : ''}`,
        p.userId,
        now,
        { recoveryCaseId: c.id, attemptNo, outcome: input.outcome },
      );

      let result: 'RECOVERED' | 'CLOSED' | 'CONTINUE' | 'AWAITING_MANAGER' = 'CONTINUE';
      if (input.outcome === 'INTERESTED') {
        await tx.recoveryCase.update({
          where: { id: c.id },
          data: { status: 'RECOVERED', closedAt: now, closeReason: 'Interested again' },
        });
        await changeLeadStatus(tx, {
          lead,
          to: 'OPEN',
          reasonCode: 'RECOVERED',
          notes: input.notes,
          actorUserId: p.userId,
          now,
        });
        await this.tasks.create(tx, {
          lead,
          ownerId: lead.ownerId ?? p.userId,
          input: input.nextTask!,
          createdById: p.userId,
          now,
        });
        await this.leadEvent(
          tx,
          lead,
          'LEAD_RECOVERED',
          'Recovered — back in the sales pipeline',
          p.userId,
          now,
          { recoveryCaseId: c.id },
        );
        result = 'RECOVERED';
      } else if (input.outcome === 'OPTED_OUT') {
        await tx.person.update({
          where: { id: lead.personId },
          data: { doNotContact: true, doNotContactAt: now },
        });
        await this.leadEvent(
          tx,
          lead,
          'OPTED_OUT',
          'Do not contact — asked during recovery',
          p.userId,
          now,
        );
        await closeRecoveryCase(
          tx,
          c,
          'The person opted out of contact',
          'OPTED_OUT',
          p.userId,
          now,
        );
        result = 'CLOSED';
      } else if (last) {
        if (policy.autoCloseAfterMax) {
          await closeRecoveryCase(
            tx,
            c,
            `No recovery after ${attemptNo} attempts`,
            'MAX_ATTEMPTS',
            p.userId,
            now,
          );
          result = 'CLOSED';
        } else result = 'AWAITING_MANAGER';
      } else {
        await this.tasks.create(tx, {
          lead,
          ownerId: c.ownerId ?? p.userId,
          input: {
            type: 'CALL_BACK',
            title: `Recovery call ${attemptNo + 1}`,
            dueAt: nextAt!.toISOString(),
            priority: 'NORMAL',
          },
          createdById: p.userId,
          now,
        });
      }
      await this.audit.record(tx, {
        organizationId: c.organizationId,
        brandId: c.brandId,
        actorUserId: p.userId,
        action: 'recovery.attempt',
        entityType: 'recovery_case',
        entityId: c.id,
        after: { attemptNo, outcome: input.outcome, result },
      });
      return { attemptNo, result, nextAttemptAt: nextAt };
    });
  }

  close(p: OrgPrincipal, caseId: string, input: z.infer<typeof CloseRecoverySchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const c = await tx.recoveryCase.findUnique({ where: { id: caseId } });
      if (!c) throw notFound('Recovery case');
      await this.leads.visibleLead(tx, p, c.leadId);
      if (!this.canManage(p, c.brandId)) throw forbidden('Closing a recovery case needs a manager');
      if (c.status !== 'SCHEDULED' && c.status !== 'ACTIVE')
        throw badRequest('CASE_CLOSED', 'This recovery case is already closed');
      await closeRecoveryCase(tx, c, input.reason, 'MANAGER_CLOSED', p.userId, now);
      await this.audit.record(tx, {
        organizationId: c.organizationId,
        brandId: c.brandId,
        actorUserId: p.userId,
        action: 'recovery.closed',
        entityType: 'recovery_case',
        entityId: c.id,
        reason: input.reason,
      });
      return tx.recoveryCase.findUniqueOrThrow({ where: { id: caseId } });
    });
  }

  // ----------------------------------------------------------------- reads
  forLead(p: OrgPrincipal, leadId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      const [cases, statusHistory] = await Promise.all([
        tx.recoveryCase.findMany({ where: { leadId }, orderBy: { createdAt: 'desc' } }),
        tx.leadStatusHistory.findMany({ where: { leadId }, orderBy: { occurredAt: 'asc' } }),
      ]);
      const [attempts, reasons, users] = await Promise.all([
        tx.recoveryAttempt.findMany({
          where: { caseId: { in: cases.map((c) => c.id) } },
          orderBy: { attemptNo: 'asc' },
        }),
        tx.lossReason.findMany({ where: { brandId: lead.brandId } }),
        tx.user.findMany({
          where: { id: { in: cases.map((c) => c.ownerId).filter((x): x is string => !!x) } },
          select: { id: true, name: true },
        }),
      ]);
      const reason = new Map(reasons.map((r) => [r.id, r]));
      const name = new Map(users.map((u) => [u.id, u.name]));
      return {
        canManage: this.canManage(p, lead.brandId),
        canWork: this.canWork(p, lead.brandId),
        cases: cases.map((c) => ({
          ...c,
          lossReason: reason.get(c.lossReasonId)?.label ?? null,
          ownerName: c.ownerId ? (name.get(c.ownerId) ?? null) : null,
          attemptsLog: attempts.filter((x) => x.caseId === c.id),
        })),
        statusHistory,
      };
    });
  }

  queue(p: OrgPrincipal, q: z.infer<typeof RecoveryQueueQuerySchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      let scope: Prisma.RecoveryCaseWhereInput;
      if (q.view === 'mine') scope = { ownerId: p.userId };
      else {
        const v = p.authz.visibleBrandIds('recovery.manage');
        if (!v.all && !v.brandIds.length) throw forbidden();
        scope = v.all ? {} : { brandId: { in: v.brandIds } };
      }
      const cases = await tx.recoveryCase.findMany({
        where: { ...scope, status: q.status, ...(q.brandId ? { brandId: q.brandId } : {}) },
        orderBy: [{ nextAttemptAt: { sort: 'asc', nulls: 'last' } }, { startsAt: 'asc' }],
        take: 200,
      });
      const [leads, reasons, users] = await Promise.all([
        tx.lead.findMany({
          where: { id: { in: cases.map((c) => c.leadId) } },
          select: { id: true, leadNumber: true, person: { select: { fullName: true } } },
        }),
        tx.lossReason.findMany({ where: { id: { in: cases.map((c) => c.lossReasonId) } } }),
        tx.user.findMany({
          where: { id: { in: cases.map((c) => c.ownerId).filter((x): x is string => !!x) } },
          select: { id: true, name: true },
        }),
      ]);
      const l = new Map(leads.map((x) => [x.id, x]));
      const r = new Map(reasons.map((x) => [x.id, x.label]));
      const u = new Map(users.map((x) => [x.id, x.name]));
      return cases.map((c) => ({
        id: c.id,
        leadId: c.leadId,
        leadNumber: l.get(c.leadId)?.leadNumber,
        name: l.get(c.leadId)?.person.fullName,
        status: c.status,
        lossReason: r.get(c.lossReasonId) ?? null,
        ownerName: c.ownerId ? (u.get(c.ownerId) ?? null) : null,
        attempts: c.attempts,
        maxAttempts: c.maxAttempts,
        startsAt: c.startsAt,
        nextAttemptAt: c.nextAttemptAt,
        due: !!c.nextAttemptAt && c.nextAttemptAt <= now,
        awaitingManager: c.status === 'ACTIVE' && c.attempts >= c.maxAttempts,
      }));
    });
  }

  // -------------------------------------------------------------- settings
  private assertSettings(p: OrgPrincipal, brandId: string) {
    if (!p.authz.can('settings.manage', { brandId })) throw forbidden();
  }

  lossReasons(p: OrgPrincipal, brandId: string) {
    const v = p.authz.visibleBrandIds('brand.read');
    if (!v.all && !v.brandIds.includes(brandId)) throw notFound('Brand');
    return this.db.tenant(p.organizationId, (tx) =>
      tx.lossReason.findMany({ where: { brandId }, orderBy: { position: 'asc' } }),
    );
  }

  createLossReason(p: OrgPrincipal, input: z.infer<typeof LossReasonSchema>) {
    this.assertSettings(p, input.brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const last = await tx.lossReason.aggregate({
        where: { brandId: input.brandId },
        _max: { position: true },
      });
      try {
        return await tx.lossReason.create({
          data: {
            organizationId: p.organizationId,
            ...input,
            position: (last._max.position ?? 0) + 1,
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw conflict('LOSS_REASON_EXISTS', 'This code is already used');
        throw e;
      }
    });
  }

  updateLossReason(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateLossReasonSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const r = await tx.lossReason.findUnique({ where: { id } });
      if (!r) throw notFound('Loss reason');
      this.assertSettings(p, r.brandId);
      const updated = await tx.lossReason.update({ where: { id }, data: input });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: r.brandId,
        action: 'loss_reason.updated',
        entityType: 'loss_reason',
        entityId: id,
        before: { label: r.label, recoverable: r.recoverable, active: r.active },
        after: input,
      });
      return updated;
    });
  }

  getPolicy(p: OrgPrincipal, brandId: string) {
    const v = p.authz.visibleBrandIds('brand.read');
    if (!v.all && !v.brandIds.includes(brandId)) throw notFound('Brand');
    return this.db.tenant(p.organizationId, (tx) => this.policy(tx, brandId));
  }

  updatePolicy(p: OrgPrincipal, brandId: string, input: z.infer<typeof RecoveryPolicySchema>) {
    this.assertSettings(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await this.policy(tx, brandId);
      const updated = await tx.recoveryPolicy.update({ where: { brandId }, data: input });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId,
        action: 'recovery_policy.updated',
        entityType: 'recovery_policy',
        entityId: before.id,
        before,
        after: input,
      });
      return updated;
    });
  }
}
