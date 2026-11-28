import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AdmissionSettingsSchema,
  CourseRequirementsSchema,
  DocumentTypeSchema,
  UpdateDocumentTypeSchema,
  z,
} from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { conflict, forbidden, notFound, badRequest } from '../common/errors';
import { Db } from '../db/db.service';

/** Document types, course checklists and admission numbering (settings.manage in the brand). */
@Injectable()
export class AdmissionConfigService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private assertRead(p: OrgPrincipal, brandId: string) {
    const v = p.authz.visibleBrandIds('brand.read');
    if (!v.all && !v.brandIds.includes(brandId)) throw notFound('Brand');
  }
  private assertManage(p: OrgPrincipal, brandId: string) {
    if (!p.authz.can('settings.manage', { brandId })) throw forbidden();
  }

  documentTypes(p: OrgPrincipal, brandId: string) {
    this.assertRead(p, brandId);
    return this.db.tenant(p.organizationId, (tx) =>
      tx.documentType.findMany({ where: { brandId }, orderBy: { position: 'asc' } }),
    );
  }

  createDocumentType(p: OrgPrincipal, input: z.infer<typeof DocumentTypeSchema>) {
    this.assertManage(p, input.brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const last = await tx.documentType.aggregate({
        where: { brandId: input.brandId },
        _max: { position: true },
      });
      try {
        return await tx.documentType.create({
          data: {
            organizationId: p.organizationId,
            ...input,
            position: (last._max.position ?? 0) + 1,
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw conflict('DOCUMENT_TYPE_EXISTS', 'This code is already used');
        throw e;
      }
    });
  }

  updateDocumentType(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateDocumentTypeSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const t = await tx.documentType.findUnique({ where: { id } });
      if (!t) throw notFound('Document type');
      this.assertManage(p, t.brandId);
      const updated = await tx.documentType.update({ where: { id }, data: input });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: t.brandId,
        action: 'document_type.updated',
        entityType: 'document_type',
        entityId: id,
        before: { label: t.label, requiredByDefault: t.requiredByDefault, active: t.active },
        after: input,
      });
      return updated;
    });
  }

  /** The course checklist: every active type of the brand with its effective required flag. */
  courseRequirements(p: OrgPrincipal, courseId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const course = await tx.course.findUnique({ where: { id: courseId } });
      if (!course) throw notFound('Course');
      this.assertRead(p, course.brandId);
      const [types, rows] = await Promise.all([
        tx.documentType.findMany({
          where: { brandId: course.brandId, active: true },
          orderBy: { position: 'asc' },
        }),
        tx.courseDocumentRequirement.findMany({ where: { courseId } }),
      ]);
      const o = new Map(rows.map((r) => [r.documentTypeId, r.required]));
      return types.map((t) => ({
        documentTypeId: t.id,
        code: t.code,
        label: t.label,
        required: o.get(t.id) ?? t.requiredByDefault,
        overridden: o.has(t.id),
      }));
    });
  }

  setCourseRequirements(
    p: OrgPrincipal,
    courseId: string,
    input: z.infer<typeof CourseRequirementsSchema>,
  ) {
    return this.db
      .tenant(p.organizationId, async (tx) => {
        const course = await tx.course.findUnique({ where: { id: courseId } });
        if (!course) throw notFound('Course');
        this.assertManage(p, course.brandId);
        const types = await tx.documentType.findMany({
          where: {
            id: { in: input.requirements.map((r) => r.documentTypeId) },
            brandId: course.brandId,
          },
        });
        if (types.length !== new Set(input.requirements.map((r) => r.documentTypeId)).size)
          throw badRequest(
            'INVALID_DOCUMENT_TYPE',
            'Document types must belong to the course brand',
          );
        await tx.courseDocumentRequirement.deleteMany({ where: { courseId } });
        if (input.requirements.length)
          await tx.courseDocumentRequirement.createMany({
            data: input.requirements.map((r) => ({
              organizationId: p.organizationId,
              courseId,
              ...r,
            })),
          });
        await this.audit.record(tx, {
          organizationId: p.organizationId,
          brandId: course.brandId,
          action: 'course.document_requirements_updated',
          entityType: 'course',
          entityId: courseId,
          after: { requirements: input.requirements },
        });
      })
      .then(() => this.courseRequirements(p, courseId));
  }

  settings(p: OrgPrincipal, brandId: string) {
    this.assertRead(p, brandId);
    return this.db.tenant(p.organizationId, (tx) =>
      tx.admissionSettings.findUniqueOrThrow({ where: { brandId } }),
    );
  }

  updateSettings(p: OrgPrincipal, brandId: string, input: z.infer<typeof AdmissionSettingsSchema>) {
    this.assertManage(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.admissionSettings.findUniqueOrThrow({ where: { brandId } });
      const updated = await tx.admissionSettings.update({ where: { brandId }, data: input });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId,
        action: 'admission_settings.updated',
        entityType: 'admission_settings',
        entityId: before.id,
        before: {
          numberFormat: before.numberFormat,
          requireApprovalToConfirm: before.requireApprovalToConfirm,
        },
        after: input,
      });
      return updated;
    });
  }
}
