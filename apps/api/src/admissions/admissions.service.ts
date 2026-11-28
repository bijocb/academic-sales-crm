import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Admission, AdmissionStatus } from '@prisma/client';
import {
  AdmissionListQuerySchema,
  AdmissionReasonSchema,
  ApproveAdmissionSchema,
  ChangeBatchSchema,
  DeferAdmissionSchema,
  DOCUMENT_CONTENT_TYPES,
  formatAdmissionNumber,
  MAX_DOCUMENT_BYTES,
  RejectDocumentSchema,
  StartAdmissionSchema,
  StudentProfileSchema,
  z,
} from '@crm/contracts';
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { AppError, badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { JobRow, JobsService } from '../jobs/jobs.service';
import { maskPhone } from '../leads/normalize';
import { LeadsService } from '../leads/leads.service';
import { changeLeadStatus } from '../leads/status-history';
import { SlaClockService } from '../work/sla-clock.service';
import { DocumentStorage, sniffContentType } from './document-storage';
import { DownloadLinks } from './download-links';
import { LmsHandoverPayload, LmsRegistry } from './lms';

/** Statuses in which the document phase decides the status automatically. */
const DOC_PHASE: AdmissionStatus[] = ['DRAFT', 'DOCUMENTS_PENDING', 'UNDER_VERIFICATION'];
const CONFIRMABLE: AdmissionStatus[] = [
  'DRAFT',
  'DOCUMENTS_PENDING',
  'UNDER_VERIFICATION',
  'APPROVED',
];
const SEAT_ROLES: AdmissionStatus[] = ['APPROVED', 'CONFIRMED'];

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Student profile, document checklist, admission workflow and seats (FR-013, FR-014). See PHASE-11.md. */
@Injectable()
export class AdmissionsService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
    private readonly storage: DocumentStorage,
    private readonly links: DownloadLinks,
    private readonly jobs: JobsService,
    private readonly lms: LmsRegistry,
    private readonly sla: SlaClockService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('lms.handover', (j) => this.sendHandover(j));
  }

  // -------------------------------------------------------------- access
  private inBrand(
    p: OrgPrincipal,
    perm: 'admission.manage' | 'document.view' | 'pipeline.transition' | 'course.manage',
    brandId: string,
  ) {
    const v = p.authz.visibleBrandIds(perm);
    return v.all || v.brandIds.includes(brandId);
  }
  private canManage(p: OrgPrincipal, brandId: string) {
    return this.inBrand(p, 'admission.manage', brandId);
  }
  /** Sales can start admissions and upload documents; admission officers manage them. */
  private canWork(p: OrgPrincipal, brandId: string) {
    return (
      this.canManage(p, brandId) ||
      (this.leads.canEdit(p, brandId) && this.inBrand(p, 'pipeline.transition', brandId))
    );
  }

  /** 404 unless the caller may see the admission's lead. */
  private async visible(tx: Tx, p: OrgPrincipal, id: string) {
    const a = await tx.admission.findUnique({ where: { id } });
    if (!a) throw notFound('Admission');
    await this.leads.visibleLead(tx, p, a.leadId);
    return a;
  }

  // ----------------------------------------------------------- status core
  private async setStatus(
    tx: Tx,
    a: Admission,
    to: AdmissionStatus,
    reason: string | null,
    actorUserId: string | null,
    now: Date,
    extra: Prisma.AdmissionUpdateInput = {},
  ) {
    const updated = await tx.admission.update({
      where: { id: a.id },
      data: { status: to, ...extra },
    });
    if (a.status !== to) {
      await tx.admissionStatusHistory.create({
        data: {
          organizationId: a.organizationId,
          admissionId: a.id,
          fromStatus: a.status,
          toStatus: to,
          reason,
          actorUserId,
          occurredAt: now,
        },
      });
      await tx.leadEvent.create({
        data: {
          organizationId: a.organizationId,
          leadId: a.leadId,
          type: 'ADMISSION_STATUS',
          actorUserId,
          body: `Admission ${to.replace(/_/g, ' ').toLowerCase()}${reason ? ` — ${reason}` : ''}`,
          data: { admissionId: a.id, from: a.status, to },
          occurredAt: now,
        },
      });
      await this.audit.record(tx, {
        organizationId: a.organizationId,
        brandId: a.brandId,
        actorUserId,
        action: `admission.${to.toLowerCase()}`,
        entityType: 'admission',
        entityId: a.id,
        before: { status: a.status },
        after: { status: to },
        reason: reason ?? undefined,
      });
    }
    return updated;
  }

  /** Document phase: any required document missing/rejected → DOCUMENTS_PENDING, otherwise UNDER_VERIFICATION. */
  private async recompute(tx: Tx, a: Admission, actorUserId: string | null, now: Date) {
    if (!DOC_PHASE.includes(a.status)) return a;
    const docs = await tx.admissionDocument.findMany({
      where: { admissionId: a.id, required: true },
    });
    const pending = docs.some((d) => d.status === 'MISSING' || d.status === 'REJECTED');
    return this.setStatus(
      tx,
      a,
      pending ? 'DOCUMENTS_PENDING' : 'UNDER_VERIFICATION',
      null,
      actorUserId,
      now,
    );
  }

  // ---------------------------------------------------------------- seats
  private async seatsUsed(tx: Tx, batchId: string, exceptAdmissionId?: string) {
    return tx.admission.count({
      where: {
        batchId,
        holdsSeat: true,
        status: { in: SEAT_ROLES },
        ...(exceptAdmissionId ? { id: { not: exceptAdmissionId } } : {}),
      },
    });
  }

  /** FR-013: no seat beyond capacity unless an authorised override is recorded. */
  private async takeSeat(
    tx: Tx,
    p: OrgPrincipal | null,
    a: Admission,
    batchId: string,
    overrideReason?: string,
  ) {
    await tx.$queryRaw`SELECT id FROM batches WHERE id = ${batchId}::uuid FOR UPDATE`;
    const batch = await tx.batch.findUniqueOrThrow({ where: { id: batchId } });
    const used = await this.seatsUsed(tx, batchId, a.id);
    if (used < batch.capacity) return { seatOverride: false, seatOverrideReason: null };
    if (!overrideReason)
      throw conflict('BATCH_FULL', `${batch.name} is full (${used}/${batch.capacity} seats)`);
    if (!p || !this.inBrand(p, 'course.manage', a.brandId))
      throw forbidden('Only a course manager can book beyond batch capacity');
    return { seatOverride: true, seatOverrideReason: overrideReason };
  }

  seatInfo(p: OrgPrincipal, batchId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const batch = await tx.batch.findUnique({ where: { id: batchId } });
      if (!batch || !p.authz.can('course.read', { brandId: batch.brandId }))
        throw notFound('Batch');
      const used = await this.seatsUsed(tx, batchId);
      return {
        batchId,
        capacity: batch.capacity,
        used,
        available: Math.max(0, batch.capacity - used),
      };
    });
  }

  // ------------------------------------------------------------ start
  start(p: OrgPrincipal, leadId: string, input: z.infer<typeof StartAdmissionSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM leads WHERE id = ${leadId}::uuid FOR UPDATE`;
      const lead = await this.leads.visibleLead(tx, p, leadId);
      if (!this.canWork(p, lead.brandId)) throw forbidden();
      if (lead.status !== 'OPEN')
        throw badRequest('LEAD_NOT_OPEN', 'Admissions start from open leads');
      if (await tx.admission.findFirst({ where: { leadId, status: { not: 'CANCELLED' } } }))
        throw conflict('ADMISSION_EXISTS', 'This lead already has an admission');

      const quotation = input.quotationId
        ? await tx.quotation.findFirst({ where: { id: input.quotationId, leadId } })
        : await tx.quotation.findFirst({
            where: { leadId, status: 'ACCEPTED' },
            orderBy: { decidedAt: 'desc' },
          });
      if (input.quotationId && !quotation) throw notFound('Quotation');
      const courseId = input.courseId ?? quotation?.courseId;
      const batchId = input.batchId ?? quotation?.batchId ?? null;
      if (!courseId)
        throw badRequest('COURSE_REQUIRED', 'Choose the course (or accept a quotation first)');
      const course = await tx.course.findFirst({ where: { id: courseId, brandId: lead.brandId } });
      if (!course) throw badRequest('INVALID_COURSE', 'The course must belong to this brand');
      if (batchId) {
        const b = await tx.batch.findFirst({
          where: { id: batchId, courseId, status: { in: ['PLANNED', 'OPEN'] } },
        });
        if (!b) throw badRequest('INVALID_BATCH', 'Choose a planned or open batch of this course');
      }

      const student =
        (await tx.student.findUnique({
          where: {
            organizationId_personId: {
              organizationId: lead.organizationId,
              personId: lead.personId,
            },
          },
        })) ??
        (await tx.student.create({
          data: {
            organizationId: lead.organizationId,
            personId: lead.personId,
            legalName: input.legalName ?? lead.person.fullName,
            city: lead.person.city,
            createdAt: now,
          },
        }));
      let a = await tx.admission.create({
        data: {
          organizationId: lead.organizationId,
          brandId: lead.brandId,
          leadId,
          studentId: student.id,
          courseId,
          batchId,
          quotationId: quotation?.id ?? null,
          createdById: p.userId,
          createdAt: now,
        },
      });
      const [types, overrides] = await Promise.all([
        tx.documentType.findMany({
          where: { brandId: lead.brandId, active: true },
          orderBy: { position: 'asc' },
        }),
        tx.courseDocumentRequirement.findMany({ where: { courseId } }),
      ]);
      const required = new Map(overrides.map((o) => [o.documentTypeId, o.required]));
      if (types.length)
        await tx.admissionDocument.createMany({
          data: types.map((t) => ({
            organizationId: lead.organizationId,
            admissionId: a.id,
            documentTypeId: t.id,
            required: required.get(t.id) ?? t.requiredByDefault,
          })),
        });
      await tx.admissionStatusHistory.create({
        data: {
          organizationId: a.organizationId,
          admissionId: a.id,
          fromStatus: 'NONE',
          toStatus: 'DRAFT',
          actorUserId: p.userId,
          occurredAt: now,
        },
      });
      await tx.leadEvent.create({
        data: {
          organizationId: lead.organizationId,
          leadId,
          type: 'ADMISSION_STARTED',
          actorUserId: p.userId,
          body: `Admission started for ${course.name}`,
          data: { admissionId: a.id },
          occurredAt: now,
        },
      });
      a = await this.recompute(tx, a, p.userId, now);
      return a;
    });
  }

  // ------------------------------------------------------------- reads
  private async present(tx: Tx, p: OrgPrincipal, a: Admission) {
    const [student, lead, course, batch, docs, history, handover] = await Promise.all([
      tx.student.findUniqueOrThrow({ where: { id: a.studentId } }),
      tx.lead.findUniqueOrThrow({ where: { id: a.leadId }, include: { person: true } }),
      tx.course.findUniqueOrThrow({
        where: { id: a.courseId },
        select: { id: true, name: true, code: true },
      }),
      a.batchId ? tx.batch.findUnique({ where: { id: a.batchId } }) : null,
      tx.admissionDocument.findMany({ where: { admissionId: a.id } }),
      tx.admissionStatusHistory.findMany({
        where: { admissionId: a.id },
        orderBy: { occurredAt: 'asc' },
      }),
      tx.lmsHandover.findUnique({ where: { admissionId: a.id } }),
    ]);
    const [types, files, reviews] = await Promise.all([
      tx.documentType.findMany({ where: { id: { in: docs.map((d) => d.documentTypeId) } } }),
      tx.documentFile.findMany({
        where: { admissionDocumentId: { in: docs.map((d) => d.id) } },
        orderBy: { uploadedAt: 'desc' },
      }),
      tx.documentReview.findMany({
        where: { admissionDocumentId: { in: docs.map((d) => d.id) } },
        orderBy: { occurredAt: 'desc' },
      }),
    ]);
    const type = new Map(types.map((t) => [t.id, t]));
    const canView = this.inBrand(p, 'document.view', a.brandId);
    const fullPii = p.authz.visibleBrandIds('pii.view_full');
    const pii = fullPii.all || fullPii.brandIds.includes(a.brandId);
    const required = docs.filter((d) => d.required);
    const seats = batch
      ? { capacity: batch.capacity, used: await this.seatsUsed(tx, batch.id) }
      : null;
    return {
      ...a,
      leadNumber: lead.leadNumber,
      student: {
        ...student,
        guardianPhone: pii ? student.guardianPhone : maskPhone(student.guardianPhone),
        idNumber: pii || !student.idNumber ? student.idNumber : `••••${student.idNumber.slice(-4)}`,
        email: lead.person.email,
        phone: pii ? lead.person.phoneE164 : maskPhone(lead.person.phoneE164),
      },
      course,
      batch: batch
        ? {
            id: batch.id,
            name: batch.name,
            code: batch.code,
            startDate: batch.startDate,
            status: batch.status,
          }
        : null,
      seats,
      documents: docs
        .map((d) => ({
          ...d,
          type: type.get(d.documentTypeId)
            ? {
                code: type.get(d.documentTypeId)!.code,
                label: type.get(d.documentTypeId)!.label,
                description: type.get(d.documentTypeId)!.description,
                acceptedTypes: type.get(d.documentTypeId)!.acceptedTypes,
                position: type.get(d.documentTypeId)!.position,
              }
            : null,
          files: canView
            ? files
                .filter((f) => f.admissionDocumentId === d.id)
                .map(({ storageKey: _s, ...f }) => (void _s, f))
            : [],
          reviews: reviews.filter((r) => r.admissionDocumentId === d.id),
        }))
        .sort((x, y) => (x.type?.position ?? 0) - (y.type?.position ?? 0)),
      readyForApproval:
        a.status === 'UNDER_VERIFICATION' && required.every((d) => d.status === 'VERIFIED'),
      history,
      handover,
      can: {
        manage: this.canManage(p, a.brandId),
        work: this.canWork(p, a.brandId),
        viewDocuments: canView,
      },
    };
  }

  get(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) =>
      this.present(tx, p, await this.visible(tx, p, id)),
    );
  }

  forLead(p: OrgPrincipal, leadId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.leads.visibleLead(tx, p, leadId);
      const a = await tx.admission.findFirst({
        where: { leadId },
        orderBy: [{ createdAt: 'desc' }],
      });
      return { current: a ? await this.present(tx, p, a) : null };
    });
  }

  list(p: OrgPrincipal, q: z.infer<typeof AdmissionListQuerySchema>) {
    const v = p.authz.visibleBrandIds('admission.manage');
    if (!v.all && !v.brandIds.length) throw forbidden();
    if (q.brandId && !v.all && !v.brandIds.includes(q.brandId)) throw notFound('Brand');
    return this.db.tenant(p.organizationId, async (tx) => {
      const rows = await tx.admission.findMany({
        where: {
          ...(q.brandId ? { brandId: q.brandId } : v.all ? {} : { brandId: { in: v.brandIds } }),
          ...(q.status ? { status: q.status } : { status: { notIn: ['CANCELLED'] } }),
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      });
      const [students, courses, batches, leads, docs] = await Promise.all([
        tx.student.findMany({
          where: { id: { in: rows.map((r) => r.studentId) } },
          select: { id: true, legalName: true },
        }),
        tx.course.findMany({
          where: { id: { in: rows.map((r) => r.courseId) } },
          select: { id: true, name: true },
        }),
        tx.batch.findMany({
          where: { id: { in: rows.map((r) => r.batchId).filter((x): x is string => !!x) } },
          select: { id: true, name: true },
        }),
        tx.lead.findMany({
          where: { id: { in: rows.map((r) => r.leadId) } },
          select: { id: true, leadNumber: true },
        }),
        tx.admissionDocument.groupBy({
          by: ['admissionId', 'status'],
          where: { admissionId: { in: rows.map((r) => r.id) }, required: true },
          _count: { _all: true },
        }),
      ]);
      const m = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
      const s = m(students),
        c = m(courses),
        b = m(batches),
        l = m(leads);
      return rows.map((r) => {
        const mine = docs.filter((d) => d.admissionId === r.id);
        const total = mine.reduce((n, d) => n + d._count._all, 0);
        const verified = mine
          .filter((d) => d.status === 'VERIFIED')
          .reduce((n, d) => n + d._count._all, 0);
        return {
          id: r.id,
          leadId: r.leadId,
          leadNumber: l.get(r.leadId)?.leadNumber,
          studentName: s.get(r.studentId)?.legalName,
          course: c.get(r.courseId)?.name,
          batch: r.batchId ? (b.get(r.batchId)?.name ?? null) : null,
          status: r.status,
          admissionNumber: r.admissionNumber,
          documents: { verified, required: total },
          updatedAt: r.updatedAt,
        };
      });
    });
  }

  // --------------------------------------------------------- student profile
  updateStudent(p: OrgPrincipal, id: string, input: z.infer<typeof StudentProfileSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await this.visible(tx, p, id);
      if (!this.canWork(p, a.brandId)) throw forbidden();
      const data = Object.fromEntries(
        Object.entries(input)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [
            k,
            k === 'dateOfBirth' && v
              ? new Date(`${v as string}T00:00:00.000Z`)
              : v === ''
                ? null
                : v,
          ]),
      );
      await tx.student.update({ where: { id: a.studentId }, data });
      await this.audit.record(tx, {
        organizationId: a.organizationId,
        brandId: a.brandId,
        actorUserId: p.userId,
        action: 'student.updated',
        entityType: 'student',
        entityId: a.studentId,
        after: { fields: Object.keys(data) }, // values are personal data: only the field names are logged
      });
      return this.present(tx, p, a);
    });
  }

  // ------------------------------------------------------------- documents
  async upload(
    p: OrgPrincipal,
    id: string,
    documentTypeId: string,
    file: UploadedFile | undefined,
  ) {
    if (!file) throw badRequest('FILE_REQUIRED', 'Attach a file');
    if (file.size > MAX_DOCUMENT_BYTES)
      throw badRequest('FILE_TOO_LARGE', 'Files can be at most 4 MB');
    const sniffed = sniffContentType(file.buffer);
    if (!sniffed || !(DOCUMENT_CONTENT_TYPES as readonly string[]).includes(sniffed))
      throw badRequest('FILE_TYPE_NOT_ALLOWED', 'Upload a PDF, JPG, PNG or WEBP file');
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await this.visible(tx, p, id);
      if (!this.canWork(p, a.brandId)) throw forbidden();
      if (a.status === 'CANCELLED')
        throw badRequest('ADMISSION_CANCELLED', 'This admission was cancelled');
      const doc = await tx.admissionDocument.findUnique({
        where: { admissionId_documentTypeId: { admissionId: a.id, documentTypeId } },
      });
      if (!doc) throw notFound('Document');
      const type = await tx.documentType.findUniqueOrThrow({ where: { id: documentTypeId } });
      if (!type.acceptedTypes.includes(sniffed))
        throw badRequest(
          'FILE_TYPE_NOT_ALLOWED',
          `${type.label} accepts: ${type.acceptedTypes.join(', ')}`,
        );
      const key = await this.storage.put(tx, a.organizationId, file.buffer);
      const stored = await tx.documentFile.create({
        data: {
          organizationId: a.organizationId,
          admissionDocumentId: doc.id,
          fileName: file.originalname.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'document',
          contentType: sniffed,
          sizeBytes: file.size,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
          storageKey: key,
          uploadedById: p.userId,
          uploadedAt: now,
        },
      });
      await tx.admissionDocument.update({
        where: { id: doc.id },
        data: {
          status: 'UPLOADED',
          currentFileId: stored.id,
          verifiedById: null,
          verifiedAt: null,
          rejectionReason: null,
        },
      });
      await tx.leadEvent.create({
        data: {
          organizationId: a.organizationId,
          leadId: a.leadId,
          type: 'DOCUMENT_UPLOADED',
          actorUserId: p.userId,
          body: `${type.label} uploaded`,
          data: { admissionId: a.id, fileId: stored.id },
          occurredAt: now,
        },
      });
      await this.recompute(tx, a, p.userId, now);
      return { fileId: stored.id, status: 'UPLOADED' };
    });
  }

  private async reviewTarget(tx: Tx, p: OrgPrincipal, admissionDocumentId: string) {
    const doc = await tx.admissionDocument.findUnique({ where: { id: admissionDocumentId } });
    if (!doc) throw notFound('Document');
    const a = await this.visible(tx, p, doc.admissionId);
    if (!this.canManage(p, a.brandId)) throw forbidden('Only admission officers verify documents');
    return { doc, a };
  }

  verify(p: OrgPrincipal, admissionDocumentId: string) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const { doc, a } = await this.reviewTarget(tx, p, admissionDocumentId);
      if (doc.status !== 'UPLOADED')
        throw badRequest('NOTHING_TO_VERIFY', 'Upload the document before verifying it');
      await tx.admissionDocument.update({
        where: { id: doc.id },
        data: { status: 'VERIFIED', verifiedById: p.userId, verifiedAt: now },
      });
      await tx.documentReview.create({
        data: {
          organizationId: a.organizationId,
          admissionDocumentId: doc.id,
          fileId: doc.currentFileId,
          decision: 'VERIFIED',
          reviewerId: p.userId,
          occurredAt: now,
        },
      });
      await this.recompute(tx, a, p.userId, now);
      return { status: 'VERIFIED' };
    });
  }

  reject(
    p: OrgPrincipal,
    admissionDocumentId: string,
    input: z.infer<typeof RejectDocumentSchema>,
  ) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const { doc, a } = await this.reviewTarget(tx, p, admissionDocumentId);
      if (doc.status !== 'UPLOADED' && doc.status !== 'VERIFIED')
        throw badRequest('NOTHING_TO_REJECT', 'Only uploaded documents can be rejected');
      await tx.admissionDocument.update({
        where: { id: doc.id },
        data: {
          status: 'REJECTED',
          rejectionReason: input.reason,
          verifiedById: p.userId,
          verifiedAt: now,
        },
      });
      await tx.documentReview.create({
        data: {
          organizationId: a.organizationId,
          admissionDocumentId: doc.id,
          fileId: doc.currentFileId,
          decision: 'REJECTED',
          reason: input.reason,
          reviewerId: p.userId,
          occurredAt: now,
        },
      });
      const type = await tx.documentType.findUniqueOrThrow({ where: { id: doc.documentTypeId } });
      await tx.leadEvent.create({
        data: {
          organizationId: a.organizationId,
          leadId: a.leadId,
          type: 'DOCUMENT_REJECTED',
          actorUserId: p.userId,
          body: `${type.label} rejected — ${input.reason}`,
          data: { admissionId: a.id },
          occurredAt: now,
        },
      });
      await this.recompute(tx, a, p.userId, now);
      return { status: 'REJECTED' };
    });
  }

  /** A 5-minute signed link; only document.view holders get one. */
  link(p: OrgPrincipal, fileId: string) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const f = await tx.documentFile.findUnique({ where: { id: fileId } });
      if (!f) throw notFound('File');
      const doc = await tx.admissionDocument.findUniqueOrThrow({
        where: { id: f.admissionDocumentId },
      });
      const a = await this.visible(tx, p, doc.admissionId);
      if (!this.inBrand(p, 'document.view', a.brandId))
        throw forbidden('You cannot view student documents');
      const e = now.getTime() + DownloadLinks.TTL_MS;
      const token = this.links.sign({ f: f.id, o: a.organizationId, u: p.userId, e });
      return {
        url: `/api/v1/documents/download?token=${encodeURIComponent(token)}`,
        expiresAt: new Date(e),
      };
    });
  }

  async download(token: string) {
    const now = this.clock.now();
    const claims = this.links.verify(token, now.getTime());
    if (!claims)
      throw new AppError(410, 'LINK_EXPIRED', 'This download link is invalid or has expired');
    return this.db.tenant(claims.o, async (tx) => {
      const f = await tx.documentFile.findUnique({ where: { id: claims.f } });
      if (!f) throw notFound('File');
      const content = await this.storage.get(tx, f.storageKey);
      if (!content) throw notFound('File');
      const doc = await tx.admissionDocument.findUniqueOrThrow({
        where: { id: f.admissionDocumentId },
      });
      const a = await tx.admission.findUniqueOrThrow({ where: { id: doc.admissionId } });
      await this.audit.record(tx, {
        organizationId: claims.o,
        brandId: a.brandId,
        actorUserId: claims.u,
        action: 'document.downloaded',
        entityType: 'document_file',
        entityId: f.id,
      });
      return { content, fileName: f.fileName, contentType: f.contentType };
    });
  }

  // -------------------------------------------------------------- workflow
  private async manageable(tx: Tx, p: OrgPrincipal, id: string) {
    await tx.$queryRaw`SELECT id FROM admissions WHERE id = ${id}::uuid FOR UPDATE`;
    const a = await this.visible(tx, p, id);
    if (!this.canManage(p, a.brandId)) throw forbidden('Only admission officers can do this');
    return a;
  }

  approve(p: OrgPrincipal, id: string, input: z.infer<typeof ApproveAdmissionSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await this.manageable(tx, p, id);
      if (a.status !== 'UNDER_VERIFICATION' && a.status !== 'DOCUMENTS_PENDING')
        throw badRequest(
          'CANNOT_APPROVE',
          `An admission that is ${a.status.toLowerCase().replace(/_/g, ' ')} cannot be approved`,
        );
      const missing = await tx.admissionDocument.findMany({
        where: { admissionId: a.id, required: true, status: { not: 'VERIFIED' } },
      });
      if (missing.length) {
        const types = await tx.documentType.findMany({
          where: { id: { in: missing.map((m) => m.documentTypeId) } },
        });
        throw badRequest(
          'DOCUMENTS_INCOMPLETE',
          `Still to verify: ${types.map((t) => t.label).join(', ')}`,
          { missing: types.map((t) => t.code) },
        );
      }
      if (!a.batchId) throw badRequest('BATCH_REQUIRED', 'Choose a batch before approving');
      const seat = await this.takeSeat(tx, p, a, a.batchId, input.overrideCapacityReason);
      const done = await this.setStatus(tx, a, 'APPROVED', seat.seatOverrideReason, p.userId, now, {
        holdsSeat: true,
        ...seat,
        approvedById: p.userId,
        approvedAt: now,
        officerId: a.officerId ?? p.userId,
      });
      return this.present(tx, p, done);
    });
  }

  changeBatch(p: OrgPrincipal, id: string, input: z.infer<typeof ChangeBatchSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await this.manageable(tx, p, id);
      if (a.status === 'CANCELLED')
        throw badRequest('ADMISSION_CANCELLED', 'This admission was cancelled');
      const b = await tx.batch.findFirst({
        where: { id: input.batchId, courseId: a.courseId, status: { in: ['PLANNED', 'OPEN'] } },
      });
      if (!b) throw badRequest('INVALID_BATCH', 'Choose a planned or open batch of this course');
      const seat = a.holdsSeat
        ? await this.takeSeat(tx, p, a, b.id, input.overrideCapacityReason)
        : { seatOverride: false, seatOverrideReason: null };
      const moved = await tx.admission.update({
        where: { id: a.id },
        data: { batchId: b.id, ...seat },
      });
      await tx.leadEvent.create({
        data: {
          organizationId: a.organizationId,
          leadId: a.leadId,
          type: 'ADMISSION_BATCH_CHANGED',
          actorUserId: p.userId,
          body: `Batch changed to ${b.name}`,
          data: { admissionId: a.id, from: a.batchId, to: b.id },
          occurredAt: now,
        },
      });
      await this.audit.record(tx, {
        organizationId: a.organizationId,
        brandId: a.brandId,
        actorUserId: p.userId,
        action: 'admission.batch_changed',
        entityType: 'admission',
        entityId: a.id,
        before: { batchId: a.batchId },
        after: { batchId: b.id, ...seat },
      });
      return this.present(tx, p, moved);
    });
  }

  defer(p: OrgPrincipal, id: string, input: z.infer<typeof DeferAdmissionSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await this.manageable(tx, p, id);
      if (a.status === 'CONFIRMED' || a.status === 'CANCELLED' || a.status === 'DEFERRED')
        throw badRequest(
          'CANNOT_DEFER',
          `An admission that is ${a.status.toLowerCase()} cannot be deferred`,
        );
      if (
        input.batchId &&
        !(await tx.batch.findFirst({ where: { id: input.batchId, courseId: a.courseId } }))
      )
        throw badRequest('INVALID_BATCH', 'Choose a batch of this course');
      const done = await this.setStatus(tx, a, 'DEFERRED', input.reason, p.userId, now, {
        holdsSeat: false,
        seatOverride: false,
        seatOverrideReason: null,
        ...(input.batchId ? { batchId: input.batchId } : {}),
      });
      return this.present(tx, p, done);
    });
  }

  resume(p: OrgPrincipal, id: string) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await this.manageable(tx, p, id);
      if (a.status !== 'DEFERRED')
        throw badRequest('NOT_DEFERRED', 'This admission is not deferred');
      // Back to the document phase: approval (and its seat) must be given again.
      const back = await this.setStatus(tx, a, 'DOCUMENTS_PENDING', 'Resumed', p.userId, now);
      return this.present(tx, p, await this.recompute(tx, back, p.userId, now));
    });
  }

  cancel(p: OrgPrincipal, id: string, input: z.infer<typeof AdmissionReasonSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await this.manageable(tx, p, id);
      if (a.status === 'CONFIRMED')
        throw badRequest(
          'USE_REFUND_FLOW',
          'A confirmed admission is cancelled through the refund process',
        );
      if (a.status === 'CANCELLED') throw badRequest('ADMISSION_CANCELLED', 'Already cancelled');
      const done = await this.setStatus(tx, a, 'CANCELLED', input.reason, p.userId, now, {
        holdsSeat: false,
        seatOverride: false,
        seatOverrideReason: null,
      });
      return this.present(tx, p, done);
    });
  }

  // ------------------------------------------------------------ confirmation
  /**
   * D-006: the first verified payment confirms the admission (called by Phase 12 payments).
   * Generates the admission number, holds a seat, moves the lead to the system stage and
   * CONVERTED, and starts the LMS handover. Runs inside the caller's transaction.
   */
  async confirmInTx(
    tx: Tx,
    admissionId: string,
    c: { source: string; actorUserId: string | null; now: Date },
  ) {
    await tx.$queryRaw`SELECT id FROM admissions WHERE id = ${admissionId}::uuid FOR UPDATE`;
    const a = await tx.admission.findUniqueOrThrow({ where: { id: admissionId } });
    if (a.status === 'CONFIRMED') return a; // idempotent
    if (!CONFIRMABLE.includes(a.status))
      throw badRequest(
        'CANNOT_CONFIRM',
        `An admission that is ${a.status.toLowerCase()} cannot be confirmed`,
      );
    const settings = await tx.admissionSettings.findUniqueOrThrow({
      where: { brandId: a.brandId },
    });
    if (settings.requireApprovalToConfirm && a.status !== 'APPROVED')
      throw badRequest('NOT_APPROVED', 'This brand confirms admissions only after approval');
    if (!a.batchId)
      throw badRequest('BATCH_REQUIRED', 'Choose a batch before the admission can be confirmed');
    const seat = a.holdsSeat ? {} : await this.takeSeat(tx, null, a, a.batchId);
    const brand = await tx.brand.findUniqueOrThrow({ where: { id: a.brandId } });
    const year = DateTime.fromJSDate(c.now, { zone: brand.timezone }).year;
    const [row] = await tx.$queryRaw<Array<{ value: bigint }>>`
      INSERT INTO org_counters (organization_id, name, value) VALUES (${a.organizationId}::uuid, ${`admission:${a.brandId}:${year}`}, 1)
      ON CONFLICT (organization_id, name) DO UPDATE SET value = org_counters.value + 1
      RETURNING value`;
    const admissionNumber = formatAdmissionNumber(settings.numberFormat, {
      brand: brand.code,
      year,
      seq: Number(row.value),
    });
    const done = await this.setStatus(tx, a, 'CONFIRMED', c.source, c.actorUserId, c.now, {
      ...seat,
      holdsSeat: true,
      admissionNumber,
      confirmedAt: c.now,
      confirmationSource: c.source,
    });

    // Lead: system stage + CONVERTED (FR-011 / D-006).
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: a.leadId } });
    if (lead.stage !== 'ADMISSION_CONFIRMED') {
      await tx.lead.update({
        where: { id: lead.id },
        data: { stage: 'ADMISSION_CONFIRMED', stageChangedAt: c.now },
      });
      await tx.leadStageHistory.create({
        data: {
          organizationId: lead.organizationId,
          brandId: lead.brandId,
          leadId: lead.id,
          fromStage: lead.stage,
          toStage: 'ADMISSION_CONFIRMED',
          direction: 'FORWARD',
          actorUserId: c.actorUserId,
          reason: `Admission ${admissionNumber} confirmed (${c.source})`,
          occurredAt: c.now,
        },
      });
    }
    await changeLeadStatus(tx, {
      lead,
      to: 'CONVERTED',
      reasonCode: 'ADMISSION_CONFIRMED',
      notes: admissionNumber,
      actorUserId: c.actorUserId,
      now: c.now,
    });
    await this.sla.cancel(tx, lead.id, 'Admission confirmed', c.now);
    await tx.outboxEvent.create({
      data: {
        organizationId: a.organizationId,
        type: 'admission.confirmed',
        aggregateType: 'admission',
        aggregateId: a.id,
        payload: { admissionNumber, leadId: a.leadId, batchId: a.batchId, source: c.source },
      },
    });
    await this.createHandover(tx, done, c.now);
    return done;
  }

  private async createHandover(tx: Tx, a: Admission, now: Date) {
    const [student, lead, brand, course, batch] = await Promise.all([
      tx.student.findUniqueOrThrow({ where: { id: a.studentId } }),
      tx.lead.findUniqueOrThrow({ where: { id: a.leadId }, include: { person: true } }),
      tx.brand.findUniqueOrThrow({ where: { id: a.brandId } }),
      tx.course.findUniqueOrThrow({ where: { id: a.courseId } }),
      a.batchId ? tx.batch.findUnique({ where: { id: a.batchId } }) : null,
    ]);
    const payload: LmsHandoverPayload = {
      version: 1,
      admissionId: a.id,
      admissionNumber: a.admissionNumber!,
      confirmedAt: a.confirmedAt!.toISOString(),
      brand: { id: brand.id, code: brand.code, name: brand.name },
      course: { id: course.id, code: course.code, name: course.name },
      batch: batch
        ? {
            id: batch.id,
            code: batch.code,
            name: batch.name,
            startDate: batch.startDate.toISOString().slice(0, 10),
          }
        : null,
      student: {
        id: student.id,
        legalName: student.legalName,
        email: lead.person.email,
        phone: lead.person.phoneE164,
        dateOfBirth: student.dateOfBirth ? student.dateOfBirth.toISOString().slice(0, 10) : null,
      },
    };
    const h = await tx.lmsHandover.upsert({
      where: { admissionId: a.id },
      create: {
        organizationId: a.organizationId,
        admissionId: a.id,
        provider: this.lms.provider?.name ?? null,
        payload: payload as unknown as Prisma.InputJsonValue,
        createdAt: now,
      },
      update: {},
    });
    if (this.lms.provider)
      await this.jobs.enqueue(tx, {
        organizationId: a.organizationId,
        type: 'lms.handover',
        key: `lms:${h.id}`,
        payload: { handoverId: h.id },
        runAt: now,
      });
  }

  private async sendHandover(job: JobRow): Promise<void> {
    const { handoverId } = job.payload as { handoverId: string };
    const org = job.organizationId!;
    const provider = this.lms.provider;
    const h = await this.db.tenant(org, (tx) =>
      tx.lmsHandover.findUnique({ where: { id: handoverId } }),
    );
    if (!h || h.status !== 'PENDING' || !provider) return;
    try {
      const r = await provider.send(h.payload as unknown as LmsHandoverPayload);
      await this.db.tenant(org, (tx) =>
        tx.lmsHandover.update({
          where: { id: h.id },
          data: {
            status: 'SENT',
            providerRef: r.providerRef,
            attempts: { increment: 1 },
            lastError: null,
          },
        }),
      );
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      const last = job.attempts >= job.maxAttempts;
      await this.db.tenant(org, (tx) =>
        tx.lmsHandover.update({
          where: { id: h.id },
          data: {
            attempts: { increment: 1 },
            lastError: message,
            ...(last ? { status: 'FAILED' } : {}),
          },
        }),
      );
      throw e;
    }
  }

  markHandedOver(p: OrgPrincipal, handoverId: string) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const h = await tx.lmsHandover.findUnique({ where: { id: handoverId } });
      if (!h) throw notFound('Handover');
      const a = await this.manageable(tx, p, h.admissionId);
      if (h.status === 'SENT' || h.status === 'ACKNOWLEDGED' || h.status === 'DONE_MANUALLY')
        throw badRequest('ALREADY_HANDED_OVER', 'This handover is already done');
      const done = await tx.lmsHandover.update({
        where: { id: h.id },
        data: { status: 'DONE_MANUALLY', completedById: p.userId, completedAt: now },
      });
      await this.audit.record(tx, {
        organizationId: a.organizationId,
        brandId: a.brandId,
        actorUserId: p.userId,
        action: 'admission.handed_over',
        entityType: 'lms_handover',
        entityId: h.id,
      });
      return done;
    });
  }
}
