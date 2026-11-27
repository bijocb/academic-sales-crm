import { Injectable } from '@nestjs/common';
import { CreateRoleInput, Permission, UpdateRoleSchema, z } from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { badRequest, forbidden, notFound } from '../common/errors';
import { Db } from '../db/db.service';

@Injectable()
export class RolesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  list(p: OrgPrincipal) {
    if (!p.authz.has('role.read') && !p.authz.has('role.assign')) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      const roles = await tx.role.findMany({
        include: { permissions: true },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      });
      return roles.map(({ permissions, ...r }) => ({
        ...r,
        permissions: permissions.map((x) => x.permission).sort(),
      }));
    });
  }

  create(p: OrgPrincipal, input: CreateRoleInput) {
    this.assertCanDefine(p, input.permissions);
    return this.db.tenant(p.organizationId, async (tx) => {
      const role = await tx.role.create({
        data: {
          organizationId: p.organizationId,
          key: input.key,
          name: input.name,
          description: input.description,
        },
      });
      await tx.rolePermission.createMany({
        data: [...new Set(input.permissions)].map((permission) => ({
          organizationId: p.organizationId,
          roleId: role.id,
          permission,
        })),
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        action: 'role.created',
        entityType: 'role',
        entityId: role.id,
        after: { ...role, permissions: input.permissions },
      });
      return { ...role, permissions: [...new Set(input.permissions)].sort() };
    });
  }

  update(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateRoleSchema>) {
    if (input.permissions) this.assertCanDefine(p, input.permissions);
    else if (!p.authz.can('role.manage')) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.role.findUnique({ where: { id }, include: { permissions: true } });
      if (!before) throw notFound('Role');
      if (before.isSystem)
        throw badRequest(
          'SYSTEM_ROLE',
          'System roles cannot be edited; create a custom role instead',
        );
      const { permissions, ...fields } = input;
      const role = await tx.role.update({ where: { id }, data: fields });
      if (permissions) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({
          data: [...new Set(permissions)].map((permission) => ({
            organizationId: p.organizationId,
            roleId: id,
            permission,
          })),
        });
      }
      const after = {
        ...role,
        permissions: permissions ?? before.permissions.map((x) => x.permission),
      };
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        action: 'role.updated',
        entityType: 'role',
        entityId: id,
        before: { ...before, permissions: before.permissions.map((x) => x.permission) },
        after,
      });
      return after;
    });
  }

  /** Custom roles are organization-wide; you cannot define a role stronger than yourself. */
  private assertCanDefine(p: OrgPrincipal, permissions: string[]) {
    if (!p.authz.can('role.manage')) throw forbidden();
    const missing = permissions.filter((perm) => !p.authz.holdsOrMayConfer(perm as Permission));
    if (missing.length)
      throw forbidden(`You cannot grant permissions you do not hold: ${missing.join(', ')}`);
  }
}
