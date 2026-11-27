import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CreateTeamInput, UpdateTeamSchema, z } from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { ScopeSet } from '../auth/authz';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';

/** Prisma filter for teams inside a scope set. */
export function teamScopeWhere(s: ScopeSet): Prisma.TeamWhereInput {
  if (s.all) return {};
  return {
    OR: [
      { brandId: { in: s.brandIds } },
      { branchId: { in: s.branchIds } },
      { id: { in: s.teamIds } },
    ],
  };
}

const teamTarget = (t: { id: string; brandId: string; branchId: string | null }) => ({
  brandId: t.brandId,
  branchId: t.branchId,
  teamId: t.id,
});

@Injectable()
export class TeamsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  list(p: OrgPrincipal, brandId?: string) {
    const where: Prisma.TeamWhereInput = {
      AND: [teamScopeWhere(p.authz.scope('team.read')), brandId ? { brandId } : {}],
    };
    return this.db.tenant(p.organizationId, (tx) =>
      tx.team.findMany({
        where,
        orderBy: { name: 'asc' },
        include: {
          leader: { select: { id: true, name: true, email: true } },
          _count: { select: { members: { where: { leftAt: null } } } },
        },
      }),
    );
  }

  async get(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const team = await tx.team.findUnique({
        where: { id },
        include: {
          leader: { select: { id: true, name: true, email: true } },
          members: {
            where: { leftAt: null },
            include: { user: { select: { id: true, name: true, email: true, status: true } } },
            orderBy: { joinedAt: 'asc' },
          },
        },
      });
      if (!team || !p.authz.can('team.read', teamTarget(team))) throw notFound('Team');
      return team;
    });
  }

  create(p: OrgPrincipal, input: CreateTeamInput) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const brand = await tx.brand.findUnique({ where: { id: input.brandId } });
      if (!brand) throw notFound('Brand');
      if (input.branchId) {
        const branch = await tx.branch.findUnique({ where: { id: input.branchId } });
        if (!branch || branch.brandId !== input.brandId)
          throw badRequest('BRANCH_NOT_IN_BRAND', 'Branch does not belong to this brand');
      }
      if (!p.authz.can('team.manage', { brandId: input.brandId, branchId: input.branchId ?? null }))
        throw forbidden();
      if (input.leaderId) await this.assertOrgUser(tx, input.leaderId);
      const team = await tx.team.create({
        data: {
          organizationId: p.organizationId,
          brandId: input.brandId,
          branchId: input.branchId,
          name: input.name,
          leaderId: input.leaderId,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: team.brandId,
        action: 'team.created',
        entityType: 'team',
        entityId: team.id,
        after: team,
      });
      return team;
    });
  }

  update(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateTeamSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await this.loadManageable(tx, p, id);
      if (input.leaderId) await this.assertOrgUser(tx, input.leaderId);
      const after = await tx.team.update({ where: { id }, data: input });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: before.brandId,
        action: 'team.updated',
        entityType: 'team',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  addMember(p: OrgPrincipal, teamId: string, userId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const team = await this.loadManageable(tx, p, teamId);
      if (team.status !== 'ACTIVE') throw badRequest('TEAM_ARCHIVED', 'Team is archived');
      await this.assertOrgUser(tx, userId);
      const existing = await tx.teamMember.findFirst({ where: { teamId, userId, leftAt: null } });
      if (existing) throw conflict('ALREADY_MEMBER', 'User is already a member of this team');
      const member = await tx.teamMember.create({
        data: {
          organizationId: p.organizationId,
          teamId,
          userId,
          addedById: p.userId,
          joinedAt: this.clock.now(),
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: team.brandId,
        action: 'team.member_added',
        entityType: 'team',
        entityId: teamId,
        after: { userId },
      });
      return member;
    });
  }

  removeMember(p: OrgPrincipal, teamId: string, userId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const team = await this.loadManageable(tx, p, teamId);
      const member = await tx.teamMember.findFirst({ where: { teamId, userId, leftAt: null } });
      if (!member) throw notFound('Team member');
      await tx.teamMember.update({
        where: { id: member.id },
        data: { leftAt: this.clock.now(), removedById: p.userId },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: team.brandId,
        action: 'team.member_removed',
        entityType: 'team',
        entityId: teamId,
        before: { userId },
      });
    });
  }

  private async loadManageable(tx: Tx, p: OrgPrincipal, id: string) {
    const team = await tx.team.findUnique({ where: { id } });
    if (!team || !p.authz.can('team.read', teamTarget(team))) throw notFound('Team');
    if (!p.authz.can('team.manage', teamTarget(team))) throw forbidden();
    return team;
  }

  /** RLS guarantees the user is in this organization if found. */
  private async assertOrgUser(tx: Tx, userId: string) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!user) throw badRequest('USER_NOT_FOUND', 'User not found in this organization');
    if (user.status === 'DEACTIVATED') throw badRequest('USER_DEACTIVATED', 'User is deactivated');
  }
}
