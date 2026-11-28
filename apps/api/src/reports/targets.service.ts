import { Injectable } from '@nestjs/common';
import type { Target } from '@prisma/client';
import {
  AdSpendSchema,
  IncentiveRuleSchema,
  IncentiveRunSchema,
  TargetQuerySchema,
  TargetSchema,
  UpdateTargetSchema,
  z,
} from '@crm/contracts';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { ReportContext, ReportsService } from './reports.service';

/** Targets, manual ad spend and incentive runs (FR-016). See docs/plans/PHASE-13.md. */
@Injectable()
export class TargetsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
  ) {}

  private canManage(p: OrgPrincipal, brandId: string | null) {
    return brandId ? p.authz.can('target.manage', { brandId }) : p.authz.can('target.manage');
  }

  /** A report context for a target / rule scope, independent of the caller's own scope. */
  private async contextFor(
    tx: Tx,
    orgId: string,
    c: {
      brandId: string | null;
      teamId?: string | null;
      userId?: string | null;
      courseId?: string | null;
      from: Date;
      to: Date;
    },
  ): Promise<ReportContext> {
    const tz = c.brandId
      ? (await tx.brand.findUniqueOrThrow({ where: { id: c.brandId }, select: { timezone: true } }))
          .timezone
      : (
          await tx.organization.findUniqueOrThrow({
            where: { id: orgId },
            select: { timezone: true },
          })
        ).timezone;
    let userIds: Set<string> | null = null;
    if (c.teamId)
      userIds = new Set(
        (
          await tx.teamMember.findMany({
            where: { teamId: c.teamId, leftAt: null },
            select: { userId: true },
          })
        ).map((m) => m.userId),
      );
    if (c.userId) userIds = new Set([c.userId]);
    const from = c.from.toISOString().slice(0, 10);
    const to = c.to.toISOString().slice(0, 10);
    return {
      tz,
      start: DateTime.fromISO(from, { zone: tz }).startOf('day').toJSDate(),
      end: DateTime.fromISO(to, { zone: tz }).plus({ days: 1 }).startOf('day').toJSDate(),
      now: this.clock.now(),
      scope: { all: !c.brandId, brandIds: c.brandId ? [c.brandId] : [], userIds },
      f: { from, to, mine: 'false', ...(c.courseId ? { courseId: c.courseId } : {}) },
    };
  }

  // -------------------------------------------------------------- targets
  private async visibleTargets(tx: Tx, p: OrgPrincipal) {
    const v = p.authz.visibleBrandIds('report.read');
    const m = p.authz.visibleBrandIds('target.manage');
    const all = v.all || m.all;
    const brands = [...new Set([...v.brandIds, ...m.brandIds])];
    return { all, brands };
  }

  async list(p: OrgPrincipal, q: z.infer<typeof TargetQuerySchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const { all, brands } = await this.visibleTargets(tx, p);
      const where = {
        ...(q.brandId ? { brandId: q.brandId } : {}),
        ...(q.periodStart
          ? { periodEnd: { gte: new Date(`${q.periodStart}T00:00:00.000Z`) } }
          : {}),
        ...(q.periodEnd ? { periodStart: { lte: new Date(`${q.periodEnd}T00:00:00.000Z`) } } : {}),
      };
      // Own targets are always visible; others need report.read / target.manage over the brand.
      const rows = await tx.target.findMany({
        where,
        orderBy: [{ periodStart: 'desc' }, { metric: 'asc' }],
      });
      const visible = rows.filter(
        (t) => t.userId === p.userId || all || (t.brandId && brands.includes(t.brandId)),
      );
      return Promise.all(
        visible.map(async (t) => ({ ...t, achieved: await this.achieved(tx, t) })),
      );
    });
  }

  /** Progress uses the same KPI records as the reports. */
  private async achieved(tx: Tx, t: Target): Promise<bigint> {
    const ctx = await this.contextFor(tx, t.organizationId, {
      brandId: t.brandId,
      teamId: t.teamId,
      userId: t.userId,
      courseId: t.courseId,
      from: t.periodStart,
      to: t.periodEnd,
    });
    const d = await this.reports.collectWith(tx, ctx);
    const sum = (rs: Array<{ amountMinor?: bigint; currency?: string }>) =>
      rs.filter((r) => r.currency === t.currency).reduce((s, r) => s + (r.amountMinor ?? 0n), 0n);
    switch (t.metric) {
      case 'ASSIGNED':
        return BigInt(new Set(d.assigned.map((r) => r.leadId)).size);
      case 'CONTACTED':
        return BigInt(new Set(d.contacted.map((r) => r.leadId)).size);
      case 'COUNSELLING':
        return BigInt(d.counselling.length);
      case 'ADMISSIONS':
        return BigInt(d.admissionsConfirmed.length - d.admissionsCancelled.length);
      case 'COLLECTIONS':
        return sum(d.payments);
      case 'REVENUE':
        return sum(d.payments) - sum(d.refundsPaid);
    }
  }

  async create(p: OrgPrincipal, input: z.infer<typeof TargetSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      let brandId = input.brandId ?? null;
      if (input.scope === 'TEAM') {
        const team = await tx.team.findUnique({
          where: { id: input.teamId ?? '00000000-0000-0000-0000-000000000000' },
        });
        if (!team) throw badRequest('TEAM_REQUIRED', 'Choose a team');
        brandId = team.brandId;
      }
      if (input.scope === 'USER' && !input.userId)
        throw badRequest('USER_REQUIRED', 'Choose a person');
      if (input.scope === 'BRAND' && !brandId) throw badRequest('BRAND_REQUIRED', 'Choose a brand');
      if (input.scope === 'ORGANIZATION') brandId = null;
      if (!this.canManage(p, brandId)) throw forbidden();
      const t = await tx.target.create({
        data: {
          organizationId: p.organizationId,
          scope: input.scope,
          brandId,
          teamId: input.scope === 'TEAM' ? input.teamId! : null,
          userId: input.scope === 'USER' ? input.userId! : null,
          courseId: input.courseId ?? null,
          metric: input.metric,
          periodStart: new Date(`${input.periodStart}T00:00:00.000Z`),
          periodEnd: new Date(`${input.periodEnd}T00:00:00.000Z`),
          value: BigInt(input.value),
          currency: input.currency ?? null,
          createdById: p.userId,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId,
        actorUserId: p.userId,
        action: 'target.created',
        entityType: 'target',
        entityId: t.id,
        after: { ...input },
      });
      return t;
    });
  }

  async update(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateTargetSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const t = await tx.target.findUnique({ where: { id } });
      if (!t) throw notFound('Target');
      if (!this.canManage(p, t.brandId)) throw forbidden();
      const u = await tx.target.update({ where: { id }, data: { value: BigInt(input.value) } });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: t.brandId,
        actorUserId: p.userId,
        action: 'target.updated',
        entityType: 'target',
        entityId: id,
        before: { value: t.value },
        after: { value: input.value },
      });
      return u;
    });
  }

  // ------------------------------------------------------------ ad spend
  listSpend(p: OrgPrincipal, brandId?: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const v = p.authz.visibleBrandIds('campaign.manage');
      const r = p.authz.visibleBrandIds('report.read');
      const all = v.all || r.all;
      const ids = [...new Set([...v.brandIds, ...r.brandIds])];
      if (!all && !ids.length) throw forbidden();
      return tx.adSpend.findMany({
        where: brandId ? { brandId } : all ? {} : { brandId: { in: ids } },
        orderBy: [{ month: 'desc' }],
        take: 500,
      });
    });
  }

  upsertSpend(p: OrgPrincipal, input: z.infer<typeof AdSpendSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const campaign = await tx.campaign.findUnique({ where: { id: input.campaignId } });
      if (!campaign) throw notFound('Campaign');
      if (!p.authz.can('campaign.manage', { brandId: campaign.brandId })) throw forbidden();
      const brand = await tx.brand.findUniqueOrThrow({ where: { id: campaign.brandId } });
      const month = new Date(`${input.month}-01T00:00:00.000Z`);
      const row = await tx.adSpend.upsert({
        where: { campaignId_month: { campaignId: campaign.id, month } },
        create: {
          organizationId: p.organizationId,
          brandId: campaign.brandId,
          campaignId: campaign.id,
          month,
          amountMinor: BigInt(input.amountMinor),
          currency: brand.currency,
          createdById: p.userId,
          createdAt: now,
        },
        update: { amountMinor: BigInt(input.amountMinor) },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: campaign.brandId,
        actorUserId: p.userId,
        action: 'ad_spend.recorded',
        entityType: 'ad_spend',
        entityId: row.id,
        after: { month: input.month, amountMinor: input.amountMinor },
      });
      return row;
    });
  }

  // ----------------------------------------------------------- incentives
  rules(p: OrgPrincipal, brandId: string) {
    if (!this.canManage(p, brandId) && !p.authz.can('report.read', { brandId })) throw forbidden();
    return this.db.tenant(p.organizationId, (tx) =>
      tx.incentiveRule.findMany({
        where: { brandId },
        orderBy: [{ name: 'asc' }, { version: 'desc' }],
      }),
    );
  }

  /** Rules are append-only: saving a rule with an existing name creates the next version. */
  createRule(p: OrgPrincipal, input: z.infer<typeof IncentiveRuleSchema>) {
    if (!this.canManage(p, input.brandId)) throw forbidden();
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const brand = await tx.brand.findUniqueOrThrow({ where: { id: input.brandId } });
      const last = await tx.incentiveRule.aggregate({
        where: { brandId: input.brandId, name: input.name },
        _max: { version: true },
      });
      const rule = await tx.incentiveRule.create({
        data: {
          organizationId: p.organizationId,
          brandId: input.brandId,
          name: input.name,
          version: (last._max.version ?? 0) + 1,
          basis: input.basis,
          amountMinor: input.amountMinor !== undefined ? BigInt(input.amountMinor) : null,
          percentBp: input.percentBp ?? null,
          currency: brand.currency,
          thresholdCount: input.thresholdCount,
          capMinor: input.capMinor !== undefined ? BigInt(input.capMinor) : null,
          excludedCourseIds: input.excludedCourseIds,
          firstContactSharePct: input.firstContactSharePct,
          effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00.000Z`),
          effectiveTo: input.effectiveTo ? new Date(`${input.effectiveTo}T00:00:00.000Z`) : null,
          createdById: p.userId,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: input.brandId,
        actorUserId: p.userId,
        action: 'incentive_rule.created',
        entityType: 'incentive_rule',
        entityId: rule.id,
        after: { ...input, version: rule.version },
      });
      return rule;
    });
  }

  /**
   * Preview run (DRAFT): one line per person, inputs stored (admission / payment ids, rule version).
   * Split per admission between first-contact and closing executive (A-005b); threshold and cap per person;
   * clawbacks for admissions credited in an earlier APPROVED run that were fully refunded in this period (A-007c).
   */
  async run(p: OrgPrincipal, input: z.infer<typeof IncentiveRunSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const rule = await tx.incentiveRule.findUnique({ where: { id: input.ruleId } });
      if (!rule) throw notFound('Incentive rule');
      if (!this.canManage(p, rule.brandId)) throw forbidden();
      const start = new Date(`${input.periodStart}T00:00:00.000Z`);
      const end = new Date(`${input.periodEnd}T00:00:00.000Z`);
      if (start < rule.effectiveFrom || (rule.effectiveTo && end > rule.effectiveTo))
        throw badRequest(
          'RULE_NOT_EFFECTIVE',
          'The rule version is not effective for the whole period',
        );
      const ctx = await this.contextFor(tx, p.organizationId, {
        brandId: rule.brandId,
        from: start,
        to: end,
      });
      const d = await this.reports.collectWith(tx, ctx);
      const excluded = new Set(rule.excludedCourseIds);
      const fcPct = BigInt(rule.firstContactSharePct);

      type Credit = { ref: string; kind: 'ADMISSION' | 'PAYMENT'; base: bigint; sharePct: bigint };
      const credits = new Map<string, Credit[]>();
      const credit = (userId: string | null, c: Credit) => {
        if (!userId || c.sharePct === 0n) return;
        credits.set(userId, [...(credits.get(userId) ?? []), c]);
      };
      const split = (
        closer: string | null,
        first: string | null,
        ref: string,
        kind: Credit['kind'],
        base: bigint,
      ) => {
        if (!first || first === closer) credit(closer, { ref, kind, base, sharePct: 100n });
        else {
          credit(closer, { ref, kind, base, sharePct: 100n - fcPct });
          credit(first, { ref, kind, base, sharePct: fcPct });
        }
      };
      if (rule.basis === 'PER_ADMISSION') {
        for (const a of d.admissionsConfirmed)
          if (!a.courseId || !excluded.has(a.courseId))
            split(
              a.userId,
              (a.flags?.firstContactUserId as string | null) ?? null,
              a.id,
              'ADMISSION',
              rule.amountMinor!,
            );
      } else {
        const fc = new Map(
          d.admissionsConfirmed.map((a) => [
            a.leadId,
            (a.flags?.firstContactUserId as string | null) ?? null,
          ]),
        );
        for (const pay of d.payments)
          if (pay.currency === rule.currency && (!pay.courseId || !excluded.has(pay.courseId)))
            split(
              pay.userId,
              fc.get(pay.leadId) ?? null,
              pay.id,
              'PAYMENT',
              (pay.amountMinor! * BigInt(rule.percentBp!)) / 10000n,
            );
        for (const r of d.refundsPaid)
          if (r.currency === rule.currency && (!r.courseId || !excluded.has(r.courseId)))
            split(
              r.userId,
              fc.get(r.leadId) ?? null,
              r.id,
              'PAYMENT',
              -((r.amountMinor! * BigInt(rule.percentBp!)) / 10000n),
            );
      }

      const lines: Array<{
        userId: string;
        kind: string;
        amountMinor: bigint;
        inputs: Record<string, unknown>;
      }> = [];
      for (const [userId, cs] of credits) {
        const count = new Set(cs.filter((c) => c.kind === 'ADMISSION').map((c) => c.ref)).size;
        const gross = cs.reduce((s, c) => s + (c.base * c.sharePct) / 100n, 0n);
        const meets = rule.basis !== 'PER_ADMISSION' || count >= rule.thresholdCount;
        const capped = rule.capMinor !== null && gross > rule.capMinor ? rule.capMinor : gross;
        lines.push({
          userId,
          kind: 'EARNED',
          amountMinor: meets ? capped : 0n,
          inputs: {
            ruleId: rule.id,
            ruleVersion: rule.version,
            credits: cs.map((c) => ({
              ref: c.ref,
              kind: c.kind,
              base: c.base.toString(),
              sharePct: Number(c.sharePct),
            })),
            admissions: count,
            thresholdMet: meets,
            capped: capped !== gross,
          },
        });
      }

      // Clawbacks: fully refunded admissions previously paid out in an approved run of this brand.
      if (d.admissionsCancelled.length) {
        const cancelled = new Set(d.admissionsCancelled.map((a) => a.id));
        const approved = await tx.incentiveRun.findMany({
          where: { brandId: rule.brandId, status: 'APPROVED' },
          select: { id: true },
        });
        const prior = await tx.incentiveLine.findMany({
          where: { runId: { in: approved.map((r) => r.id) }, kind: 'EARNED' },
        });
        const already = await tx.incentiveLine.findMany({
          where: { runId: { in: approved.map((r) => r.id) }, kind: 'CLAWBACK' },
        });
        const clawed = new Set(
          already.flatMap((l) =>
            ((l.inputs as { admissionIds?: string[] }).admissionIds ?? []).map(
              (a) => `${l.userId}:${a}`,
            ),
          ),
        );
        const per = new Map<string, { amount: bigint; admissionIds: string[] }>();
        for (const l of prior) {
          const inp = l.inputs as {
            credits?: Array<{ ref: string; kind: string; base: string; sharePct: number }>;
            thresholdMet?: boolean;
          };
          if (!inp.thresholdMet || l.amountMinor === 0n) continue;
          for (const c of inp.credits ?? []) {
            if (
              c.kind !== 'ADMISSION' ||
              !cancelled.has(c.ref) ||
              clawed.has(`${l.userId}:${c.ref}`)
            )
              continue;
            const e = per.get(l.userId) ?? { amount: 0n, admissionIds: [] };
            e.amount += (BigInt(c.base) * BigInt(c.sharePct)) / 100n;
            e.admissionIds.push(c.ref);
            per.set(l.userId, e);
          }
        }
        for (const [userId, e] of per)
          lines.push({
            userId,
            kind: 'CLAWBACK',
            amountMinor: -e.amount,
            inputs: {
              ruleId: rule.id,
              ruleVersion: rule.version,
              admissionIds: e.admissionIds,
              reason: 'Admission fully refunded (A-007c)',
            },
          });
      }

      const run = await tx.incentiveRun.create({
        data: {
          organizationId: p.organizationId,
          brandId: rule.brandId,
          ruleId: rule.id,
          periodStart: start,
          periodEnd: end,
          totalMinor: lines.reduce((s, l) => s + l.amountMinor, 0n),
          currency: rule.currency,
          createdById: p.userId,
          createdAt: now,
        },
      });
      if (lines.length)
        await tx.incentiveLine.createMany({
          data: lines.map((l) => ({
            organizationId: p.organizationId,
            runId: run.id,
            userId: l.userId,
            kind: l.kind,
            amountMinor: l.amountMinor,
            currency: rule.currency,
            inputs: JSON.parse(JSON.stringify(l.inputs)),
            createdAt: now,
          })),
        });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: rule.brandId,
        actorUserId: p.userId,
        action: 'incentive_run.created',
        entityType: 'incentive_run',
        entityId: run.id,
        after: { ruleId: rule.id, version: rule.version, totalMinor: run.totalMinor.toString() },
      });
      return this.present(tx, run.id);
    });
  }

  private async present(tx: Tx, runId: string) {
    const run = await tx.incentiveRun.findUniqueOrThrow({ where: { id: runId } });
    const lines = await tx.incentiveLine.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });
    const users = await tx.user.findMany({
      where: { id: { in: lines.map((l) => l.userId) } },
      select: { id: true, name: true },
    });
    const um = new Map(users.map((u) => [u.id, u.name]));
    return { ...run, lines: lines.map((l) => ({ ...l, userName: um.get(l.userId) ?? null })) };
  }

  getRun(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const run = await tx.incentiveRun.findUnique({ where: { id } });
      if (
        !run ||
        (!this.canManage(p, run.brandId) && !p.authz.can('report.read', { brandId: run.brandId }))
      )
        throw notFound('Incentive run');
      return this.present(tx, id);
    });
  }

  listRuns(p: OrgPrincipal, brandId: string) {
    if (!this.canManage(p, brandId) && !p.authz.can('report.read', { brandId })) throw forbidden();
    return this.db.tenant(p.organizationId, (tx) =>
      tx.incentiveRun.findMany({ where: { brandId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    );
  }

  /** Approval locks the run for good (database trigger); approver ≠ creator. */
  approve(p: OrgPrincipal, id: string) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const run = await tx.incentiveRun.findUnique({ where: { id } });
      if (!run) throw notFound('Incentive run');
      if (!this.canManage(p, run.brandId)) throw forbidden();
      if (run.status === 'APPROVED') throw conflict('RUN_APPROVED', 'This run is already approved');
      if (run.createdById === p.userId)
        throw forbidden('A run must be approved by someone other than its creator');
      await tx.incentiveRun.update({
        where: { id },
        data: { status: 'APPROVED', approvedById: p.userId, approvedAt: now },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: run.brandId,
        actorUserId: p.userId,
        action: 'incentive_run.approved',
        entityType: 'incentive_run',
        entityId: id,
        after: { totalMinor: run.totalMinor.toString() },
      });
      return this.present(tx, id);
    });
  }
}
