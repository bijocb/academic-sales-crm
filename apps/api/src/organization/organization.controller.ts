import { Controller, Get, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { UpdateOrganizationSchema, z } from '@crm/contracts';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { AuditService } from '../audit/audit.service';
import { forbidden } from '../common/errors';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody } from '../common/zod';
import { Db } from '../db/db.service';

@ApiTags('organization')
@Controller('organization')
export class OrganizationController {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Basic organization profile — readable by every organization user. */
  @Get()
  get(@CurrentPrincipal() principal: Principal) {
    const p = requireOrg(principal);
    return this.db.tenant(p.organizationId, (tx) =>
      tx.organization.findUniqueOrThrow({ where: { id: p.organizationId } }),
    );
  }

  @Patch()
  @ApiZodBody(UpdateOrganizationSchema)
  update(
    @CurrentPrincipal() principal: Principal,
    @ZBody(UpdateOrganizationSchema) body: z.infer<typeof UpdateOrganizationSchema>,
  ) {
    const p = requireOrg(principal);
    if (!p.authz.can('organization.manage')) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.organization.findUniqueOrThrow({ where: { id: p.organizationId } });
      const after = await tx.organization.update({ where: { id: p.organizationId }, data: body });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        action: 'organization.updated',
        entityType: 'organization',
        entityId: p.organizationId,
        before,
        after,
      });
      return after;
    });
  }
}
