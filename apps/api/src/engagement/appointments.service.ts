import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Appointment } from '@prisma/client';
import {
  AppointmentListQuerySchema,
  CounsellingRecordSchema,
  CancelAppointmentSchema,
  CompleteAppointmentSchema,
  CreateAppointmentSchema,
  RescheduleAppointmentSchema,
  z,
} from '@crm/contracts';
import { DateTime } from 'luxon';
import { NotificationsService } from '../allocation/notifications.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { JobRow, JobsService } from '../jobs/jobs.service';
import { LeadsService } from '../leads/leads.service';
import { TaskCoreService } from '../work/task-core.service';

/** ASSUMED (A-035): reminder 60 minutes before the appointment. */
const REMINDER_MINUTES = 60;
const WORKABLE = ['OPEN', 'ON_HOLD', 'IN_RECOVERY'];

/** Counselling appointments (FR-010). */
@Injectable()
export class AppointmentsService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly leads: LeadsService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly tasks: TaskCoreService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('appointment.reminder', (j) => this.remind(j));
  }

  private async assertNoOverlap(
    tx: Tx,
    counsellorId: string,
    startsAt: Date,
    endsAt: Date,
    exceptId?: string,
  ) {
    const clash = await tx.appointment.findFirst({
      where: {
        counsellorId,
        status: 'SCHEDULED',
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });
    if (clash)
      throw conflict(
        'APPOINTMENT_CONFLICT',
        'The counsellor already has an appointment at that time',
      );
  }

  private scheduleReminder(tx: Tx, a: Appointment, now: Date) {
    const runAt = new Date(a.startsAt.getTime() - REMINDER_MINUTES * 60_000);
    if (a.startsAt <= now) return;
    return this.jobs.enqueue(tx, {
      organizationId: a.organizationId,
      type: 'appointment.reminder',
      key: `appt:${a.id}:remind:${a.startsAt.toISOString()}`,
      payload: { appointmentId: a.id, startsAt: a.startsAt.toISOString() },
      runAt: runAt < now ? now : runAt,
    });
  }

  private event(
    tx: Tx,
    a: Appointment,
    type: string,
    body: string,
    actorUserId: string | null,
    now: Date,
  ) {
    return tx.leadEvent.create({
      data: {
        organizationId: a.organizationId,
        leadId: a.leadId,
        type,
        actorUserId,
        body,
        data: { appointmentId: a.id, startsAt: a.startsAt.toISOString(), mode: a.mode },
        occurredAt: now,
      },
    });
  }

  /** Counsellor, lead owner, creator, or task.manage over the brand; otherwise 404. */
  private async forAction(tx: Tx, p: OrgPrincipal, id: string) {
    const a = await tx.appointment.findUnique({ where: { id } });
    if (!a) throw notFound('Appointment');
    const lead = await tx.lead.findUniqueOrThrow({
      where: { id: a.leadId },
      select: { ownerId: true },
    });
    const ok =
      a.counsellorId === p.userId ||
      lead.ownerId === p.userId ||
      a.createdById === p.userId ||
      p.authz.can('task.manage', { brandId: a.brandId });
    if (!ok) throw notFound('Appointment');
    if (a.status !== 'SCHEDULED')
      throw badRequest('APPOINTMENT_CLOSED', 'This appointment is already closed');
    return a;
  }

  create(p: OrgPrincipal, leadId: string, input: z.infer<typeof CreateAppointmentSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      if (!this.leads.canEdit(p, lead.brandId)) throw forbidden();
      if (!WORKABLE.includes(lead.status))
        throw badRequest('LEAD_NOT_ACTIVE', 'Appointments can only be booked on active leads');
      const startsAt = new Date(input.startsAt);
      if (startsAt <= now) throw badRequest('APPOINTMENT_IN_PAST', 'Choose a future time');
      const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
      const counsellor = await tx.user.findFirst({
        where: {
          id: input.counsellorId,
          status: 'ACTIVE',
          roleAssignments: {
            some: {
              revokedAt: null,
              OR: [{ scopeType: 'ORGANIZATION' }, { brandId: lead.brandId }],
            },
          },
        },
      });
      if (!counsellor)
        throw badRequest(
          'INVALID_COUNSELLOR',
          'The counsellor must be an active user of this brand',
        );
      await this.assertNoOverlap(tx, counsellor.id, startsAt, endsAt);
      const a = await tx.appointment.create({
        data: {
          organizationId: lead.organizationId,
          brandId: lead.brandId,
          leadId,
          counsellorId: counsellor.id,
          startsAt,
          endsAt,
          mode: input.mode,
          location: input.location ?? null,
          createdById: p.userId,
          createdAt: now,
        },
      });
      await this.event(
        tx,
        a,
        'APPOINTMENT_SCHEDULED',
        `Counselling with ${counsellor.name} (${input.mode.replace('_', ' ').toLowerCase()})`,
        p.userId,
        now,
      );
      await this.scheduleReminder(tx, a, now);
      if (counsellor.id !== p.userId)
        await this.notifications.create(tx, {
          organizationId: lead.organizationId,
          userId: counsellor.id,
          type: 'APPOINTMENT_BOOKED',
          title: `Counselling booked: ${lead.person.fullName} (${lead.leadNumber})`,
          link: `/leads/${lead.id}`,
          dedupKey: `appt-new:${a.id}`,
          now,
        });
      return a;
    });
  }

  /** A session that already happened (walk-in or unscheduled), recorded directly. */
  record(p: OrgPrincipal, leadId: string, input: z.infer<typeof CounsellingRecordSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      if (!this.leads.canEdit(p, lead.brandId)) throw forbidden();
      if (!WORKABLE.includes(lead.status))
        throw badRequest('LEAD_NOT_ACTIVE', 'Counselling can only be recorded on active leads');
      const startsAt = new Date(input.heldAt);
      if (startsAt > now)
        throw badRequest('SESSION_IN_FUTURE', 'Book future sessions as appointments');
      const counsellor = await tx.user.findFirst({
        where: {
          id: input.counsellorId,
          status: 'ACTIVE',
          roleAssignments: {
            some: {
              revokedAt: null,
              OR: [{ scopeType: 'ORGANIZATION' }, { brandId: lead.brandId }],
            },
          },
        },
      });
      if (!counsellor)
        throw badRequest(
          'INVALID_COUNSELLOR',
          'The counsellor must be an active user of this brand',
        );
      const a = await tx.appointment.create({
        data: {
          organizationId: lead.organizationId,
          brandId: lead.brandId,
          leadId,
          counsellorId: counsellor.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + input.durationMinutes * 60_000),
          mode: input.mode,
          status: input.attended ? 'COMPLETED' : 'NO_SHOW',
          summary: input.summary,
          createdById: p.userId,
          createdAt: now,
        },
      });
      await this.event(
        tx,
        a,
        'COUNSELLING_RECORDED',
        `${input.attended ? 'Counselling' : 'No-show'} with ${counsellor.name} — ${input.summary}`,
        p.userId,
        now,
      );
      const next = input.nextTask
        ? await this.tasks.create(tx, {
            lead,
            ownerId: lead.ownerId ?? p.userId,
            input: input.nextTask,
            createdById: p.userId,
            now,
          })
        : null;
      return { appointment: a, nextTask: next };
    });
  }

  complete(p: OrgPrincipal, id: string, input: z.infer<typeof CompleteAppointmentSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await this.forAction(tx, p, id);
      if (a.startsAt > now)
        throw badRequest('APPOINTMENT_NOT_STARTED', 'This appointment has not started yet');
      const done = await tx.appointment.update({
        where: { id },
        data: { status: input.attended ? 'COMPLETED' : 'NO_SHOW', summary: input.summary },
      });
      await this.event(
        tx,
        a,
        input.attended ? 'APPOINTMENT_COMPLETED' : 'APPOINTMENT_NO_SHOW',
        input.summary,
        p.userId,
        now,
      );
      let next = null;
      if (input.nextTask) {
        const lead = await tx.lead.findUniqueOrThrow({
          where: { id: a.leadId },
          include: { person: { select: { fullName: true } } },
        });
        next = await this.tasks.create(tx, {
          lead,
          ownerId: lead.ownerId ?? p.userId,
          input: input.nextTask,
          createdById: p.userId,
          now,
        });
      }
      return { appointment: done, nextTask: next };
    });
  }

  reschedule(p: OrgPrincipal, id: string, input: z.infer<typeof RescheduleAppointmentSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await this.forAction(tx, p, id);
      const startsAt = new Date(input.startsAt);
      if (startsAt <= now) throw badRequest('APPOINTMENT_IN_PAST', 'Choose a future time');
      const minutes = input.durationMinutes ?? (a.endsAt.getTime() - a.startsAt.getTime()) / 60_000;
      const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
      await this.assertNoOverlap(tx, a.counsellorId, startsAt, endsAt, a.id);
      const moved = await tx.appointment.update({ where: { id }, data: { startsAt, endsAt } });
      await this.event(
        tx,
        moved,
        'APPOINTMENT_RESCHEDULED',
        `Moved${input.reason ? ` — ${input.reason}` : ''}`,
        p.userId,
        now,
      );
      await this.scheduleReminder(tx, moved, now);
      return moved;
    });
  }

  cancel(p: OrgPrincipal, id: string, input: z.infer<typeof CancelAppointmentSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await this.forAction(tx, p, id);
      const c = await tx.appointment.update({
        where: { id },
        data: { status: 'CANCELLED', cancelReason: input.reason },
      });
      await this.event(tx, a, 'APPOINTMENT_CANCELLED', input.reason, p.userId, now);
      return c;
    });
  }

  list(p: OrgPrincipal, q: z.infer<typeof AppointmentListQuerySchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      let scope = {};
      if (q.mine === 'true') scope = { counsellorId: p.userId };
      else {
        const v = p.authz.visibleBrandIds('task.manage');
        if (!v.all && !v.brandIds.length) throw forbidden();
        scope = v.all ? {} : { brandId: { in: v.brandIds } };
      }
      const rows = await tx.appointment.findMany({
        where: {
          ...scope,
          ...(q.status ? { status: q.status } : {}),
          ...(q.from || q.to
            ? {
                startsAt: {
                  ...(q.from ? { gte: new Date(q.from) } : {}),
                  ...(q.to ? { lt: new Date(q.to) } : {}),
                },
              }
            : {}),
        },
        orderBy: { startsAt: 'asc' },
        take: 200,
      });
      return this.present(tx, rows);
    });
  }

  /** People who can be booked as counsellor for this lead (active users with a role in its brand). */
  counsellors(p: OrgPrincipal, leadId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      return tx.user.findMany({
        where: {
          status: 'ACTIVE',
          roleAssignments: {
            some: {
              revokedAt: null,
              OR: [{ scopeType: 'ORGANIZATION' }, { brandId: lead.brandId }],
            },
          },
        },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
    });
  }

  forLead(p: OrgPrincipal, leadId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.leads.visibleLead(tx, p, leadId);
      const rows = await tx.appointment.findMany({
        where: { leadId },
        orderBy: { startsAt: 'desc' },
      });
      return this.present(tx, rows);
    });
  }

  private async present(tx: Tx, rows: Appointment[]) {
    const [users, leads] = await Promise.all([
      tx.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.counsellorId))] } },
        select: { id: true, name: true },
      }),
      tx.lead.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.leadId))] } },
        select: { id: true, leadNumber: true, person: { select: { fullName: true } } },
      }),
    ]);
    const u = new Map(users.map((x) => [x.id, x.name]));
    const l = new Map(leads.map((x) => [x.id, x]));
    return rows.map((r) => ({
      ...r,
      counsellorName: u.get(r.counsellorId) ?? null,
      lead: l.get(r.leadId) ?? null,
    }));
  }

  async remind(job: JobRow): Promise<void> {
    const { appointmentId, startsAt } = job.payload as { appointmentId: string; startsAt: string };
    const now = this.clock.now();
    await this.db.tenant(job.organizationId!, async (tx) => {
      const a = await tx.appointment.findUnique({ where: { id: appointmentId } });
      if (!a || a.status !== 'SCHEDULED' || a.startsAt.toISOString() !== startsAt) return;
      const lead = await tx.lead.findUniqueOrThrow({
        where: { id: a.leadId },
        include: { person: { select: { fullName: true } } },
      });
      const brand = await tx.brand.findUniqueOrThrow({
        where: { id: a.brandId },
        select: { timezone: true },
      });
      const local = DateTime.fromJSDate(a.startsAt, { zone: brand.timezone }).toFormat('HH:mm');
      for (const userId of new Set([a.counsellorId, lead.ownerId].filter((x): x is string => !!x)))
        await this.notifications.create(tx, {
          organizationId: a.organizationId,
          userId,
          type: 'APPOINTMENT_REMINDER',
          title: `Counselling at ${local}: ${lead.person.fullName} (${lead.leadNumber})`,
          body: a.location ?? undefined,
          link: `/leads/${lead.id}`,
          dedupKey: `appt-remind:${a.id}:${startsAt}`,
          now,
        });
    });
  }
}
