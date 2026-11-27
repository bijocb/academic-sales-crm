import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AllocationOutcome, AllocationStrategy } from '@prisma/client';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { isWorkingTime } from '../settings/business-calendar';
import { SettingsService } from '../settings/settings.service';
import { CandidateInput, decide, matchRule } from './rank';
import { NotificationsService } from './notifications.service';

const ACTIVE = ['OPEN', 'ON_HOLD', 'IN_RECOVERY'] as const;

export interface AllocateOptions {
  trigger: 'LEAD_CREATED' | 'QUEUE_DRAIN' | 'MANUAL_RETRY' | 'SEED' | 'SLA_REASSIGN';
  /** Users that must not receive this lead (e.g. previous owners during reassignment). */
  exclude?: string[];
  ignoreWorkingHours?: boolean;
  actorUserId?: string | null;
}

export interface AllocateResult {
  outcome: AllocationOutcome;
  ownerId?: string | null;
  runId?: string;
}

/** Lead allocation engine (FR-007). See docs/plans/PHASE-06.md. */
@Injectable()
export class AllocationService {
  private readonly logger = new Logger('Allocation');

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------ engine
  async allocate(
    organizationId: string,
    leadId: string,
    opts: AllocateOptions,
  ): Promise<AllocateResult> {
    return this.db.tenant(organizationId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'alloc:' + leadId}))`;
      const lead = await tx.lead.findUnique({ where: { id: leadId }, include: { person: true } });
      if (!lead) throw notFound('Lead');
      if (lead.ownerId || !(ACTIVE as readonly string[]).includes(lead.status))
        return { outcome: 'ALREADY_ASSIGNED' as const, ownerId: lead.ownerId };
      const settings = await tx.allocationSettings.findUnique({ where: { brandId: lead.brandId } });
      if (!settings || !settings.enabled) return { outcome: 'DISABLED' as const };
      const now = this.clock.now();

      if (settings.respectWorkingHours && !opts.ignoreWorkingHours) {
        const cal = await this.settings.calendar(tx, lead.brandId);
        if (!isWorkingTime(now, cal)) {
          const run = await this.recordRun(
            tx,
            lead,
            opts,
            'OUTSIDE_WORKING_HOURS',
            settings.ruleVersion,
            settings.defaultStrategy,
            null,
            null,
            [],
            now,
          );
          return { outcome: 'OUTSIDE_WORKING_HOURS' as const, runId: run.id };
        }
      }

      const lastEnquiry = await tx.enquiry.findFirst({
        where: { leadId },
        orderBy: { receivedAt: 'desc' },
        select: { channel: true },
      });
      const rules = await tx.allocationRule.findMany({
        where: { brandId: lead.brandId },
        orderBy: { position: 'asc' },
      });
      const rule = matchRule(rules, {
        courseId: lead.courseId,
        channel: lastEnquiry?.channel ?? 'OTHER',
        language: lead.person.language,
        city: lead.person.city,
      });
      let pool: Set<string> | null = null;
      if (rule) {
        pool = new Set(rule.userIds);
        if (rule.teamId) {
          const members = await tx.teamMember.findMany({
            where: { teamId: rule.teamId, leftAt: null },
            select: { userId: true },
          });
          members.forEach((m) => pool!.add(m.userId));
        }
      }
      const strategy: AllocationStrategy = rule?.strategy ?? settings.defaultStrategy;
      const candidates = await this.candidates(tx, lead.brandId, now);
      const cooldownExclusions = await this.recentOwners(tx, lead, now);
      const decision = decide(candidates, {
        strategy,
        leadLanguage: lead.person.language,
        pool,
        exclude: new Set([...(opts.exclude ?? []), ...cooldownExclusions]),
      });
      const outcome: AllocationOutcome = decision.chosen ? 'ASSIGNED' : 'NO_ELIGIBLE_USER';
      const run = await this.recordRun(
        tx,
        lead,
        opts,
        outcome,
        settings.ruleVersion,
        strategy,
        rule?.id ?? null,
        decision.chosen,
        decision.candidates,
        now,
      );

      if (!decision.chosen) {
        await this.notifyManagers(tx, lead, now);
        return { outcome, runId: run.id };
      }
      await this.assign(tx, {
        lead,
        toUserId: decision.chosen,
        type: opts.trigger === 'SLA_REASSIGN' ? 'REASSIGN_AUTO' : 'AUTO',
        reason: rule
          ? `Rule: ${rule.name}`
          : `Brand pool (${strategy.toLowerCase().replace('_', ' ')})`,
        runId: run.id,
        ruleVersion: settings.ruleVersion,
        actorUserId: opts.actorUserId ?? null,
        overCapacity: false,
        now,
      });
      return { outcome, ownerId: decision.chosen, runId: run.id };
    });
  }

  /** Allocates queued (unowned, active) leads of a brand, oldest first. Stops early outside working hours. */
  async drainQueue(
    organizationId: string,
    brandId: string,
    opts: { limit?: number; actorUserId?: string | null; ignoreWorkingHours?: boolean } = {},
  ) {
    const queued = await this.db.tenant(organizationId, (tx) =>
      tx.lead.findMany({
        where: { brandId, ownerId: null, status: { in: [...ACTIVE] } },
        orderBy: { createdAt: 'asc' },
        take: opts.limit ?? 100,
        select: { id: true },
      }),
    );
    const summary = { attempted: 0, assigned: 0, stillQueued: 0 };
    for (const l of queued) {
      const r = await this.allocate(organizationId, l.id, {
        trigger: 'QUEUE_DRAIN',
        actorUserId: opts.actorUserId,
        ignoreWorkingHours: opts.ignoreWorkingHours,
      });
      summary.attempted++;
      if (r.outcome === 'ASSIGNED') summary.assigned++;
      else summary.stillQueued++;
      if (r.outcome === 'OUTSIDE_WORKING_HOURS' || r.outcome === 'DISABLED') break;
    }
    return summary;
  }

  /** Never throws: allocation failures must not lose the lead (it stays in the queue). */
  async allocateAfterIntake(
    organizationId: string,
    brandId: string,
    leadId: string,
  ): Promise<void> {
    try {
      const r = await this.allocate(organizationId, leadId, { trigger: 'LEAD_CREATED' });
      if (r.outcome === 'ASSIGNED') await this.drainQueue(organizationId, brandId, { limit: 10 });
    } catch (e) {
      this.logger.error(
        { err: e, leadId },
        'Allocation failed; lead remains in the unassigned queue',
      );
    }
  }

  // ---------------------------------------------------------- manual assign
  async manualAssign(p: OrgPrincipal, leadId: string, userId: string, reason: string) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'alloc:' + leadId}))`;
      const lead = await tx.lead.findUnique({ where: { id: leadId }, include: { person: true } });
      if (!lead) throw notFound('Lead');
      if (!(ACTIVE as readonly string[]).includes(lead.status))
        throw badRequest('LEAD_NOT_ACTIVE', 'Only open leads can be assigned');
      if (lead.ownerId === userId)
        throw badRequest('ALREADY_OWNER', 'This user already owns the lead');
      const perm = lead.ownerId ? 'lead.reassign' : 'lead.assign';
      const brandWide =
        p.authz.can(perm, { brandId: lead.brandId }) ||
        (!lead.ownerId && p.authz.can('lead.reassign', { brandId: lead.brandId }));
      if (!brandWide) {
        // Team-scoped: both the current owner (if any) and the new owner must be in the actor's teams.
        const s = p.authz.scope('lead.reassign');
        if (!s.teamIds.length && !s.branchIds.length) throw notFound('Lead');
        const members = await tx.teamMember.findMany({
          where: {
            leftAt: null,
            team: { OR: [{ id: { in: s.teamIds } }, { branchId: { in: s.branchIds } }] },
          },
          select: { userId: true },
        });
        const mine = new Set(members.map((m) => m.userId));
        if (!lead.ownerId || !mine.has(lead.ownerId)) throw notFound('Lead');
        if (!mine.has(userId)) throw forbidden('You can only reassign within your team');
      }
      const target = (await this.candidates(tx, lead.brandId, now)).find(
        (c) => c.userId === userId,
      );
      if (!target) throw badRequest('NOT_ELIGIBLE', 'This user cannot receive leads in this brand');
      const overCapacity =
        target.maxActiveLeads !== null && target.activeLeads >= target.maxActiveLeads;
      await this.assign(tx, {
        lead,
        toUserId: userId,
        type: 'MANUAL',
        reason,
        runId: null,
        ruleVersion: null,
        actorUserId: p.userId,
        overCapacity,
        now,
      });
      return {
        leadId,
        ownerId: userId,
        overCapacity,
        unavailable: !target.isAvailable || target.onLeave,
      };
    });
  }

  // ------------------------------------------------------------- helpers
  /** Everyone who may receive leads in this brand, with live load/availability. */
  async candidates(tx: Tx, brandId: string, now: Date): Promise<CandidateInput[]> {
    const brand = await tx.brand.findUniqueOrThrow({ where: { id: brandId } });
    const grants = await tx.roleAssignment.findMany({
      where: {
        revokedAt: null,
        brandId, // brand/branch/team grants inside this brand; organization-wide grants never make someone a recipient
        role: { permissions: { some: { permission: 'lead.receive' } } },
        user: { status: 'ACTIVE' },
      },
      select: { userId: true },
    });
    const userIds = [...new Set(grants.map((g) => g.userId))];
    if (!userIds.length) return [];
    const today = DateTime.fromJSDate(now, { zone: brand.timezone }).toISODate()!;
    const todayDate = new Date(`${today}T00:00:00.000Z`);
    const [users, loads, lasts, leaves] = await Promise.all([
      tx.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, isAvailable: true, maxActiveLeads: true, languages: true },
      }),
      tx.lead.groupBy({
        by: ['ownerId'],
        where: { ownerId: { in: userIds }, status: { in: [...ACTIVE] } },
        _count: { _all: true },
      }),
      tx.leadAssignment.groupBy({
        by: ['toUserId'],
        where: { toUserId: { in: userIds } },
        _max: { assignedAt: true },
      }),
      tx.userLeave.findMany({
        where: {
          userId: { in: userIds },
          cancelledAt: null,
          startDate: { lte: todayDate },
          endDate: { gte: todayDate },
        },
        select: { userId: true },
      }),
    ]);
    const load = new Map(loads.map((l) => [l.ownerId, l._count._all]));
    const last = new Map(lasts.map((l) => [l.toUserId, l._max.assignedAt]));
    const onLeave = new Set(leaves.map((l) => l.userId));
    return users.map((u) => ({
      userId: u.id,
      name: u.name,
      isAvailable: u.isAvailable,
      onLeave: onLeave.has(u.id),
      activeLeads: load.get(u.id) ?? 0,
      maxActiveLeads: u.maxActiveLeads,
      languages: u.languages,
      lastAssignedAt: last.get(u.id) ?? null,
    }));
  }

  /** Previous owners of this lead within the brand's reassignment cooldown. */
  private async recentOwners(
    tx: Tx,
    lead: { id: string; brandId: string },
    now: Date,
  ): Promise<string[]> {
    const policy = await tx.slaPolicy.findUnique({
      where: { brandId: lead.brandId },
      select: { reassignCooldownMinutes: true },
    });
    const since = new Date(now.getTime() - (policy?.reassignCooldownMinutes ?? 0) * 60_000);
    const prev = await tx.leadAssignment.findMany({
      where: { leadId: lead.id, assignedAt: { gte: since } },
      select: { toUserId: true },
    });
    return prev.map((x) => x.toUserId);
  }

  private recordRun(
    tx: Tx,
    lead: { id: string; organizationId: string; brandId: string },
    opts: AllocateOptions,
    outcome: AllocationOutcome,
    ruleVersion: number,
    strategy: AllocationStrategy,
    ruleId: string | null,
    chosenUserId: string | null,
    candidates: unknown[],
    now: Date,
  ) {
    return tx.allocationRun.create({
      data: {
        organizationId: lead.organizationId,
        brandId: lead.brandId,
        leadId: lead.id,
        trigger: opts.trigger,
        outcome,
        ruleId,
        ruleVersion,
        strategy,
        chosenUserId,
        candidates: candidates as Prisma.InputJsonValue,
        createdAt: now,
      },
    });
  }

  private async assign(
    tx: Tx,
    a: {
      lead: {
        id: string;
        organizationId: string;
        brandId: string;
        ownerId: string | null;
        leadNumber: string;
        person: { fullName: string };
      };
      toUserId: string;
      type: 'AUTO' | 'MANUAL' | 'REASSIGN_AUTO';
      reason: string;
      runId: string | null;
      ruleVersion: number | null;
      actorUserId: string | null;
      overCapacity: boolean;
      now: Date;
    },
  ) {
    const { lead, now } = a;
    const attemptNo = (await tx.leadAssignment.count({ where: { leadId: lead.id } })) + 1;
    await tx.lead.update({ where: { id: lead.id }, data: { ownerId: a.toUserId } });
    const row = await tx.leadAssignment.create({
      data: {
        organizationId: lead.organizationId,
        brandId: lead.brandId,
        leadId: lead.id,
        fromUserId: lead.ownerId,
        toUserId: a.toUserId,
        type: a.type,
        reason: a.reason,
        attemptNo,
        allocationRunId: a.runId,
        ruleVersion: a.ruleVersion,
        overCapacity: a.overCapacity,
        assignedById: a.actorUserId,
        assignedAt: now,
      },
    });
    const toName =
      (await tx.user.findUnique({ where: { id: a.toUserId }, select: { name: true } }))?.name ??
      'user';
    await tx.leadEvent.create({
      data: {
        organizationId: lead.organizationId,
        leadId: lead.id,
        type: lead.ownerId ? 'REASSIGNED' : 'ASSIGNED',
        actorUserId: a.actorUserId,
        body: `${lead.ownerId ? 'Reassigned' : 'Assigned'} to ${toName} — ${a.reason}`,
        data: {
          assignmentId: row.id,
          type: a.type,
          toUserId: a.toUserId,
          fromUserId: lead.ownerId,
          overCapacity: a.overCapacity,
        },
        occurredAt: now,
      },
    });
    await this.notifications.create(tx, {
      organizationId: lead.organizationId,
      userId: a.toUserId,
      type: 'LEAD_ASSIGNED',
      title: `New lead: ${lead.person.fullName} (${lead.leadNumber})`,
      body: a.reason,
      link: `/leads/${lead.id}`,
      dedupKey: `assigned:${row.id}`,
      now,
    });
    if (lead.ownerId) {
      await this.notifications.create(tx, {
        organizationId: lead.organizationId,
        userId: lead.ownerId,
        type: 'LEAD_REASSIGNED_AWAY',
        title: `${lead.leadNumber} was reassigned to ${toName}`,
        body: a.reason,
        link: `/leads/${lead.id}`,
        dedupKey: `away:${row.id}`,
        now,
      });
    }
    await tx.outboxEvent.create({
      data: {
        organizationId: lead.organizationId,
        type: 'lead.assigned',
        aggregateType: 'lead',
        aggregateId: lead.id,
        payload: {
          assignmentId: row.id,
          toUserId: a.toUserId,
          fromUserId: lead.ownerId,
          type: a.type,
        },
      },
    });
    await this.audit.record(tx, {
      organizationId: lead.organizationId,
      brandId: lead.brandId,
      actorUserId: a.actorUserId,
      action: lead.ownerId ? 'lead.reassigned' : 'lead.assigned',
      entityType: 'lead',
      entityId: lead.id,
      before: { ownerId: lead.ownerId },
      after: { ownerId: a.toUserId, type: a.type, attemptNo, overCapacity: a.overCapacity },
      reason: a.reason,
    });
  }

  /** Tells brand managers (lead.assign in the brand) once per lead that it could not be allocated. */
  private async notifyManagers(
    tx: Tx,
    lead: {
      id: string;
      organizationId: string;
      brandId: string;
      leadNumber: string;
      person: { fullName: string };
    },
    now: Date,
  ) {
    const managers = await tx.roleAssignment.findMany({
      where: {
        revokedAt: null,
        OR: [{ scopeType: 'ORGANIZATION' }, { scopeType: 'BRAND', brandId: lead.brandId }],
        role: { permissions: { some: { permission: 'lead.assign' } } },
        user: { status: 'ACTIVE' },
      },
      select: { userId: true },
    });
    for (const userId of new Set(managers.map((m) => m.userId))) {
      await this.notifications.create(tx, {
        organizationId: lead.organizationId,
        userId,
        type: 'LEAD_UNASSIGNED',
        title: `No one available for ${lead.person.fullName} (${lead.leadNumber})`,
        body: 'The lead is waiting in the unassigned queue.',
        link: '/allocation',
        dedupKey: `unassigned:${lead.id}`,
        now,
      });
    }
  }
}
