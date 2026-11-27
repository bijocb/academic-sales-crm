import { Injectable } from '@nestjs/common';
import {
  CreateCampaignSchema,
  CreateIntakeKeySchema,
  CreateLeadSourceSchema,
  Permission,
  UpdateCampaignSchema,
  UpdateLeadSourceSchema,
  z,
} from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { randomToken, sha256 } from '../auth/crypto';
import { Clock } from '../common/clock';
import { badRequest, forbidden, notFound } from '../common/errors';
import { Db } from '../db/db.service';

const READERS: Permission[] = [
  'lead.read',
  'lead.read_own',
  'lead.create',
  'lead.import',
  'campaign.manage',
  'integration.manage',
];
const toDate = (d?: string | null) =>
  d ? new Date(`${d}T00:00:00.000Z`) : d === null ? null : undefined;

/** Lead sources, campaigns and intake keys (brand-scoped configuration). */
@Injectable()
export class LeadConfigService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private visibleBrands(p: OrgPrincipal): { all: boolean; brandIds: string[] } {
    const ids = new Set<string>();
    for (const perm of READERS) {
      const v = p.authz.visibleBrandIds(perm);
      if (v.all) return { all: true, brandIds: [] };
      v.brandIds.forEach((b) => ids.add(b));
    }
    return { all: false, brandIds: [...ids] };
  }

  private assertVisible(p: OrgPrincipal, brandId: string) {
    const v = this.visibleBrands(p);
    if (!v.all && !v.brandIds.includes(brandId)) throw notFound('Brand');
  }

  private assertCan(p: OrgPrincipal, perm: Permission, brandId: string) {
    this.assertVisible(p, brandId);
    if (!p.authz.can(perm, { brandId })) throw forbidden();
  }

  private brandFilter(p: OrgPrincipal, brandId?: string) {
    if (brandId) {
      this.assertVisible(p, brandId);
      return { brandId };
    }
    const v = this.visibleBrands(p);
    return v.all ? {} : { brandId: { in: v.brandIds } };
  }

  // ------------------------------------------------------------- sources
  listSources(p: OrgPrincipal, brandId?: string) {
    return this.db.tenant(p.organizationId, (tx) =>
      tx.leadSource.findMany({
        where: this.brandFilter(p, brandId),
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  createSource(p: OrgPrincipal, input: z.infer<typeof CreateLeadSourceSchema>) {
    this.assertCan(p, 'campaign.manage', input.brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const s = await tx.leadSource.create({
        data: { organizationId: p.organizationId, ...input },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: s.brandId,
        action: 'lead_source.created',
        entityType: 'lead_source',
        entityId: s.id,
        after: s,
      });
      return s;
    });
  }

  updateSource(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateLeadSourceSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.leadSource.findUnique({ where: { id } });
      if (!before) throw notFound('Lead source');
      this.assertCan(p, 'campaign.manage', before.brandId);
      const after = await tx.leadSource.update({ where: { id }, data: input });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: before.brandId,
        action: 'lead_source.updated',
        entityType: 'lead_source',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  // ----------------------------------------------------------- campaigns
  listCampaigns(p: OrgPrincipal, brandId?: string) {
    return this.db.tenant(p.organizationId, (tx) =>
      tx.campaign.findMany({
        where: this.brandFilter(p, brandId),
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
        include: { source: { select: { id: true, name: true } } },
      }),
    );
  }

  createCampaign(p: OrgPrincipal, input: z.infer<typeof CreateCampaignSchema>) {
    this.assertCan(p, 'campaign.manage', input.brandId);
    if (input.startDate && input.endDate && input.endDate < input.startDate)
      throw badRequest('INVALID_DATES', 'End date must be on or after the start date');
    return this.db.tenant(p.organizationId, async (tx) => {
      if (input.sourceId) {
        const s = await tx.leadSource.findUnique({ where: { id: input.sourceId } });
        if (!s || s.brandId !== input.brandId)
          throw badRequest('SOURCE_NOT_IN_BRAND', 'Source does not belong to this brand');
      }
      const c = await tx.campaign.create({
        data: {
          organizationId: p.organizationId,
          ...input,
          startDate: toDate(input.startDate),
          endDate: toDate(input.endDate),
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: c.brandId,
        action: 'campaign.created',
        entityType: 'campaign',
        entityId: c.id,
        after: c,
      });
      return c;
    });
  }

  updateCampaign(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateCampaignSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.campaign.findUnique({ where: { id } });
      if (!before) throw notFound('Campaign');
      this.assertCan(p, 'campaign.manage', before.brandId);
      const after = await tx.campaign.update({ where: { id }, data: input });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: before.brandId,
        action: 'campaign.updated',
        entityType: 'campaign',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  // --------------------------------------------------------- intake keys
  listKeys(p: OrgPrincipal, brandId?: string) {
    return this.db.tenant(p.organizationId, (tx) =>
      tx.intakeKey.findMany({
        where: this.brandFilter(p, brandId),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          brandId: true,
          sourceId: true,
          name: true,
          keyPrefix: true,
          createdAt: true,
          lastUsedAt: true,
          revokedAt: true,
          source: { select: { name: true, channel: true } },
        },
      }),
    );
  }

  /** Returns the plaintext key exactly once. */
  createKey(p: OrgPrincipal, input: z.infer<typeof CreateIntakeKeySchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const source = await tx.leadSource.findUnique({ where: { id: input.sourceId } });
      if (!source) throw notFound('Lead source');
      this.assertCan(p, 'integration.manage', source.brandId);
      const key = `crmk_${randomToken(24)}`;
      const row = await tx.intakeKey.create({
        data: {
          organizationId: p.organizationId,
          brandId: source.brandId,
          sourceId: source.id,
          name: input.name,
          keyPrefix: key.slice(0, 12),
          keyHash: sha256(key),
          createdById: p.userId,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: source.brandId,
        action: 'intake_key.created',
        entityType: 'intake_key',
        entityId: row.id,
        after: { name: row.name, sourceId: source.id, keyPrefix: row.keyPrefix },
      });
      return { id: row.id, name: row.name, keyPrefix: row.keyPrefix, key };
    });
  }

  revokeKey(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const k = await tx.intakeKey.findUnique({ where: { id } });
      if (!k) throw notFound('Intake key');
      this.assertCan(p, 'integration.manage', k.brandId);
      if (k.revokedAt) return;
      await tx.intakeKey.update({ where: { id }, data: { revokedAt: this.clock.now() } });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: k.brandId,
        action: 'intake_key.revoked',
        entityType: 'intake_key',
        entityId: id,
      });
    });
  }
}
