import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BulkTransitionSchema,
  DEFAULT_PIPELINE,
  PipelineQuerySchema,
  QualificationSchema,
  SavedViewSchema,
  STAGE_FIELD_CATALOG,
  StageField,
  StageTransitionSchema,
  SYSTEM_STAGES,
  z,
} from '@crm/contracts';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { AppError } from '../common/errors';
import { Clock } from '../common/clock';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { LeadsService } from '../leads/leads.service';

type FieldState = { ok: boolean; detail?: string };
type LeadRow = Prisma.LeadGetPayload<{ include: { person: true } }>;

const QUAL_FIELDS = [
  'highestQualification',
  'eligibilityNotes',
  'requirement',
  'interestLevel',
  'preferredCourseIds',
  'intake',
  'feeReadiness',
  'objections',
] as const;
const QUAL_LABEL: Record<(typeof QUAL_FIELDS)[number], string> = {
  highestQualification: 'highest qualification',
  eligibilityNotes: 'eligibility notes',
  requirement: 'requirement',
  interestLevel: 'interest level',
  preferredCourseIds: 'preferred courses',
  intake: 'intake',
  feeReadiness: 'fee readiness',
  objections: 'objections',
};

/** Pipeline stage rules, board, qualification and saved views (FR-011). See docs/plans/PHASE-09.md. */
@Injectable()
export class PipelineService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------- access
  private inBrand(p: OrgPrincipal, perm: 'pipeline.transition' | 'task.manage', brandId: string) {
    const v = p.authz.visibleBrandIds(perm);
    return v.all || v.brandIds.includes(brandId);
  }

  /** task.manage over the brand, or over a team the lead owner belongs to. */
  private async canManage(
    tx: Tx,
    p: OrgPrincipal,
    lead: { brandId: string; ownerId: string | null },
  ) {
    if (p.authz.can('task.manage', { brandId: lead.brandId })) return true;
    const s = p.authz.scope('task.manage');
    if (!lead.ownerId || (!s.teamIds.length && !s.branchIds.length)) return false;
    return !!(await tx.teamMember.findFirst({
      where: {
        userId: lead.ownerId,
        leftAt: null,
        team: { OR: [{ id: { in: s.teamIds } }, { branchId: { in: s.branchIds } }] },
      },
    }));
  }

  private stages(tx: Tx, brandId: string) {
    return tx.pipelineStage.findMany({ where: { brandId }, orderBy: { position: 'asc' } });
  }

  // --------------------------------------------------------- readiness
  /** Which stage fields this lead currently satisfies (see the table in PHASE-09.md). */
  private async evaluate(tx: Tx, lead: LeadRow): Promise<Record<StageField, FieldState>> {
    const [q, calls, connected, counselling, quotes, admission] = await Promise.all([
      tx.leadQualification.findUnique({ where: { leadId: lead.id } }),
      tx.activity.count({ where: { leadId: lead.id, type: 'CALL' } }),
      tx.activity.count({ where: { leadId: lead.id, type: 'CALL', outcome: 'CONNECTED' } }),
      tx.appointment.findFirst({
        where: { leadId: lead.id, status: 'COMPLETED', summary: { not: null } },
        orderBy: { startsAt: 'desc' },
      }),
      tx.quotation.findMany({
        where: { leadId: lead.id, status: { in: ['OPEN', 'ACCEPTED'] } },
        orderBy: { createdAt: 'desc' },
      }),
      tx.admission.findFirst({ where: { leadId: lead.id, status: 'CONFIRMED' } }),
    ]);
    const accepted = quotes.find((x) => x.status === 'ACCEPTED');
    const has = (v: unknown) =>
      Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== '';
    const later = 'Recorded by admissions and payments (Phases 11–12)';
    return {
      name: { ok: has(lead.person.fullName) },
      mobile: { ok: has(lead.person.phoneE164) },
      source: { ok: lead.enquiryCount > 0 },
      contactOutcome: {
        ok: calls > 0,
        detail: calls ? (connected ? 'Connected' : 'Attempted, not yet connected') : undefined,
      },
      qualification: { ok: has(q?.highestQualification) },
      eligibility: { ok: has(q?.eligibilityNotes) },
      requirement: { ok: has(q?.requirement) },
      interestLevel: { ok: has(q?.interestLevel), detail: q?.interestLevel ?? undefined },
      coursePreference: { ok: has(q?.preferredCourseIds) || has(lead.courseId) },
      counsellingDate: { ok: !!counselling, detail: counselling?.startsAt.toISOString() },
      counsellingRemarks: { ok: has(counselling?.summary) },
      course: { ok: quotes.length > 0 },
      batch: { ok: quotes.some((x) => x.batchId) },
      feeQuote: { ok: quotes.length > 0, detail: quotes[0]?.number },
      amountDue: { ok: !!accepted, detail: accepted ? String(accepted.totalMinor) : undefined },
      paymentStatus: { ok: !!accepted, detail: accepted ? 'Pending' : undefined },
      admissionId: {
        ok: !!admission?.admissionNumber,
        detail: admission?.admissionNumber ?? later,
      },
      paymentVerified: {
        ok: !!admission?.admissionNumber,
        detail: admission ? 'Verified payment recorded' : later,
      },
    };
  }

  private async view(tx: Tx, p: OrgPrincipal, lead: LeadRow) {
    const [stages, fields, manage] = await Promise.all([
      this.stages(tx, lead.brandId),
      this.evaluate(tx, lead),
      this.canManage(tx, p, lead),
    ]);
    const current = stages.findIndex((s) => s.key === lead.stage);
    const canMove =
      lead.status === 'OPEN' &&
      this.leads.canEdit(p, lead.brandId) &&
      this.inBrand(p, 'pipeline.transition', lead.brandId);
    const missingUpTo = (i: number) =>
      stages.slice(0, i + 1).flatMap((s) =>
        s.requiredFields
          .filter((f) => !fields[f as StageField]?.ok)
          .map((f) => ({
            stage: s.key,
            field: f,
            label: STAGE_FIELD_CATALOG[f as StageField] ?? f,
          })),
      );
    return {
      leadId: lead.id,
      status: lead.status,
      stage: lead.stage,
      stageChangedAt: lead.stageChangedAt,
      fields,
      stages: stages.map((s, i) => {
        const missing = missingUpTo(i);
        const system = SYSTEM_STAGES.includes(s.key);
        const backward = i < current;
        return {
          key: s.key,
          label: s.label,
          position: s.position,
          requiredFields: s.requiredFields.map((f) => ({
            field: f,
            label: STAGE_FIELD_CATALOG[f as StageField] ?? f,
            ...(fields[f as StageField] ?? { ok: false }),
          })),
          current: i === current,
          system,
          missing: backward ? [] : missing,
          canEnter:
            canMove && i !== current && !system && (backward ? manage : missing.length === 0),
          needsReason: backward,
        };
      }),
    };
  }

  stageInfo(p: OrgPrincipal, leadId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      return this.view(tx, p, lead);
    });
  }

  // ------------------------------------------------------------ transitions
  transition(p: OrgPrincipal, leadId: string, input: z.infer<typeof StageTransitionSchema>) {
    return this.db.tenant(p.organizationId, (tx) => this.move(tx, p, leadId, input));
  }

  private async move(
    tx: Tx,
    p: OrgPrincipal,
    leadId: string,
    input: z.infer<typeof StageTransitionSchema>,
  ) {
    const now = this.clock.now();
    await tx.$queryRaw`SELECT id FROM leads WHERE id = ${leadId}::uuid FOR UPDATE`;
    const lead = await this.leads.visibleLead(tx, p, leadId);
    if (
      !this.leads.canEdit(p, lead.brandId) ||
      !this.inBrand(p, 'pipeline.transition', lead.brandId)
    )
      throw forbidden();
    if (lead.status !== 'OPEN')
      throw badRequest(
        'LEAD_NOT_OPEN',
        `A ${lead.status.toLowerCase().replace('_', ' ')} lead cannot change stage`,
      );
    const stages = await this.stages(tx, lead.brandId);
    const from = stages.findIndex((s) => s.key === lead.stage);
    const to = stages.findIndex((s) => s.key === input.toStage);
    if (to < 0) throw badRequest('UNKNOWN_STAGE', 'This stage is not part of the brand pipeline');
    if (to === from) throw badRequest('SAME_STAGE', 'The lead is already in this stage');
    if (SYSTEM_STAGES.includes(input.toStage))
      throw badRequest(
        'SYSTEM_STAGE',
        'Admission Confirmed is set by the admission and payment workflow',
      );
    const fields = await this.evaluate(tx, lead);
    const backward = to < from;
    if (backward) {
      if (!input.reason) throw badRequest('REASON_REQUIRED', 'Moving a lead back needs a reason');
      if (!(await this.canManage(tx, p, lead)))
        throw forbidden('Only a team leader or manager can move a lead back');
    } else {
      const missing = stages.slice(0, to + 1).flatMap((s) =>
        s.requiredFields
          .filter((f) => !fields[f as StageField]?.ok)
          .map((f) => ({
            stage: s.key,
            field: f,
            label: STAGE_FIELD_CATALOG[f as StageField] ?? f,
          })),
      );
      if (missing.length)
        throw badRequest(
          'STAGE_REQUIREMENTS_MISSING',
          `Missing before ${stages[to].label}: ${missing.map((m) => m.label).join(', ')}`,
          { missing },
        );
    }
    const fromKey = lead.stage;
    const fromLabel = stages[from]?.label ?? fromKey;
    await tx.lead.update({
      where: { id: lead.id },
      data: { stage: input.toStage, stageChangedAt: now },
    });
    const snapshot = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.ok]));
    await tx.leadStageHistory.create({
      data: {
        organizationId: lead.organizationId,
        brandId: lead.brandId,
        leadId: lead.id,
        fromStage: fromKey,
        toStage: input.toStage,
        direction: backward ? 'BACKWARD' : 'FORWARD',
        actorUserId: p.userId,
        reason: input.reason ?? null,
        snapshot,
        occurredAt: now,
      },
    });
    await tx.leadEvent.create({
      data: {
        organizationId: lead.organizationId,
        leadId: lead.id,
        type: 'STAGE_CHANGED',
        actorUserId: p.userId,
        body: `${fromLabel} → ${stages[to].label}${input.reason ? ` — ${input.reason}` : ''}`,
        data: { from: fromKey, to: input.toStage, direction: backward ? 'BACKWARD' : 'FORWARD' },
        occurredAt: now,
      },
    });
    await tx.outboxEvent.create({
      data: {
        organizationId: lead.organizationId,
        type: 'lead.stage_changed',
        aggregateType: 'lead',
        aggregateId: lead.id,
        payload: { from: fromKey, to: input.toStage, actorUserId: p.userId },
      },
    });
    await this.audit.record(tx, {
      organizationId: lead.organizationId,
      brandId: lead.brandId,
      actorUserId: p.userId,
      action: 'lead.stage_changed',
      entityType: 'lead',
      entityId: lead.id,
      before: { stage: fromKey },
      after: { stage: input.toStage },
      reason: input.reason,
    });
    return this.view(tx, p, { ...lead, stage: input.toStage, stageChangedAt: now });
  }

  /** Each lead is checked on its own; refused leads are reported, not fatal. */
  async bulkTransition(p: OrgPrincipal, input: z.infer<typeof BulkTransitionSchema>) {
    const results = [];
    for (const leadId of [...new Set(input.leadIds)]) {
      try {
        await this.transition(p, leadId, { toStage: input.toStage, reason: input.reason });
        results.push({ leadId, ok: true as const });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        results.push({ leadId, ok: false as const, code: e.code, message: e.message });
      }
    }
    return {
      moved: results.filter((r) => r.ok).length,
      refused: results.filter((r) => !r.ok).length,
      results,
    };
  }

  // ------------------------------------------------------------------ board
  board(p: OrgPrincipal, q: z.infer<typeof PipelineQuerySchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const vis = await this.leads.visibility(tx, p);
      if (!vis) throw forbidden();
      const where: Prisma.LeadWhereInput = {
        AND: [
          vis,
          { status: 'OPEN' },
          q.brandId ? { brandId: q.brandId } : {},
          q.courseId ? { courseId: q.courseId } : {},
          q.mine === 'true' ? { ownerId: p.userId } : q.ownerId ? { ownerId: q.ownerId } : {},
        ],
      };
      const stages = q.brandId
        ? await this.stages(tx, q.brandId)
        : DEFAULT_PIPELINE.map((s, i) => ({ key: s.key, label: s.label, position: i + 1 }));
      const counts = new Map(
        (await tx.lead.groupBy({ by: ['stage'], where, _count: { _all: true } })).map((c) => [
          c.stage,
          c._count._all,
        ]),
      );
      const columns = [];
      for (const s of stages) {
        const rows = await tx.lead.findMany({
          where: { AND: [where, { stage: s.key }] },
          orderBy: [{ stageChangedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
          take: q.perStage,
          select: {
            id: true,
            leadNumber: true,
            brandId: true,
            ownerId: true,
            createdAt: true,
            stageChangedAt: true,
            person: { select: { fullName: true } },
            course: { select: { name: true } },
          },
        });
        columns.push({ key: s.key, label: s.label, count: counts.get(s.key) ?? 0, leads: rows });
      }
      const ids = columns.flatMap((c) => c.leads.map((l) => l.id));
      const ownerIds = [
        ...new Set(
          columns.flatMap((c) => c.leads.map((l) => l.ownerId)).filter((x): x is string => !!x),
        ),
      ];
      const [quals, owners, tasks] = await Promise.all([
        tx.leadQualification.findMany({
          where: { leadId: { in: ids } },
          select: { leadId: true, interestLevel: true },
        }),
        tx.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }),
        tx.task.groupBy({
          by: ['leadId'],
          where: { leadId: { in: ids }, status: 'OPEN' },
          _min: { dueAt: true },
        }),
      ]);
      const interest = new Map(quals.map((x) => [x.leadId, x.interestLevel]));
      const ownerName = new Map(owners.map((u) => [u.id, u.name]));
      const nextDue = new Map(tasks.map((t) => [t.leadId, t._min.dueAt]));
      return {
        columns: columns.map((c) => ({
          ...c,
          leads: c.leads.map((l) => {
            const since = l.stageChangedAt ?? l.createdAt;
            const due = nextDue.get(l.id) ?? null;
            return {
              id: l.id,
              leadNumber: l.leadNumber,
              name: l.person.fullName,
              course: l.course?.name ?? null,
              ownerName: l.ownerId ? (ownerName.get(l.ownerId) ?? null) : null,
              interestLevel: interest.get(l.id) ?? null,
              daysInStage: Math.floor(
                DateTime.fromJSDate(now).diff(DateTime.fromJSDate(since), 'days').days,
              ),
              nextTaskDue: due,
              overdue: !!due && due < now,
            };
          }),
        })),
      };
    });
  }

  // ---------------------------------------------------------- qualification
  qualification(p: OrgPrincipal, leadId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.leads.visibleLead(tx, p, leadId);
      return (await tx.leadQualification.findUnique({ where: { leadId } })) ?? { leadId };
    });
  }

  updateQualification(p: OrgPrincipal, leadId: string, input: z.infer<typeof QualificationSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      if (!this.leads.canEdit(p, lead.brandId)) throw forbidden();
      if (lead.status === 'MERGED') throw badRequest('LEAD_MERGED', 'This lead was merged');
      if (input.preferredCourseIds?.length) {
        const n = await tx.course.count({
          where: { id: { in: input.preferredCourseIds }, brandId: lead.brandId },
        });
        if (n !== new Set(input.preferredCourseIds).size)
          throw badRequest('INVALID_COURSE', 'Preferred courses must belong to this brand');
      }
      const before = await tx.leadQualification.findUnique({ where: { leadId } });
      const data: Record<string, unknown> = {};
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of QUAL_FIELDS) {
        if (input[k] === undefined) continue;
        const prev = before?.[k] ?? (k === 'preferredCourseIds' ? [] : null);
        const next = input[k] === '' ? null : input[k];
        if (
          JSON.stringify(prev) === JSON.stringify(next ?? (k === 'preferredCourseIds' ? [] : null))
        )
          continue;
        data[k] = next ?? (k === 'preferredCourseIds' ? [] : null);
        changes[k] = { from: prev, to: data[k] };
      }
      if (!Object.keys(changes).length) return before ?? { leadId };
      const saved = await tx.leadQualification.upsert({
        where: { leadId },
        create: {
          organizationId: lead.organizationId,
          leadId,
          ...data,
          updatedById: p.userId,
          updatedAt: now,
        },
        update: { ...data, updatedById: p.userId, updatedAt: now },
      });
      await tx.leadEvent.create({
        data: {
          organizationId: lead.organizationId,
          leadId,
          type: 'QUALIFICATION_UPDATED',
          actorUserId: p.userId,
          body: `Updated ${Object.keys(changes)
            .map((k) => QUAL_LABEL[k as (typeof QUAL_FIELDS)[number]])
            .join(', ')}`,
          data: JSON.parse(JSON.stringify({ changes })),
          occurredAt: now,
        },
      });
      await this.audit.record(tx, {
        organizationId: lead.organizationId,
        brandId: lead.brandId,
        actorUserId: p.userId,
        action: 'lead.qualification_updated',
        entityType: 'lead',
        entityId: leadId,
        before: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.from])),
        after: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])),
      });
      return saved;
    });
  }

  // ----------------------------------------------------------- saved views
  listViews(p: OrgPrincipal, page?: string) {
    return this.db.tenant(p.organizationId, (tx) =>
      tx.savedView.findMany({
        where: { userId: p.userId, ...(page ? { page } : {}) },
        orderBy: { name: 'asc' },
      }),
    );
  }

  createView(p: OrgPrincipal, input: z.infer<typeof SavedViewSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      try {
        return await tx.savedView.create({
          data: { organizationId: p.organizationId, userId: p.userId, ...input, createdAt: now },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw conflict('VIEW_EXISTS', 'You already have a view with this name');
        throw e;
      }
    });
  }

  deleteView(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const r = await tx.savedView.deleteMany({ where: { id, userId: p.userId } });
      if (!r.count) throw notFound('View');
    });
  }
}
