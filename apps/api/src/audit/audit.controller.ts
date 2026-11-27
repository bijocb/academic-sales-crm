import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { PageQuerySchema, z } from '@crm/contracts';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { pageArgs, requireOrg } from '../common/scope';
import { ZQuery } from '../common/zod';
import { Db } from '../db/db.service';

const AuditQuery = PageQuerySchema.extend({
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  action: z.string().max(100).optional(),
});

@ApiTags('audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly db: Db) {}

  /** Org-level audit.read sees everything; brand-level sees entries tagged with its brands. */
  @Get()
  @RequirePermission('audit.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZQuery(AuditQuery) q: z.infer<typeof AuditQuery>,
  ) {
    const p = requireOrg(principal);
    const vis = p.authz.visibleBrandIds('audit.read');
    const where: Prisma.AuditLogWhereInput = {
      ...(vis.all ? {} : { brandId: { in: vis.brandIds } }),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.action ? { action: q.action } : {}),
    };
    return this.db.tenant(p.organizationId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          ...pageArgs(q.page, q.pageSize),
        }),
        tx.auditLog.count({ where }),
      ]);
      return { items, total, page: q.page, pageSize: q.pageSize };
    });
  }
}
