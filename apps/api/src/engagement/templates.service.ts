import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TemplateSchema, UpdateTemplateSchema, z } from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { conflict, forbidden, notFound } from '../common/errors';
import { Db } from '../db/db.service';

/** WhatsApp/email templates per brand. Editing: campaign.manage or settings.manage in the brand. */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  private canManage(p: OrgPrincipal, brandId: string) {
    return (
      p.authz.can('campaign.manage', { brandId }) || p.authz.can('settings.manage', { brandId })
    );
  }

  list(p: OrgPrincipal, brandId?: string) {
    const v = p.authz.visibleBrandIds('brand.read');
    if (brandId && !v.all && !v.brandIds.includes(brandId)) throw notFound('Brand');
    return this.db.tenant(p.organizationId, (tx) =>
      tx.messageTemplate.findMany({
        where: brandId ? { brandId } : v.all ? {} : { brandId: { in: v.brandIds } },
        orderBy: [{ channel: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  create(p: OrgPrincipal, input: z.infer<typeof TemplateSchema>) {
    if (!this.canManage(p, input.brandId)) throw forbidden();
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      try {
        const t = await tx.messageTemplate.create({
          data: { ...input, organizationId: p.organizationId, createdAt: now },
        });
        await this.audit.record(tx, {
          organizationId: p.organizationId,
          brandId: t.brandId,
          action: 'template.created',
          entityType: 'message_template',
          entityId: t.id,
          after: { name: t.name, channel: t.channel },
        });
        return t;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw conflict(
            'TEMPLATE_EXISTS',
            'A template with this name and language already exists',
          );
        throw e;
      }
    });
  }

  update(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateTemplateSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const t = await tx.messageTemplate.findUnique({ where: { id } });
      if (!t) throw notFound('Template');
      if (!this.canManage(p, t.brandId)) throw forbidden();
      // Changing the text of an approved template sends it back to draft (it must be re-approved).
      const textChanged =
        (input.body !== undefined && input.body !== t.body) ||
        (input.subject !== undefined && input.subject !== t.subject);
      const status = input.status ?? (textChanged && t.status === 'APPROVED' ? 'DRAFT' : t.status);
      const updated = await tx.messageTemplate.update({
        where: { id },
        data: {
          ...input,
          status,
          ...(status === 'APPROVED' && t.status !== 'APPROVED'
            ? { approvedById: p.userId, approvedAt: now }
            : {}),
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: t.brandId,
        action: 'template.updated',
        entityType: 'message_template',
        entityId: id,
        before: { status: t.status, body: t.body },
        after: { status: updated.status, body: updated.body },
      });
      return updated;
    });
  }
}
