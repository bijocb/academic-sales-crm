import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CreateRoleAssignmentInput,
  CreateUserInput,
  PageQuery,
  UpdateUserSchema,
  z,
} from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import { AccountTokensService } from '../auth/account-tokens.service';
import { AuthService } from '../auth/auth.service';
import type { ScopeSet, ScopeTarget } from '../auth/authz';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { pageArgs } from '../common/scope';
import { Db, Tx } from '../db/db.service';
import { teamScopeWhere } from '../teams/teams.service';

export const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  name: true,
  phone: true,
  status: true,
  managerId: true,
  maxActiveLeads: true,
  languages: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

/** Users visible inside a scope: holders of an active grant or team membership there. */
export function userScopeWhere(s: ScopeSet, selfId: string): Prisma.UserWhereInput {
  if (s.all) return {};
  return {
    OR: [
      { id: selfId },
      {
        roleAssignments: {
          some: {
            revokedAt: null,
            OR: [
              { brandId: { in: s.brandIds } },
              { branchId: { in: s.branchIds } },
              { teamId: { in: s.teamIds } },
              { team: { branchId: { in: s.branchIds } } },
            ],
          },
        },
      },
      { teamMemberships: { some: { leftAt: null, team: teamScopeWhere(s) } } },
    ],
  };
}

type AssignmentRow = {
  scopeType: string;
  brandId: string | null;
  branchId: string | null;
  teamId: string | null;
  team?: { branchId: string | null } | null;
};

const assignmentTarget = (a: AssignmentRow): ScopeTarget => ({
  brandId: a.brandId,
  branchId: a.scopeType === 'TEAM' ? (a.team?.branchId ?? null) : a.branchId,
  teamId: a.teamId,
});

