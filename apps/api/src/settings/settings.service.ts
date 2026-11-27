import { Injectable } from '@nestjs/common';
import { SlaPolicyInput, UpdatePipelineStageSchema, WorkingHoursSchema, z } from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { conflict, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import {
  addWorkingMinutes,
  CalendarSpec,
  isWorkingTime,
  workingMinutesBetween,
} from './business-calendar';

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

/** Brand operational settings. Readable with brand.read; changes need settings.manage on the brand. */
@Injectable()
export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private assertRead(p: OrgPrincipal, brandId: string) {
    const vis = p.authz.visibleBrandIds('brand.read');
    if (!vis.all && !vis.brandIds.includes(brandId)) throw notFound('Brand');
  }

  private assertManage(p: OrgPrincipal, brandId: string) {
    this.assertRead(p, brandId);
    if (!p.authz.can('settings.manage', { brandId })) throw forbidden();
  }

  private async brand(tx: Tx, brandId: string) {
    const b = await tx.brand.findUnique({ where: { id: brandId } });
    if (!b) throw notFound('Brand');
    return b;
  }

  // -------------------------------------------------------- working hours
  getWorkingHours(p: OrgPrincipal, brandId: string) {
    this.assertRead(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const brand = await this.brand(tx, brandId);
      const shifts = await tx.workingHours.findMany({
        where: { brandId },
        orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
        select: { weekday: true, startMinute: true, endMinute: true },
      });
      return { brandId, timezone: brand.timezone, shifts };
    });
  }

  setWorkingHours(p: OrgPrincipal, brandId: string, input: z.infer<typeof WorkingHoursSchema>) {
    this.assertManage(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const brand = await this.brand(tx, brandId);
      const before = await tx.workingHours.findMany({
        where: { brandId },
        select: { weekday: true, startMinute: true, endMinute: true },
      });
      await tx.workingHours.deleteMany({ where: { brandId } });
      await tx.workingHours.createMany({
        data: input.shifts.map((s) => ({ organizationId: p.organizationId, brandId, ...s })),
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId,
        action: 'settings.working_hours_updated',
        entityType: 'brand',
        entityId: brandId,
        before,
        after: input.shifts,
      });
      return { brandId, timezone: brand.timezone, shifts: input.shifts };
    });
  }

  // ------------------------------------------------------------- holidays
  listHolidays(p: OrgPrincipal, brandId: string) {
    this.assertRead(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const rows = await tx.holiday.findMany({ where: { brandId }, orderBy: { date: 'asc' } });
      return rows.map((h) => ({ ...h, date: dateOnly(h.date) }));
    });
  }

  addHoliday(p: OrgPrincipal, brandId: string, input: { date: string; name: string }) {
    this.assertManage(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.brand(tx, brandId);
      const date = new Date(`${input.date}T00:00:00.000Z`);
      if (await tx.holiday.findFirst({ where: { brandId, date } }))
        throw conflict('HOLIDAY_EXISTS', 'A holiday already exists on this date');
      const h = await tx.holiday.create({
        data: { organizationId: p.organizationId, brandId, date, name: input.name },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId,
        action: 'settings.holiday_added',
        entityType: 'holiday',
        entityId: h.id,
        after: input,
      });
      return { ...h, date: input.date };
    });
  }

  removeHoliday(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const h = await tx.holiday.findUnique({ where: { id } });
      if (!h) throw notFound('Holiday');
      this.assertManage(p, h.brandId);
      await tx.holiday.delete({ where: { id } });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: h.brandId,
        action: 'settings.holiday_removed',
        entityType: 'holiday',
        entityId: id,
        before: { date: dateOnly(h.date), name: h.name },
      });
    });
  }

  // ----------------------------------------------------------- SLA policy
  getSlaPolicy(p: OrgPrincipal, brandId: string) {
    this.assertRead(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const policy = await tx.slaPolicy.findUnique({
        where: { brandId },
        include: {
          checkpoints: {
            orderBy: { position: 'asc' },
            select: { position: true, action: true, afterMinutes: true, basis: true },
          },
        },
      });
      if (!policy) throw notFound('SLA policy');
      return policy;
    });
  }

  setSlaPolicy(p: OrgPrincipal, brandId: string, input: SlaPolicyInput) {
    this.assertManage(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.brand(tx, brandId);
      const before = await tx.slaPolicy.findUnique({
        where: { brandId },
        include: { checkpoints: { orderBy: { position: 'asc' } } },
      });
      const { checkpoints, ...fields } = input;
      const policy = before
        ? await tx.slaPolicy.update({ where: { brandId }, data: fields })
        : await tx.slaPolicy.create({
            data: { organizationId: p.organizationId, brandId, ...fields },
          });
      await tx.slaCheckpoint.deleteMany({ where: { policyId: policy.id } });
      await tx.slaCheckpoint.createMany({
        data: checkpoints.map((c, i) => ({
          organizationId: p.organizationId,
          policyId: policy.id,
          position: i + 1,
          ...c,
        })),
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId,
        action: 'settings.sla_policy_updated',
        entityType: 'sla_policy',
        entityId: policy.id,
        before,
        after: input,
      });
      return { ...policy, checkpoints: checkpoints.map((c, i) => ({ position: i + 1, ...c })) };
    });
  }

  // ------------------------------------------------------ pipeline stages
  listStages(p: OrgPrincipal, brandId: string) {
    this.assertRead(p, brandId);
    return this.db.tenant(p.organizationId, (tx) =>
      tx.pipelineStage.findMany({ where: { brandId }, orderBy: { position: 'asc' } }),
    );
  }

  updateStage(p: OrgPrincipal, id: string, input: z.infer<typeof UpdatePipelineStageSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.pipelineStage.findUnique({ where: { id } });
      if (!before) throw notFound('Pipeline stage');
      this.assertManage(p, before.brandId);
      const after = await tx.pipelineStage.update({ where: { id }, data: input });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: before.brandId,
        action: 'settings.pipeline_stage_updated',
        entityType: 'pipeline_stage',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  // --------------------------------------------------------------- preview
  /** Shows both clocks (D-003) for "a lead arriving at `start`": calendar due vs working due. */
  preview(p: OrgPrincipal, brandId: string, start: Date, minutes: number) {
    this.assertRead(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const cal = await this.calendar(tx, brandId);
      const workingDue = addWorkingMinutes(start, minutes, cal);
      const calendarDue = new Date(start.getTime() + minutes * 60_000);
      return {
        timezone: cal.timezone,
        start: start.toISOString(),
        minutes,
        arrivesInWorkingTime: isWorkingTime(start, cal),
        calendarDue: calendarDue.toISOString(),
        workingDue: workingDue.toISOString(),
        workingMinutesUntilCalendarDue: workingMinutesBetween(start, calendarDue, cal),
      };
    });
  }

  /** Loads a brand's calendar for business-time maths (also used by Phase 7). */
  async calendar(tx: Tx, brandId: string): Promise<CalendarSpec> {
    const brand = await this.brand(tx, brandId);
    const [shifts, holidays] = await Promise.all([
      tx.workingHours.findMany({
        where: { brandId },
        select: { weekday: true, startMinute: true, endMinute: true },
      }),
      tx.holiday.findMany({ where: { brandId }, select: { date: true } }),
    ]);
    return {
      timezone: brand.timezone,
      shifts,
      holidays: new Set(holidays.map((h) => dateOnly(h.date))),
    };
  }
}
