import { Injectable } from '@nestjs/common';
import {
  CreateOrganizationInput,
  DEFAULT_CURRENCY,
  DEFAULT_TIMEZONE,
  SYSTEM_ROLE_TEMPLATES,
} from '@crm/contracts';
import { Db, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AccountTokensService } from '../auth/account-tokens.service';
import { AuthService } from '../auth/auth.service';
import { badRequest, conflict, notFound } from '../common/errors';

/** Platform-admin operations. Uses Db.system(): spans organizations by definition. */
@Injectable()
export class OrganizationsAdminService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly tokens: AccountTokensService,
    private readonly auth: AuthService,
  ) {}

  list() {
    return this.db.system((tx) =>
      tx.organization.findMany({
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { brands: true, users: true } } },
      }),
    );
  }

  async create(input: CreateOrganizationInput) {
    const result = await this.db.system(async (tx) => {
      if (await tx.user.findUnique({ where: { email: input.admin.email } })) {
        throw conflict('EMAIL_IN_USE', 'A user with this email already exists');
      }
      const org = await tx.organization.create({
        data: {
          name: input.name,
          slug: input.slug,
          country: input.country,
          timezone: input.timezone ?? DEFAULT_TIMEZONE[input.country],
          currency: input.currency ?? DEFAULT_CURRENCY[input.country],
        },
      });
      const roles = await seedSystemRoles(tx, org.id);
      const admin = await tx.user.create({
        data: {
          organizationId: org.id,
          email: input.admin.email,
          name: input.admin.name,
          status: 'INVITED',
        },
      });
      await tx.roleAssignment.create({
        data: {
          organizationId: org.id,
          userId: admin.id,
          roleId: roles.ORG_ADMIN,
          scopeType: 'ORGANIZATION',
          grantReason: 'Initial organization administrator',
        },
      });
      const token = await this.tokens.issue(tx, admin, 'INVITE');
      await this.audit.record(tx, {
        organizationId: org.id,
        action: 'organization.created',
        entityType: 'organization',
        entityId: org.id,
        after: org,
      });
      return { org, admin, token };
    });
    await this.tokens.sendInvite(
      result.admin.email,
      result.admin.name,
      result.org.name,
      result.token,
    );
    return { organization: result.org, adminUserId: result.admin.id };
  }

  async setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED', reason: string) {
    if (!reason?.trim()) throw badRequest('REASON_REQUIRED', 'A reason is required');
    return this.db.system(async (tx) => {
      const before = await tx.organization.findUnique({ where: { id } });
      if (!before) throw notFound('Organization');
      const org = await tx.organization.update({ where: { id }, data: { status } });
      if (status === 'SUSPENDED') {
        const users = await tx.user.findMany({
          where: { organizationId: id },
          select: { id: true },
        });
        for (const u of users)
          await this.auth.revokeAllSessions(tx, u.id, 'organization_suspended');
      }
      await this.audit.record(tx, {
        organizationId: id,
        action: `organization.${status === 'ACTIVE' ? 'activated' : 'suspended'}`,
        entityType: 'organization',
        entityId: id,
        before: { status: before.status },
        after: { status },
        reason,
      });
      return org;
    });
  }
}

/** Creates the 10 system roles for a new organization. Returns key → role id. */
export async function seedSystemRoles(
  tx: Tx,
  organizationId: string,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [key, tpl] of Object.entries(SYSTEM_ROLE_TEMPLATES)) {
    const role = await tx.role.create({
      data: { organizationId, key, name: tpl.name, description: tpl.description, isSystem: true },
    });
    await tx.rolePermission.createMany({
      data: [...new Set(tpl.permissions)].map((permission) => ({
        organizationId,
        roleId: role.id,
        permission,
      })),
    });
    ids[key] = role.id;
  }
  return ids;
}
