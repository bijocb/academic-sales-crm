import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CreateBatchInput,
  CreateCourseCategorySchema,
  CreateCourseInput,
  UpdateBatchSchema,
  UpdateCourseCategorySchema,
  UpdateCourseSchema,
  z,
} from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { badRequest, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';

const toDate = (d: string) => new Date(`${d}T00:00:00.000Z`);

@Injectable()
export class CatalogService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------- helpers
  private readable(p: OrgPrincipal, brandId?: string): Prisma.CourseWhereInput {
    const vis = p.authz.visibleBrandIds('course.read');
    if (brandId) {
      if (!vis.all && !vis.brandIds.includes(brandId)) throw notFound('Brand');
      return { brandId };
    }
    return vis.all ? {} : { brandId: { in: vis.brandIds } };
  }

  private canRead(p: OrgPrincipal, brandId: string): boolean {
    const vis = p.authz.visibleBrandIds('course.read');
    return vis.all || vis.brandIds.includes(brandId);
  }

  private assertManage(p: OrgPrincipal, brandId: string, branchId?: string | null): void {
    if (!this.canRead(p, brandId)) throw notFound('Brand');
    if (!p.authz.can('course.manage', { brandId, branchId: branchId ?? null })) throw forbidden();
  }

  private async brandOf(tx: Tx, brandId: string) {
    const brand = await tx.brand.findUnique({ where: { id: brandId } });
    if (!brand) throw notFound('Brand');
    if (brand.status !== 'ACTIVE') throw badRequest('BRAND_ARCHIVED', 'Brand is archived');
    return brand;
  }

  // ---------------------------------------------------------- categories
  listCategories(p: OrgPrincipal, brandId?: string) {
    const where = this.readable(p, brandId) as Prisma.CourseCategoryWhereInput;
    return this.db.tenant(p.organizationId, (tx) =>
      tx.courseCategory.findMany({
        where,
        orderBy: { name: 'asc' },
        include: { _count: { select: { courses: true } } },
      }),
    );
  }

  createCategory(p: OrgPrincipal, input: z.infer<typeof CreateCourseCategorySchema>) {
    this.assertManage(p, input.brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.brandOf(tx, input.brandId);
      const c = await tx.courseCategory.create({
        data: { organizationId: p.organizationId, ...input },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: c.brandId,
        action: 'course_category.created',
        entityType: 'course_category',
        entityId: c.id,
        after: c,
      });
      return c;
    });
  }

  updateCategory(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateCourseCategorySchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.courseCategory.findUnique({ where: { id } });
      if (!before || !this.canRead(p, before.brandId)) throw notFound('Course category');
      this.assertManage(p, before.brandId);
      const after = await tx.courseCategory.update({ where: { id }, data: input });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: before.brandId,
        action: 'course_category.updated',
        entityType: 'course_category',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  // ------------------------------------------------------------- courses
  async listCourses(
    p: OrgPrincipal,
    q: { brandId?: string; status?: 'ACTIVE' | 'ARCHIVED'; q?: string },
  ) {
    const where: Prisma.CourseWhereInput = {
      AND: [
        this.readable(p, q.brandId),
        q.status ? { status: q.status } : {},
        q.q
          ? {
              OR: [
                { name: { contains: q.q, mode: 'insensitive' } },
                { code: { contains: q.q, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };
    return this.db.tenant(p.organizationId, (tx) =>
      tx.course.findMany({
        where,
        orderBy: { name: 'asc' },
        include: {
          category: { select: { id: true, name: true } },
          _count: { select: { batches: true } },
        },
      }),
    );
  }

  getCourse(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const c = await tx.course.findUnique({
        where: { id },
        include: { category: true, batches: { orderBy: { startDate: 'asc' } } },
      });
      if (!c || !this.canRead(p, c.brandId)) throw notFound('Course');
      return c;
    });
  }

  createCourse(p: OrgPrincipal, input: CreateCourseInput) {
    this.assertManage(p, input.brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const brand = await this.brandOf(tx, input.brandId);
      if (input.categoryId) await this.assertCategory(tx, input.categoryId, brand.id);
      const course = await tx.course.create({
        data: {
          organizationId: p.organizationId,
          brandId: brand.id,
          categoryId: input.categoryId ?? null,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          eligibility: input.eligibility ?? null,
          deliveryMode: input.deliveryMode,
          durationValue: input.durationValue ?? null,
          durationUnit: input.durationUnit ?? null,
          listFeeMinor: input.listFeeMinor == null ? null : BigInt(input.listFeeMinor),
          currency: brand.currency, // fees are always in the brand currency
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: brand.id,
        action: 'course.created',
        entityType: 'course',
        entityId: course.id,
        after: course,
      });
      return course;
    });
  }

  updateCourse(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateCourseSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.course.findUnique({ where: { id } });
      if (!before || !this.canRead(p, before.brandId)) throw notFound('Course');
      this.assertManage(p, before.brandId);
      if (input.categoryId) await this.assertCategory(tx, input.categoryId, before.brandId);
      const merged = {
        durationValue: before.durationValue,
        durationUnit: before.durationUnit,
        ...input,
      };
      if ((merged.durationValue == null) !== (merged.durationUnit == null)) {
        throw badRequest('INVALID_DURATION', 'Provide both duration value and unit, or neither');
      }
      const { listFeeMinor, ...rest } = input;
      const after = await tx.course.update({
        where: { id },
        data: {
          ...rest,
          ...(listFeeMinor !== undefined
            ? { listFeeMinor: listFeeMinor == null ? null : BigInt(listFeeMinor) }
            : {}),
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: before.brandId,
        action: 'course.updated',
        entityType: 'course',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  private async assertCategory(tx: Tx, categoryId: string, brandId: string) {
    const cat = await tx.courseCategory.findUnique({ where: { id: categoryId } });
    if (!cat || cat.brandId !== brandId)
      throw badRequest('CATEGORY_NOT_IN_BRAND', 'Category does not belong to this brand');
  }

  // ------------------------------------------------------------- batches
  listBatches(p: OrgPrincipal, q: { brandId?: string; courseId?: string; status?: string }) {
    const where: Prisma.BatchWhereInput = {
      AND: [
        this.readable(p, q.brandId) as Prisma.BatchWhereInput,
        q.courseId ? { courseId: q.courseId } : {},
        q.status ? { status: q.status as Prisma.EnumBatchStatusFilter['equals'] } : {},
      ],
    };
    return this.db.tenant(p.organizationId, (tx) =>
      tx.batch.findMany({
        where,
        orderBy: [{ startDate: 'asc' }, { code: 'asc' }],
        include: {
          course: { select: { id: true, name: true, code: true } },
          branch: { select: { id: true, name: true } },
        },
      }),
    );
  }

  getBatch(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const b = await tx.batch.findUnique({
        where: { id },
        include: { course: true, branch: true },
      });
      if (!b || !this.canRead(p, b.brandId)) throw notFound('Batch');
      return b;
    });
  }

  createBatch(p: OrgPrincipal, input: CreateBatchInput) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const course = await tx.course.findUnique({ where: { id: input.courseId } });
      if (!course || !this.canRead(p, course.brandId)) throw notFound('Course');
      this.assertManage(p, course.brandId, input.branchId);
      if (course.status !== 'ACTIVE') throw badRequest('COURSE_ARCHIVED', 'Course is archived');
      if (input.branchId) await this.assertBranch(tx, input.branchId, course.brandId);
      const batch = await tx.batch.create({
        data: {
          organizationId: p.organizationId,
          brandId: course.brandId,
          courseId: course.id,
          branchId: input.branchId ?? null,
          code: input.code,
          name: input.name,
          startDate: toDate(input.startDate),
          endDate: input.endDate ? toDate(input.endDate) : null,
          capacity: input.capacity,
          schedule: input.schedule ?? null,
          status: input.status ?? 'PLANNED',
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: course.brandId,
        action: 'batch.created',
        entityType: 'batch',
        entityId: batch.id,
        after: batch,
      });
      return batch;
    });
  }

  updateBatch(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateBatchSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.batch.findUnique({ where: { id } });
      if (!before || !this.canRead(p, before.brandId)) throw notFound('Batch');
      this.assertManage(p, before.brandId, input.branchId ?? before.branchId);
      if (input.branchId) await this.assertBranch(tx, input.branchId, before.brandId);
      const start = input.startDate ? toDate(input.startDate) : before.startDate;
      const end =
        input.endDate === undefined ? before.endDate : input.endDate ? toDate(input.endDate) : null;
      if (end && end < start)
        throw badRequest('INVALID_DATES', 'End date must be on or after the start date');
      // Phase 11: capacity may not drop below confirmed enrolments.
      const after = await tx.batch.update({
        where: { id },
        data: {
          ...input,
          startDate: input.startDate ? start : undefined,
          endDate: input.endDate === undefined ? undefined : end,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: before.brandId,
        action: 'batch.updated',
        entityType: 'batch',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  private async assertBranch(tx: Tx, branchId: string, brandId: string) {
    const br = await tx.branch.findUnique({ where: { id: branchId } });
    if (!br || br.brandId !== brandId)
      throw badRequest('BRANCH_NOT_IN_BRAND', 'Branch does not belong to this brand');
  }
}
