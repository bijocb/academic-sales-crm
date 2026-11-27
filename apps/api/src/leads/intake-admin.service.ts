import { Injectable } from '@nestjs/common';
import type { DuplicatePolicy } from '@prisma/client';
import { CreateImportSchema, IMPORT_FIELDS, LeadInput, LeadInputSchema, z } from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, forbidden, notFound } from '../common/errors';
import { pageArgs } from '../common/scope';
import { Db } from '../db/db.service';
import { IngestResult, IntakeService } from './intake.service';

type Row = { rowNumber: number; data: Record<string, string> };

/** Converts a mapped import row (column → IMPORT_FIELDS key) into LeadInput. */
export function rowToLeadInput(data: Record<string, string>): {
  input?: LeadInput;
  error?: string;
} {
  const picked: Record<string, string> = {};
  for (const f of IMPORT_FIELDS) {
    const v = data[f];
    if (v !== undefined && v.trim() !== '') picked[f] = v.trim();
  }
  if (picked.receivedAt) {
    const d = new Date(picked.receivedAt);
    if (Number.isNaN(d.getTime()))
      return { error: `receivedAt "${picked.receivedAt}" is not a valid date` };
    picked.receivedAt = d.toISOString();
  }
  const parsed = LeadInputSchema.safeParse(picked);
  if (!parsed.success)
    return {
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  return { input: parsed.data };
}

/** Exception queue and CSV/XLSX imports. */
@Injectable()
export class IntakeAdminService {
  constructor(
    private readonly db: Db,
    private readonly intake: IntakeService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private brandAllowed(p: OrgPrincipal, brandId: string): boolean {
    const v = p.authz.visibleBrandIds('lead.import');
    return v.all || v.brandIds.includes(brandId);
  }

  private assertBrand(p: OrgPrincipal, brandId: string) {
    if (!this.brandAllowed(p, brandId)) throw notFound('Brand');
  }

  // ---------------------------------------------------------- exceptions
  async listExceptions(
    p: OrgPrincipal,
    q: {
      brandId?: string;
      status?: 'OPEN' | 'RESOLVED' | 'DISCARDED';
      page: number;
      pageSize: number;
    },
  ) {
    const v = p.authz.visibleBrandIds('lead.import');
    if (q.brandId) this.assertBrand(p, q.brandId);
    const where = {
      ...(q.brandId ? { brandId: q.brandId } : v.all ? {} : { brandId: { in: v.brandIds } }),
      status: q.status ?? 'OPEN',
    };
    return this.db.tenant(p.organizationId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.intakeException.findMany({
          where,
          orderBy: { receivedAt: 'desc' },
          ...pageArgs(q.page, q.pageSize),
        }),
        tx.intakeException.count({ where }),
      ]);
      return { items, total, page: q.page, pageSize: q.pageSize };
    });
  }

  async resolveException(
    p: OrgPrincipal,
    id: string,
    lead: LeadInput,
    note?: string,
  ): Promise<IngestResult> {
    const ex = await this.db.tenant(p.organizationId, (tx) =>
      tx.intakeException.findUnique({ where: { id } }),
    );
    if (!ex || !this.brandAllowed(p, ex.brandId)) throw notFound('Exception');
    if (ex.status !== 'OPEN')
      throw badRequest('EXCEPTION_CLOSED', 'This exception is already closed');
    const result = await this.intake.ingest(
      {
        organizationId: p.organizationId,
        brandId: ex.brandId,
        channel: ex.channel,
        sourceId: ex.sourceId,
        importId: ex.importId,
        createdById: p.userId,
        dedupKey: `exception:${ex.id}`,
        exceptionOnInvalid: false,
        extra: { resolvedFromException: ex.id },
      },
      lead,
    );
    if (result.outcome === 'INVALID')
      throw badRequest('VALIDATION_ERROR', 'The corrected lead is still invalid', result.errors);
    await this.db.tenant(p.organizationId, async (tx) => {
      await tx.intakeException.update({
        where: { id },
        data: {
          status: 'RESOLVED',
          resolvedById: p.userId,
          resolvedAt: this.clock.now(),
          resolvedLeadId: result.leadId,
          resolutionNote: note,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: ex.brandId,
        action: 'intake_exception.resolved',
        entityType: 'intake_exception',
        entityId: id,
        after: { leadId: result.leadId },
      });
    });
    return result;
  }

  async discardException(p: OrgPrincipal, id: string, reason: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const ex = await tx.intakeException.findUnique({ where: { id } });
      if (!ex || !this.brandAllowed(p, ex.brandId)) throw notFound('Exception');
      if (ex.status !== 'OPEN')
        throw badRequest('EXCEPTION_CLOSED', 'This exception is already closed');
      const after = await tx.intakeException.update({
        where: { id },
        data: {
          status: 'DISCARDED',
          resolvedById: p.userId,
          resolvedAt: this.clock.now(),
          resolutionNote: reason,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: ex.brandId,
        action: 'intake_exception.discarded',
        entityType: 'intake_exception',
        entityId: id,
        reason,
      });
      return after;
    });
  }

  // ------------------------------------------------------------- imports
  /** Dry run: validates rows and reports which would update an existing lead. No writes. */
  async validateRows(p: OrgPrincipal, brandId: string, rows: Row[]) {
    this.assertBrand(p, brandId);
    if (!p.authz.can('lead.import', { brandId })) throw forbidden();
    const results = [];
    for (const r of rows) {
      const conv = rowToLeadInput(r.data);
      if (!conv.input) {
        results.push({
          rowNumber: r.rowNumber,
          ok: false,
          errors: [{ field: 'row', message: conv.error! }],
          warnings: [],
          existingLead: false,
        });
        continue;
      }
      const c = await this.intake.check(p.organizationId, brandId, conv.input);
      results.push({ rowNumber: r.rowNumber, ok: c.errors.length === 0, ...c });
    }
    return {
      results,
      summary: {
        valid: results.filter((r) => r.ok).length,
        invalid: results.filter((r) => !r.ok).length,
        existing: results.filter((r) => r.ok && r.existingLead).length,
      },
    };
  }

  async createImport(p: OrgPrincipal, input: z.infer<typeof CreateImportSchema>) {
    this.assertBrand(p, input.brandId);
    if (!p.authz.can('lead.import', { brandId: input.brandId })) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      if (
        input.sourceId &&
        !(await tx.leadSource.findFirst({ where: { id: input.sourceId, brandId: input.brandId } }))
      ) {
        throw notFound('Lead source');
      }
      const imp = await tx.leadImport.create({
        data: {
          organizationId: p.organizationId,
          ...input,
          duplicatePolicy: input.duplicatePolicy as DuplicatePolicy,
          createdById: p.userId,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: input.brandId,
        action: 'lead_import.started',
        entityType: 'lead_import',
        entityId: imp.id,
        after: { fileName: input.fileName, totalRows: input.totalRows },
      });
      return imp;
    });
  }

  /** Imports one chunk. Safe to retry: each row has a deterministic idempotency key. */
  async importRows(p: OrgPrincipal, importId: string, rows: Row[]) {
    const imp = await this.db.tenant(p.organizationId, (tx) =>
      tx.leadImport.findUnique({ where: { id: importId } }),
    );
    if (!imp || !this.brandAllowed(p, imp.brandId)) throw notFound('Import');
    if (imp.status !== 'IN_PROGRESS')
      throw badRequest('IMPORT_CLOSED', 'This import is already completed');
    const counts = { createdLeads: 0, addedEnquiries: 0, skipped: 0, invalid: 0 };
    const results = [];
    for (const r of rows) {
      const conv = rowToLeadInput(r.data);
      const origin = {
        organizationId: p.organizationId,
        brandId: imp.brandId,
        channel: 'IMPORT' as const,
        sourceId: imp.sourceId,
        importId: imp.id,
        rowNumber: r.rowNumber,
        createdById: p.userId,
        dedupKey: `import:${imp.id}:${r.rowNumber}`,
        duplicatePolicy: imp.duplicatePolicy,
        exceptionOnInvalid: true,
      };
      // Rows that cannot even be read still reach the exception queue (raw data kept).
      const res = conv.input
        ? await this.intake.ingest(origin, conv.input)
        : await this.intake.recordUnreadable(origin, r.data, conv.error!);
      if (res.outcome === 'CREATED_LEAD') counts.createdLeads++;
      else if (res.outcome === 'ADDED_ENQUIRY') counts.addedEnquiries++;
      else if (res.outcome === 'SKIPPED_EXISTING') counts.skipped++;
      else if (res.outcome === 'INVALID' && !res.replay) counts.invalid++;
      results.push({
        rowNumber: r.rowNumber,
        outcome: res.outcome,
        replay: res.replay ?? false,
        leadNumber: res.leadNumber,
        errors: res.errors ?? [],
      });
    }
    // Replayed rows (DUPLICATE_REPLAY) are not counted twice.
    await this.db.tenant(p.organizationId, (tx) =>
      tx.leadImport.update({
        where: { id: imp.id },
        data: {
          createdLeads: { increment: counts.createdLeads },
          addedEnquiries: { increment: counts.addedEnquiries },
          skipped: { increment: counts.skipped },
          invalid: { increment: counts.invalid },
        },
      }),
    );
    return { results, counts };
  }

  async completeImport(p: OrgPrincipal, importId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const imp = await tx.leadImport.findUnique({ where: { id: importId } });
      if (!imp || !this.brandAllowed(p, imp.brandId)) throw notFound('Import');
      if (imp.status === 'COMPLETED') return imp;
      const done = await tx.leadImport.update({
        where: { id: importId },
        data: { status: 'COMPLETED', completedAt: this.clock.now() },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: imp.brandId,
        action: 'lead_import.completed',
        entityType: 'lead_import',
        entityId: importId,
        after: done,
      });
      return done;
    });
  }

  async listImports(p: OrgPrincipal, brandId?: string) {
    const v = p.authz.visibleBrandIds('lead.import');
    if (brandId) this.assertBrand(p, brandId);
    return this.db.tenant(p.organizationId, (tx) =>
      tx.leadImport.findMany({
        where: brandId ? { brandId } : v.all ? {} : { brandId: { in: v.brandIds } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
  }
}