@Injectable()
export class UsersService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly tokens: AccountTokensService,
    private readonly auth: AuthService,
  ) {}

  async list(p: OrgPrincipal, query: PageQuery & { status?: string }) {
    const where: Prisma.UserWhereInput = {
      AND: [
        userScopeWhere(p.authz.scope('user.read'), p.userId),
        query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { email: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {},
        query.status ? { status: query.status as Prisma.EnumUserStatusFilter['equals'] } : {},
      ],
    };
    return this.db.tenant(p.organizationId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.user.findMany({
          where,
          select: USER_PUBLIC_SELECT,
          orderBy: { name: 'asc' },
          ...pageArgs(query.page, query.pageSize),
        }),
        tx.user.count({ where }),
      ]);
      return { items, total, page: query.page, pageSize: query.pageSize };
    });
  }

  get(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { AND: [{ id }, userScopeWhere(p.authz.scope('user.read'), p.userId)] },
        select: {
          ...USER_PUBLIC_SELECT,
          roleAssignments: {
            where: { revokedAt: null },
            include: { role: { select: { id: true, key: true, name: true } } },
            orderBy: { grantedAt: 'asc' },
          },
          teamMemberships: {
            where: { leftAt: null },
            include: { team: { select: { id: true, name: true, brandId: true } } },
          },
        },
      });
      if (!user) throw notFound('User');
      return user;
    });
  }

  async create(p: OrgPrincipal, input: CreateUserInput) {
    const orgWide = p.authz.can('user.manage');
    if (!input.assignment && !orgWide) {
      throw badRequest(
        'ASSIGNMENT_REQUIRED',
        'Provide an initial role assignment within your scope',
      );
    }
    const result = await this.db.tenant(p.organizationId, async (tx) => {
      // Email uniqueness is global (A-013); the tenant view cannot see other orgs' users,
      // so rely on the unique index and translate the error.
      if (input.managerId) await this.assertUser(tx, input.managerId);
      let target: ScopeTarget | undefined;
      if (input.assignment) {
        target = await this.resolveTarget(tx, input.assignment);
        if (!p.authz.can('user.manage', target)) throw forbidden();
      }
      let user;
      try {
        user = await tx.user.create({
          data: {
            organizationId: p.organizationId,
            email: input.email,
            name: input.name,
            phone: input.phone,
            managerId: input.managerId,
            maxActiveLeads: input.maxActiveLeads,
            languages: input.languages ?? [],
            status: 'INVITED',
          },
          select: USER_PUBLIC_SELECT,
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw conflict('EMAIL_IN_USE', 'A user with this email already exists');
        }
        throw e;
      }
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        action: 'user.invited',
        entityType: 'user',
        entityId: user.id,
        after: user,
      });
      if (input.assignment) await this.grantInTx(tx, p, user.id, input.assignment);
      const token = await this.tokens.issue(
        tx,
        { id: user.id, organizationId: p.organizationId },
        'INVITE',
      );
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: p.organizationId },
        select: { name: true },
      });
      return { user, token, orgName: org.name };
    });
    await this.tokens.sendInvite(result.user.email, result.user.name, result.orgName, result.token);
    return result.user;
  }

  async resendInvite(p: OrgPrincipal, id: string) {
    const result = await this.db.tenant(p.organizationId, async (tx) => {
      const user = await this.loadManageable(tx, p, id);
      if (user.status !== 'INVITED')
        throw badRequest('NOT_INVITED', 'User has already accepted the invitation');
      const token = await this.tokens.issue(tx, { id, organizationId: p.organizationId }, 'INVITE');
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: p.organizationId },
        select: { name: true },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        action: 'user.invite_resent',
        entityType: 'user',
        entityId: id,
      });
      return { user, token, orgName: org.name };
    });
    await this.tokens.sendInvite(result.user.email, result.user.name, result.orgName, result.token);
  }

  update(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateUserSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await this.loadManageable(tx, p, id);
      if (input.managerId) {
        if (input.managerId === id)
          throw badRequest('INVALID_MANAGER', 'A user cannot manage themselves');
        await this.assertUser(tx, input.managerId);
      }
      const after = await tx.user.update({
        where: { id },
        data: input,
        select: USER_PUBLIC_SELECT,
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        action: 'user.updated',
        entityType: 'user',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  setStatus(
    p: OrgPrincipal,
    id: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED',
    reason: string,
  ) {
    if (id === p.userId)
      throw badRequest('CANNOT_CHANGE_OWN_STATUS', 'You cannot change your own status');
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await this.loadManageable(tx, p, id);
      if (before.status === status) return before;
      if (status === 'ACTIVE' && before.status === 'INVITED') {
        throw badRequest('INVITE_PENDING', 'The user must accept the invitation first');
      }
      if (status !== 'ACTIVE') await this.assertNotLastOrgAdmin(tx, { userId: id });
      const after = await tx.user.update({
        where: { id },
        data: { status },
        select: USER_PUBLIC_SELECT,
      });
      if (status !== 'ACTIVE')
        await this.auth.revokeAllSessions(tx, id, `user_${status.toLowerCase()}`);
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        action: `user.${status.toLowerCase()}`,
        entityType: 'user',
        entityId: id,
        before: { status: before.status },
        after: { status },
        reason,
      });
      return after;
    });
  }

  // ------------------------------------------------------ role assignments
  listAssignments(p: OrgPrincipal, userId: string, includeRevoked: boolean) {
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.loadVisible(tx, p, userId);
      return tx.roleAssignment.findMany({
        where: { userId, ...(includeRevoked ? {} : { revokedAt: null }) },
        include: { role: { select: { id: true, key: true, name: true } } },
        orderBy: { grantedAt: 'desc' },
      });
    });
  }

  grant(p: OrgPrincipal, userId: string, input: CreateRoleAssignmentInput) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, status: true },
      });
      if (!user) throw notFound('User');
      if (user.status === 'DEACTIVATED')
        throw badRequest('USER_DEACTIVATED', 'User is deactivated');
      return this.grantInTx(tx, p, userId, input);
    });
  }

  revoke(p: OrgPrincipal, assignmentId: string, reason: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await tx.roleAssignment.findUnique({
        where: { id: assignmentId },
        include: { team: { select: { branchId: true } } },
      });
      if (!a || a.revokedAt) throw notFound('Role assignment');
      if (!p.authz.can('role.assign', assignmentTarget(a))) throw notFound('Role assignment');
      await this.assertNotLastOrgAdmin(tx, { assignmentId });
      const revoked = await tx.roleAssignment.update({
        where: { id: assignmentId },
        data: { revokedAt: this.clock.now(), revokedById: p.userId, revokeReason: reason },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: a.brandId,
        action: 'role.revoked',
        entityType: 'role_assignment',
        entityId: a.id,
        before: a,
        reason,
      });
      return revoked;
    });
  }

  // ---------------------------------------------------------------- helpers
  private async grantInTx(
    tx: Tx,
    p: OrgPrincipal,
    userId: string,
    input: CreateRoleAssignmentInput,
  ) {
    const role = await tx.role.findUnique({
      where: { id: input.roleId },
      include: { permissions: true },
    });
    if (!role) throw badRequest('ROLE_NOT_FOUND', 'Role not found');
    const target = await this.resolveTarget(tx, input);
    // Anti-escalation: you can only hand out what you hold at that scope.
    if (
      !p.authz.canGrant(
        role.permissions.map((rp) => rp.permission),
        target,
      )
    ) {
      throw forbidden('You can only grant roles whose permissions you hold at that scope');
    }
    const existing = await tx.roleAssignment.findFirst({
      where: {
        userId,
        roleId: role.id,
        scopeType: input.scopeType,
        brandId: target.brandId ?? null,
        branchId: input.scopeType === 'BRANCH' ? (target.branchId ?? null) : null,
        teamId: target.teamId ?? null,
        revokedAt: null,
      },
    });
    if (existing) throw conflict('ALREADY_ASSIGNED', 'This role is already assigned at this scope');
    const a = await tx.roleAssignment.create({
      data: {
        organizationId: p.organizationId,
        userId,
        roleId: role.id,
        scopeType: input.scopeType,
        brandId: target.brandId ?? null,
        branchId: input.scopeType === 'BRANCH' ? (target.branchId ?? null) : null,
        teamId: target.teamId ?? null,
        grantedById: p.userId,
        grantReason: input.reason,
        grantedAt: this.clock.now(),
      },
    });
    await this.audit.record(tx, {
      organizationId: p.organizationId,
      brandId: a.brandId,
      action: 'role.granted',
      entityType: 'role_assignment',
      entityId: a.id,
      after: { ...a, roleKey: role.key },
    });
    return a;
  }

  /** Validates scope ids exist in this organization (RLS) and derives the full target. */
  private async resolveTarget(tx: Tx, input: CreateRoleAssignmentInput): Promise<ScopeTarget> {
    switch (input.scopeType) {
      case 'ORGANIZATION':
        return {};
      case 'BRAND': {
        const brand = await tx.brand.findUnique({ where: { id: input.brandId! } });
        if (!brand) throw badRequest('BRAND_NOT_FOUND', 'Brand not found');
        return { brandId: brand.id };
      }
      case 'BRANCH': {
        const branch = await tx.branch.findUnique({ where: { id: input.branchId! } });
        if (!branch) throw badRequest('BRANCH_NOT_FOUND', 'Branch not found');
        return { brandId: branch.brandId, branchId: branch.id };
      }
      case 'TEAM': {
        const team = await tx.team.findUnique({ where: { id: input.teamId! } });
        if (!team) throw badRequest('TEAM_NOT_FOUND', 'Team not found');
        return { brandId: team.brandId, branchId: team.branchId, teamId: team.id };
      }
    }
  }

  private async loadVisible(tx: Tx, p: OrgPrincipal, id: string) {
    const user = await tx.user.findFirst({
      where: { AND: [{ id }, userScopeWhere(p.authz.scope('user.read'), p.userId)] },
      select: USER_PUBLIC_SELECT,
    });
    if (!user) throw notFound('User');
    return user;
  }

  /**
   * A user may be managed only if the actor holds user.manage over EVERY active grant of the
   * target — so a brand manager cannot touch an org admin or someone from another brand.
   */
  private async loadManageable(tx: Tx, p: OrgPrincipal, id: string) {
    const user = await this.loadVisible(tx, p, id);
    if (p.authz.can('user.manage')) return user;
    const grants = await tx.roleAssignment.findMany({
      where: { userId: id, revokedAt: null },
      include: { team: { select: { branchId: true } } },
    });
    const memberships = await tx.teamMember.findMany({
      where: { userId: id, leftAt: null },
      include: { team: true },
    });
    const targets = [
      ...grants.map(assignmentTarget),
      ...memberships.map((m) => ({
        brandId: m.team.brandId,
        branchId: m.team.branchId,
        teamId: m.team.id,
      })),
    ];
    if (targets.length === 0 || !targets.every((t) => p.authz.can('user.manage', t)))
      throw forbidden();
    return user;
  }

  private async assertUser(tx: Tx, id: string) {
    const u = await tx.user.findUnique({ where: { id }, select: { id: true } });
    if (!u) throw badRequest('USER_NOT_FOUND', 'User not found in this organization');
  }

  /** The organization must always keep at least one active Organization Admin. */
  private async assertNotLastOrgAdmin(tx: Tx, change: { userId?: string; assignmentId?: string }) {
    const admins = await tx.roleAssignment.findMany({
      where: {
        revokedAt: null,
        scopeType: 'ORGANIZATION',
        role: { key: 'ORG_ADMIN', isSystem: true },
        user: { status: 'ACTIVE' },
      },
      select: { id: true, userId: true },
    });
    const remaining = admins.filter(
      (a) => a.id !== change.assignmentId && a.userId !== change.userId,
    );
    const affected = admins.length !== remaining.length;
    if (affected && new Set(remaining.map((a) => a.userId)).size === 0) {
      throw badRequest(
        'LAST_ORG_ADMIN',
        'The organization must keep at least one active Organization Admin',
      );
    }
  }
}
