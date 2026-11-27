import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CreateBranchInput,
  CreateBrandInput,
  DEFAULT_CURRENCY,
  DEFAULT_TIMEZONE,
  UpdateBranchSchema,
  UpdateBrandSchema,
  z,
} from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { badRequest, forbidden, notFound } from '../common/errors';
import { Db } from '../db/db.service';
import { ensureBrandDefaults } from '../settings/brand-defaults';

@Injectable()
export class BrandsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Brands the caller can see (brand.read at any level within the brand). */
  listBrands(p: OrgPrincipal) {
    const vis = p.authz.visibleBrandIds('brand.read');
    const where: Prisma.BrandWhereInput = vis.all ? {} : { id: { in: vis.brandIds } };
    return this.db.tenant(p.organizationId, (tx) =>
      tx.brand.findMany({
        where,
        orderBy: { name: 'asc' },
        include: { _count: { select: { branches: true, teams: true } } },
      }),
    );
  }

  async getBrand(p: OrgPrincipal, id: string) {
    this.assertBrandVisible(p, id);
    const brand = await this.db.tenant(p.organizationId, (tx) =>
      tx.brand.findUnique({ where: { id }, include: { branches: { orderBy: { name: 'asc' } } } }),
    );
    if (!brand) throw notFound('Brand');
    return brand;
  }

  createBrand(p: OrgPrincipal, input: CreateBrandInput) {
    // Creating a brand is an organization-level action.
    if (!p.authz.can('brand.manage')) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      const brand = await tx.brand.create({
        data: {
          organizationId: p.organizationId,
          name: input.name,
          code: input.code,
          country: input.country,
          timezone: input.timezone ?? DEFAULT_TIMEZONE[input.country],
          currency: input.currency ?? DEFAULT_CURRENCY[input.country],
        },
      });
      await ensureBrandDefaults(tx, brand);
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: brand.id,
        action: 'brand.created',
        entityType: 'brand',
        entityId: brand.id,
        after: brand,
      });
      return brand;
    });
  }

  updateBrand(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateBrandSchema>) {
    this.assertBrandVisible(p, id);
    if (!p.authz.can('brand.manage', { brandId: id })) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.brand.findUnique({ where: { id } });
      if (!before) throw notFound('Brand');
      const after = await tx.brand.update({ where: { id }, data: input });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: id,
        action: 'brand.updated',
        entityType: 'brand',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  // ------------------------------------------------------------ branches
  listBranches(p: OrgPrincipal, brandId?: string) {
    const vis = p.authz.visibleBrandIds('brand.read');
    if (brandId && !vis.all && !vis.brandIds.includes(brandId)) throw notFound('Brand');
    const where: Prisma.BranchWhereInput = {
      ...(brandId ? { brandId } : {}),
      ...(vis.all ? {} : { brandId: { in: brandId ? [brandId] : vis.brandIds } }),
    };
    return this.db.tenant(p.organizationId, (tx) =>
      tx.branch.findMany({ where, orderBy: { name: 'asc' } }),
    );
  }

  createBranch(p: OrgPrincipal, input: CreateBranchInput) {
    this.assertBrandVisible(p, input.brandId);
    if (!p.authz.can('branch.manage', { brandId: input.brandId })) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      const brand = await tx.brand.findUnique({ where: { id: input.brandId } });
      if (!brand) throw notFound('Brand');
      if (brand.status !== 'ACTIVE')
        throw badRequest('BRAND_ARCHIVED', 'Cannot add a branch to an archived brand');
      const branch = await tx.branch.create({
        data: {
          organizationId: p.organizationId,
          brandId: input.brandId,
          name: input.name,
          code: input.code,
          city: input.city,
          country: input.country,
          timezone: input.timezone ?? brand.timezone,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: brand.id,
        action: 'branch.created',
        entityType: 'branch',
        entityId: branch.id,
        after: branch,
      });
      return branch;
    });
  }

  updateBranch(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateBranchSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.branch.findUnique({ where: { id } });
      if (!before || !this.brandVisible(p, before.brandId)) throw notFound('Branch');
      if (!p.authz.can('branch.manage', { brandId: before.brandId, branchId: id }))
        throw forbidden();
      const after = await tx.branch.update({ where: { id }, data: input });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: before.brandId,
        action: 'branch.updated',
        entityType: 'branch',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  private brandVisible(p: OrgPrincipal, brandId: string): boolean {
    const vis = p.authz.visibleBrandIds('brand.read');
    return vis.all || vis.brandIds.includes(brandId);
  }

  /** Out-of-scope IDs look exactly like missing ones (no enumeration). */
  private assertBrandVisible(p: OrgPrincipal, brandId: string): void {
    if (!this.brandVisible(p, brandId)) throw notFound('Brand');
  }
}
