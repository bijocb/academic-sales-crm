import { Injectable } from '@nestjs/common';
import {
  AllocationRuleSchema,
  AllocationSettingsSchema,
  CreateLeaveSchema,
  UpdateAllocationRuleSchema,
  z,
} from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { userScopeWhere } from '../users/users.service';
import { AllocationService } from './allocation.service';
import { LeadsService } from '../leads/leads.service';

const toDate = (d: string) => new Date(`${d}T00:00:00.000Z`);

/** Allocation configuration, queue, executives overview, availability and leave. */
@Injectable()
export class AllocationAdminService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly engine: AllocationService,
    private readonly leads: LeadsService,
  ) {}

  /** Read access: lead.assign / lead.reassign / allocation.manage within the brand. */
  private assertView(p: OrgPrincipal, brandId: string) {
    const ok = (['allocation.manage', 'lead.assign', 'lead.reassign'] as const).some((perm) => {
      const v = p.authz.visibleBrandIds(perm);
      return v.all || v.brandIds.includes(brandId);
    });
    if (!ok) throw notFound('Brand');
  }

  private assertManage(p: OrgPrincipal, brandId: string) {
    this.assertView(p, brandId);
    if (!p.authz.can('allocation.manage', { brandId })) throw forbidden();
  }

  private async bumpVersion(tx: Tx, brandId: string) {
    await tx.allocationSettings.update({
      where: { brandId },
      data: { ruleVersion: { increment: 1 } },
    });
  }

  // ----------------------------------------------------------- settings
  getSettings(p: OrgPrincipal, brandId: string) {
    this.assertView(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const s = await tx.allocationSettings.findUnique({ where: { brandId } });
      if (!s) throw notFound('Allocation settings');
      return s;
    });
  }

  updateSettings(
    p: OrgPrincipal,
    brandId: string,
    input: z.infer<typeof AllocationSettingsSchema>,
  ) {
    this.assertManage(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.allocationSettings.findUniqueOrThrow({ where: { brandId } });
      const after = await tx.allocationSettings.update({
        where: { brandId },
        data: { ...input, ruleVersion: { increment: 1 } },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId,
        action: 'allocation.settings_updated',
        entityType: 'allocation_settings',
        entityId: after.id,
        before,
        after,
      });
      return after;
    });
  }

  // -------------------------------------------------------------- rules
  listRules(p: OrgPrincipal, brandId: string) {
    this.assertView(p, brandId);
    return this.db.tenant(p.organizationId, (tx) =>
      tx.allocationRule.findMany({ where: { brandId }, orderBy: { position: 'asc' } }),
    );
  }

  private async validatePool(
    tx: Tx,
    brandId: string,
    teamId: string | null | undefined,
    userIds: string[] | undefined,
    courseIds: string[] | undefined,
  ) {
    if (teamId) {
      const team = await tx.team.findUnique({ where: { id: teamId } });
      if (!team || team.brandId !== brandId)
        throw badRequest('TEAM_NOT_IN_BRAND', 'Team does not belong to this brand');
    }
    if (
      userIds?.length &&
      (await tx.user.count({ where: { id: { in: userIds } } })) !== new Set(userIds).size
    ) {
      throw badRequest('USER_NOT_FOUND', 'One or more users were not found');
    }
    if (
      courseIds?.length &&
      (await tx.course.count({ where: { id: { in: courseIds }, brandId } })) !==
        new Set(courseIds).size
    ) {
      throw badRequest('COURSE_NOT_IN_BRAND', 'One or more courses do not belong to this brand');
    }
  }

  createRule(p: OrgPrincipal, input: z.infer<typeof AllocationRuleSchema>) {
    this.assertManage(p, input.brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.validatePool(tx, input.brandId, input.teamId, input.userIds, input.courseIds);
      const max = await tx.allocationRule.aggregate({
        where: { brandId: input.brandId },
        _max: { position: true },
      });
      const rule = await tx.allocationRule.create({
        data: {
          organizationId: p.organizationId,
          ...input,
          position: (max._max.position ?? 0) + 1,
        },
      });
      await this.bumpVersion(tx, input.brandId);
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: input.brandId,
        action: 'allocation.rule_created',
        entityType: 'allocation_rule',
        entityId: rule.id,
        after: rule,
      });
      return rule;
    });
  }

  updateRule(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateAllocationRuleSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.allocationRule.findUnique({ where: { id } });
      if (!before) throw notFound('Rule');
      this.assertManage(p, before.brandId);
      await this.validatePool(tx, before.brandId, input.teamId, input.userIds, input.courseIds);
      const teamId = input.teamId !== undefined ? input.teamId : before.teamId;
      const userIds = input.userIds ?? before.userIds;
      if (!teamId && !userIds.length)
        throw badRequest('EMPTY_POOL', 'Choose a team or at least one user');
      const after = await tx.allocationRule.update({ where: { id }, data: input });
      await this.bumpVersion(tx, before.brandId);
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: before.brandId,
        action: 'allocation.rule_updated',
        entityType: 'allocation_rule',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  deleteRule(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.allocationRule.findUnique({ where: { id } });
      if (!before) throw notFound('Rule');
      this.assertManage(p, before.brandId);
      await tx.allocationRule.delete({ where: { id } });
      await this.bumpVersion(tx, before.brandId);
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: before.brandId,
        action: 'allocation.rule_deleted',
        entityType: 'allocation_rule',
        entityId: id,
        before,
      });
    });
  }

  reorderRules(p: OrgPrincipal, brandId: string, ruleIds: string[]) {
    this.assertManage(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const rules = await tx.allocationRule.findMany({ where: { brandId }, select: { id: true } });
      if (rules.length !== ruleIds.length || !rules.every((r) => ruleIds.includes(r.id)))
        throw badRequest('INVALID_ORDER', 'Provide every rule of the brand exactly once');
      for (const [i, id] of ruleIds.entries())
        await tx.allocationRule.update({ where: { id }, data: { position: i + 1 } });
      await this.bumpVersion(tx, brandId);
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId,
        action: 'allocation.rules_reordered',
        entityType: 'allocation_settings',
        entityId: brandId,
        after: { ruleIds },
      });
      return tx.allocationRule.findMany({ where: { brandId }, orderBy: { position: 'asc' } });
    });
  }

  // ------------------------------------------------------- queue & people
  queue(p: OrgPrincipal, brandId: string) {
    this.assertView(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const leads = await tx.lead.findMany({
        where: { brandId, ownerId: null, status: { in: ['OPEN', 'ON_HOLD', 'IN_RECOVERY'] } },
        orderBy: { createdAt: 'asc' },
        take: 200,
        include: {
          person: { select: { fullName: true, language: true, city: true } },
          course: { select: { name: true } },
        },
      });
      const runs = await tx.allocationRun.findMany({
        where: { leadId: { in: leads.map((l) => l.id) } },
        orderBy: { createdAt: 'desc' },
        select: { leadId: true, outcome: true, createdAt: true },
      });
      const lastRun = new Map<string, { outcome: string; createdAt: Date }>();
      for (const r of runs) if (!lastRun.has(r.leadId)) lastRun.set(r.leadId, r);
      return leads.map((l) => ({
        id: l.id,
        leadNumber: l.leadNumber,
        createdAt: l.createdAt,
        person: l.person,
        course: l.course,
        lastAttempt: lastRun.get(l.id) ?? null,
      }));
    });
  }

  executives(p: OrgPrincipal, brandId: string) {
    this.assertView(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const list = await this.engine.candidates(tx, brandId, this.clock.now());
      return list.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  runs(p: OrgPrincipal, q: { brandId?: string; leadId?: string }) {
    return this.db.tenant(p.organizationId, async (tx) => {
      let brandId = q.brandId;
      if (q.leadId) {
        const lead = await tx.lead.findUnique({
          where: { id: q.leadId },
          select: { brandId: true },
        });
        if (!lead) throw notFound('Lead');
        brandId = lead.brandId;
      }
      if (!brandId) throw badRequest('BRAND_REQUIRED', 'brandId or leadId is required');
      this.assertView(p, brandId);
      return tx.allocationRun.findMany({
        where: { brandId, ...(q.leadId ? { leadId: q.leadId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    });
  }

  async drain(p: OrgPrincipal, brandId: string, ignoreWorkingHours: boolean) {
    this.assertView(p, brandId);
    if (!p.authz.can('lead.assign', { brandId })) throw forbidden();
    return this.engine.drainQueue(p.organizationId, brandId, {
      actorUserId: p.userId,
      ignoreWorkingHours,
    });
  }

  async retry(p: OrgPrincipal, leadId: string, ignoreWorkingHours: boolean) {
    const lead = await this.db.tenant(p.organizationId, (tx) =>
      tx.lead.findUnique({ where: { id: leadId }, select: { brandId: true } }),
    );
    if (!lead) throw notFound('Lead');
    this.assertView(p, lead.brandId);
    if (!p.authz.can('lead.assign', { brandId: lead.brandId })) throw forbidden();
    return this.engine.allocate(p.organizationId, leadId, {
      trigger: 'MANUAL_RETRY',
      actorUserId: p.userId,
      ignoreWorkingHours,
    });
  }

  /** Lead ownership history (append-only), newest first. */
  async history(p: OrgPrincipal, leadId: string) {
    await this.leads.get(p, leadId); // 404 unless the caller can see the lead
    return this.db.tenant(p.organizationId, async (tx) => {
      const rows = await tx.leadAssignment.findMany({
        where: { leadId },
        orderBy: { assignedAt: 'desc' },
      });
      const ids = [
        ...new Set(
          rows
            .flatMap((r) => [r.toUserId, r.fromUserId, r.assignedById])
            .filter((x): x is string => !!x),
        ),
      ];
      const names = new Map(
        (
          await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        ).map((u) => [u.id, u.name]),
      );
      return rows.map((r) => ({
        ...r,
        toName: names.get(r.toUserId),
        fromName: r.fromUserId ? names.get(r.fromUserId) : null,
        byName: r.assignedById ? names.get(r.assignedById) : null,
      }));
    });
  }

  // ------------------------------------------------- availability & leave
  setAvailability(p: OrgPrincipal, isAvailable: boolean) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const u = await tx.user.update({
        where: { id: p.userId },
        data: { isAvailable, availabilityChangedAt: this.clock.now() },
        select: { id: true, isAvailable: true, availabilityChangedAt: true },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        action: isAvailable ? 'user.available' : 'user.unavailable',
        entityType: 'user',
        entityId: p.userId,
      });
      return u;
    });
  }

  myAvailability(p: OrgPrincipal) {
    return this.db.tenant(p.organizationId, (tx) =>
      tx.user.findUniqueOrThrow({
        where: { id: p.userId },
        select: { isAvailable: true, availabilityChangedAt: true },
      }),
    );
  }

  private async assertLeaveAccess(tx: Tx, p: OrgPrincipal, userId: string) {
    if (userId === p.userId) return;
    if (!p.authz.has('user.manage')) throw forbidden();
    const visible = await tx.user.findFirst({
      where: { AND: [{ id: userId }, userScopeWhere(p.authz.scope('user.manage'), p.userId)] },
    });
    if (!visible) throw notFound('User');
  }

  listLeaves(p: OrgPrincipal, userId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.assertLeaveAccess(tx, p, userId);
      return tx.userLeave.findMany({
        where: { userId, cancelledAt: null },
        orderBy: { startDate: 'desc' },
      });
    });
  }

  addLeave(p: OrgPrincipal, userId: string, input: z.infer<typeof CreateLeaveSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.assertLeaveAccess(tx, p, userId);
      const leave = await tx.userLeave.create({
        data: {
          organizationId: p.organizationId,
          userId,
          startDate: toDate(input.startDate),
          endDate: toDate(input.endDate),
          reason: input.reason,
          createdById: p.userId,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        action: 'user.leave_added',
        entityType: 'user',
        entityId: userId,
        after: input,
      });
      return leave;
    });
  }

  cancelLeave(p: OrgPrincipal, leaveId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const leave = await tx.userLeave.findUnique({ where: { id: leaveId } });
      if (!leave || leave.cancelledAt) throw notFound('Leave');
      await this.assertLeaveAccess(tx, p, leave.userId);
      await tx.userLeave.update({
        where: { id: leaveId },
        data: { cancelledAt: this.clock.now() },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        action: 'user.leave_cancelled',
        entityType: 'user',
        entityId: leave.userId,
      });
    });
  }
}
