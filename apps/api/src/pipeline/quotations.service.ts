import { Injectable } from '@nestjs/common';
import {
  CreateQuotationSchema,
  DISCOUNT_APPROVAL_PERCENT,
  QuotationDecisionSchema,
  RejectQuotationSchema,
  z,
} from '@crm/contracts';
import type { Quotation } from '@prisma/client';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { LeadsService } from '../leads/leads.service';

/** Course + batch + fee offers (FR-011 course selection; fee plans and approvals in Phase 12). */
@Injectable()
export class QuotationsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
  ) {}

  private canQuote(p: OrgPrincipal, brandId: string) {
    const v = p.authz.visibleBrandIds('pipeline.transition');
    return this.leads.canEdit(p, brandId) && (v.all || v.brandIds.includes(brandId));
  }

  private async nextNumber(tx: Tx, organizationId: string) {
    const [row] = await tx.$queryRaw<Array<{ value: bigint }>>`
      INSERT INTO org_counters (organization_id, name, value) VALUES (${organizationId}::uuid, 'quotation', 1)
      ON CONFLICT (organization_id, name) DO UPDATE SET value = org_counters.value + 1
      RETURNING value`;
    return `Q-${String(row.value).padStart(6, '0')}`;
  }

  private async today(tx: Tx, brandId: string) {
    const b = await tx.brand.findUniqueOrThrow({
      where: { id: brandId },
      select: { timezone: true },
    });
    return DateTime.fromJSDate(this.clock.now(), { zone: b.timezone }).startOf('day');
  }

  private event(tx: Tx, q: Quotation, type: string, body: string, actorUserId: string, now: Date) {
    return tx.leadEvent.create({
      data: {
        organizationId: q.organizationId,
        leadId: q.leadId,
        type,
        actorUserId,
        body,
        data: {
          quotationId: q.id,
          number: q.number,
          totalMinor: q.totalMinor.toString(),
          currency: q.currency,
        },
        occurredAt: now,
      },
    });
  }

  list(p: OrgPrincipal, leadId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.leads.visibleLead(tx, p, leadId);
      const rows = await tx.quotation.findMany({
        where: { leadId },
        orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
      });
      const [courses, batches] = await Promise.all([
        tx.course.findMany({
          where: { id: { in: rows.map((r) => r.courseId) } },
          select: { id: true, name: true },
        }),
        tx.batch.findMany({
          where: { id: { in: rows.map((r) => r.batchId).filter((x): x is string => !!x) } },
          select: { id: true, name: true, startDate: true },
        }),
      ]);
      const c = new Map(courses.map((x) => [x.id, x.name]));
      const b = new Map(batches.map((x) => [x.id, x]));
      return rows.map((r) => ({
        ...r,
        courseName: c.get(r.courseId) ?? null,
        batch: r.batchId ? (b.get(r.batchId) ?? null) : null,
      }));
    });
  }

  create(p: OrgPrincipal, leadId: string, input: z.infer<typeof CreateQuotationSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      if (!this.canQuote(p, lead.brandId)) throw forbidden();
      if (lead.status !== 'OPEN')
        throw badRequest('LEAD_NOT_OPEN', 'Quotations can only be issued on open leads');
      const course = await tx.course.findFirst({
        where: { id: input.courseId, brandId: lead.brandId, status: 'ACTIVE' },
      });
      if (!course) throw badRequest('INVALID_COURSE', 'Choose an active course of this brand');
      if (course.listFeeMinor === null)
        throw badRequest('COURSE_HAS_NO_FEE', 'This course has no list fee yet');
      if (input.batchId) {
        const batch = await tx.batch.findFirst({
          where: { id: input.batchId, courseId: course.id, status: { in: ['PLANNED', 'OPEN'] } },
        });
        if (!batch)
          throw badRequest('INVALID_BATCH', 'Choose a planned or open batch of this course');
      }
      const list = course.listFeeMinor;
      const discount = BigInt(input.discountMinor);
      if (discount > list)
        throw badRequest('DISCOUNT_TOO_LARGE', 'The discount is larger than the fee');
      if (discount > 0n && !input.discountReason)
        throw badRequest('DISCOUNT_REASON_REQUIRED', 'A discount needs a reason');
      if (
        discount * 100n > list * BigInt(DISCOUNT_APPROVAL_PERCENT) &&
        !p.authz.can('task.manage', { brandId: lead.brandId })
      )
        throw forbidden(`Discounts above ${DISCOUNT_APPROVAL_PERCENT}% need a manager`);
      const validUntil = (await this.today(tx, lead.brandId)).plus({ days: input.validDays });
      const q = await tx.quotation.create({
        data: {
          organizationId: lead.organizationId,
          brandId: lead.brandId,
          leadId,
          number: await this.nextNumber(tx, lead.organizationId),
          courseId: course.id,
          batchId: input.batchId ?? null,
          currency: course.currency,
          listFeeMinor: list,
          discountMinor: discount,
          totalMinor: list - discount,
          discountReason: discount > 0n ? input.discountReason! : null,
          notes: input.notes ?? null,
          validUntil: new Date(`${validUntil.toISODate()}T00:00:00.000Z`),
          createdById: p.userId,
          createdAt: now,
        },
      });
      await this.event(tx, q, 'QUOTATION_ISSUED', `${q.number}: ${course.name}`, p.userId, now);
      await this.audit.record(tx, {
        organizationId: q.organizationId,
        brandId: q.brandId,
        actorUserId: p.userId,
        action: 'quotation.issued',
        entityType: 'quotation',
        entityId: q.id,
        after: {
          number: q.number,
          courseId: q.courseId,
          batchId: q.batchId,
          totalMinor: q.totalMinor,
          discountMinor: q.discountMinor,
        },
        reason: q.discountReason ?? undefined,
      });
      return q;
    });
  }

  private async forDecision(tx: Tx, p: OrgPrincipal, id: string) {
    const q = await tx.quotation.findUnique({ where: { id } });
    if (!q) throw notFound('Quotation');
    await this.leads.visibleLead(tx, p, q.leadId);
    if (!this.canQuote(p, q.brandId)) throw forbidden();
    if (q.status !== 'OPEN')
      throw badRequest('QUOTATION_CLOSED', `This quotation is ${q.status.toLowerCase()}`);
    return q;
  }

  async accept(p: OrgPrincipal, id: string, input: z.infer<typeof QuotationDecisionSchema>) {
    const now = this.clock.now();
    const result = await this.db.tenant(p.organizationId, async (tx) => {
      const q = await this.forDecision(tx, p, id);
      const today = await this.today(tx, q.brandId);
      if (DateTime.fromJSDate(q.validUntil, { zone: 'utc' }).toISODate()! < today.toISODate()!) {
        await tx.quotation.update({ where: { id }, data: { status: 'EXPIRED' } });
        return { expired: true as const };
      }
      const done = await tx.quotation.update({
        where: { id },
        data: {
          status: 'ACCEPTED',
          decidedAt: now,
          decidedById: p.userId,
          decisionReason: input.reason ?? null,
        },
      });
      const others = await tx.quotation.updateMany({
        where: { leadId: q.leadId, status: 'OPEN', id: { not: id } },
        data: {
          status: 'SUPERSEDED',
          decidedAt: now,
          decidedById: p.userId,
          decisionReason: `Superseded by ${q.number}`,
        },
      });
      await tx.lead.update({ where: { id: q.leadId }, data: { courseId: q.courseId } });
      await this.event(
        tx,
        done,
        'QUOTATION_ACCEPTED',
        `${q.number} accepted${others.count ? ` (${others.count} alternative(s) closed)` : ''}`,
        p.userId,
        now,
      );
      await this.audit.record(tx, {
        organizationId: q.organizationId,
        brandId: q.brandId,
        actorUserId: p.userId,
        action: 'quotation.accepted',
        entityType: 'quotation',
        entityId: q.id,
        after: { status: 'ACCEPTED', superseded: others.count },
        reason: input.reason,
      });
      return { expired: false as const, quotation: done };
    });
    if (result.expired)
      throw badRequest('QUOTATION_EXPIRED', 'This quotation has expired — issue a new one');
    return result.quotation;
  }

  reject(p: OrgPrincipal, id: string, input: z.infer<typeof RejectQuotationSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const q = await this.forDecision(tx, p, id);
      const done = await tx.quotation.update({
        where: { id },
        data: {
          status: 'REJECTED',
          decidedAt: now,
          decidedById: p.userId,
          decisionReason: input.reason,
        },
      });
      await this.event(
        tx,
        done,
        'QUOTATION_REJECTED',
        `${q.number} declined — ${input.reason}`,
        p.userId,
        now,
      );
      await this.audit.record(tx, {
        organizationId: q.organizationId,
        brandId: q.brandId,
        actorUserId: p.userId,
        action: 'quotation.rejected',
        entityType: 'quotation',
        entityId: q.id,
        after: { status: 'REJECTED' },
        reason: input.reason,
      });
      return done;
    });
  }
}
