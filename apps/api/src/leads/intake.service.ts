import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LeadChannel } from '@prisma/client';
import type { LeadInput } from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import { Clock } from '../common/clock';
import { Db, Tx } from '../db/db.service';
import { dedupKeyFor, FieldIssue, normalizeEmail, normalizePhone } from './normalize';
import { DuplicateDetector } from './duplicate-detector';
import { nameKey } from './duplicate-rules';
import { cancelRecoveryOnReturn } from '../recovery/recovery-hooks';
import { AllocationService } from '../allocation/allocation.service';

/** Same active lead, different channel within this window ⇒ CROSS_CHANNEL_DUPLICATE (A-026). */
export const CROSS_CHANNEL_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface IngestOrigin {
  organizationId: string;
  brandId: string;
  channel: LeadChannel;
  sourceId?: string | null;
  createdById?: string | null;
  importId?: string | null;
  rowNumber?: number | null;
  /** Overrides the computed idempotency key (imports, exception resolution). */
  dedupKey?: string;
  duplicatePolicy?: 'ADD_ENQUIRY' | 'SKIP_EXISTING';
  /** true: invalid input is stored in the exception queue. false: just report the errors. */
  exceptionOnInvalid: boolean;
  extra?: Record<string, unknown>;
}

export type IngestOutcome =
  | 'CREATED_LEAD'
  | 'ADDED_ENQUIRY'
  | 'SKIPPED_EXISTING'
  | 'DUPLICATE_REPLAY'
  | 'INVALID';

export interface IngestResult {
  outcome: IngestOutcome;
  leadId?: string;
  leadNumber?: string;
  enquiryId?: string;
  exceptionId?: string;
  errors?: FieldIssue[];
  warnings?: FieldIssue[];
  /** True when this exact submission was already recorded (as an enquiry or an exception). */
  replay?: boolean;
}

interface Validated {
  name: string;
  phoneE164?: string;
  email?: string;
  courseId?: string;
  campaignId?: string;
  receivedAt: Date;
  warnings: FieldIssue[];
}

/**
 * The single intake pipeline used by every channel (intake API, Google webhook, manual
 * entry, imports, exception resolution). See docs/plans/PHASE-04.md.
 */
@Injectable()
export class IntakeService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly duplicates: DuplicateDetector,
    @Optional() private readonly allocation?: AllocationService,
  ) {}

  async ingest(origin: IngestOrigin, input: LeadInput): Promise<IngestResult> {
    let result: IngestResult;
    try {
      result = await this.db.tenant(origin.organizationId, (tx) =>
        this.ingestInTx(tx, origin, input),
      );
    } catch (e) {
      // A concurrent identical submission or a person created in parallel: retry once,
      // the second attempt sees the committed row and resolves to replay / existing person.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        result = await this.db.tenant(origin.organizationId, (tx) =>
          this.ingestInTx(tx, origin, input),
        );
      } else throw e;
    }
    // Allocation runs after the intake transaction commits: a failure never loses the lead.
    if (result.outcome === 'CREATED_LEAD' && result.leadId && this.allocation) {
      await this.allocation.allocateAfterIntake(
        origin.organizationId,
        origin.brandId,
        result.leadId,
      );
    }
    return result;
  }

  /** Stores a submission that could not even be parsed (e.g. malformed import row). Idempotent. */
  async recordUnreadable(
    origin: IngestOrigin & { dedupKey: string },
    raw: Record<string, unknown>,
    message: string,
  ): Promise<IngestResult> {
    const errors: FieldIssue[] = [{ field: 'row', message }];
    return this.db.tenant(origin.organizationId, async (tx) => {
      const existing = await tx.intakeException.findUnique({
        where: { brandId_dedupKey: { brandId: origin.brandId, dedupKey: origin.dedupKey } },
      });
      if (existing)
        return { outcome: 'INVALID' as const, replay: true, exceptionId: existing.id, errors };
      const ex = await tx.intakeException.create({
        data: {
          organizationId: origin.organizationId,
          brandId: origin.brandId,
          channel: origin.channel,
          sourceId: origin.sourceId ?? null,
          importId: origin.importId ?? null,
          rowNumber: origin.rowNumber ?? null,
          dedupKey: origin.dedupKey,
          payload: raw as Prisma.InputJsonValue,
          errors: errors as unknown as Prisma.InputJsonValue,
          receivedAt: this.clock.now(),
        },
      });
      return { outcome: 'INVALID' as const, exceptionId: ex.id, errors };
    });
  }

  /** Validation only (no writes): used by the import dry run. */
  async check(
    organizationId: string,
    brandId: string,
    input: LeadInput,
  ): Promise<{ errors: FieldIssue[]; warnings: FieldIssue[]; existingLead: boolean }> {
    return this.db.tenant(organizationId, async (tx) => {
      const brand = await tx.brand.findUniqueOrThrow({ where: { id: brandId } });
      const v = await this.validate(tx, brand, input);
      if ('errors' in v) return { errors: v.errors, warnings: v.warnings, existingLead: false };
      const person = await this.findPerson(tx, v);
      const existingLead = person ? !!(await this.activeLead(tx, brandId, person.id)) : false;
      return { errors: [], warnings: v.warnings, existingLead };
    });
  }

  private async ingestInTx(tx: Tx, origin: IngestOrigin, input: LeadInput): Promise<IngestResult> {
    const now = this.clock.now();
    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : now;
    const dedupKey = origin.dedupKey ?? dedupKeyFor(origin.channel, input, receivedAt);
    const { brandId, organizationId } = origin;

    // 1. Idempotency: the same submission never creates anything twice.
    const replay = await tx.enquiry.findUnique({
      where: { brandId_dedupKey: { brandId, dedupKey } },
      include: { lead: true },
    });
    if (replay)
      return {
        outcome: 'DUPLICATE_REPLAY',
        replay: true,
        leadId: replay.leadId,
        leadNumber: replay.lead.leadNumber,
        enquiryId: replay.id,
      };
    const knownBad = await tx.intakeException.findUnique({
      where: { brandId_dedupKey: { brandId, dedupKey } },
    });
    if (knownBad)
      return {
        outcome: 'INVALID',
        replay: true,
        exceptionId: knownBad.id,
        errors: knownBad.errors as unknown as FieldIssue[],
      };

    // 2. Validation; failures go to the exception queue (never silently dropped).
    const brand = await tx.brand.findUniqueOrThrow({ where: { id: brandId } });
    const v = await this.validate(tx, brand, input);
    if ('errors' in v) {
      if (!origin.exceptionOnInvalid)
        return { outcome: 'INVALID', errors: v.errors, warnings: v.warnings };
      const ex = await tx.intakeException.create({
        data: {
          organizationId,
          brandId,
          channel: origin.channel,
          sourceId: origin.sourceId ?? null,
          importId: origin.importId ?? null,
          rowNumber: origin.rowNumber ?? null,
          dedupKey,
          payload: input as Prisma.InputJsonValue,
          errors: v.errors as unknown as Prisma.InputJsonValue,
          receivedAt,
        },
      });
      await this.audit.record(tx, {
        organizationId,
        brandId,
        actorUserId: origin.createdById ?? null,
        action: 'intake.rejected',
        entityType: 'intake_exception',
        entityId: ex.id,
        after: { errors: v.errors, channel: origin.channel },
      });
      return { outcome: 'INVALID', exceptionId: ex.id, errors: v.errors, warnings: v.warnings };
    }

    // 3. Person (exact phone, else exact email).
    let person = await this.findPerson(tx, v);
    const knownPerson = !!person;
    let contactChanged = false;
    if (!person) {
      contactChanged = true;
      person = await tx.person.create({
        data: {
          organizationId,
          fullName: v.name,
          nameKey: nameKey(v.name),
          phoneE164: v.phoneE164,
          phoneRaw: input.phone,
          email: v.email,
          city: input.city,
          language: input.language,
        },
      });
    } else {
      const fill: Prisma.PersonUpdateInput = {};
      if (!person.email && v.email) fill.email = v.email;
      if (
        !person.phoneE164 &&
        v.phoneE164 &&
        !(await tx.person.findFirst({ where: { phoneE164: v.phoneE164, mergedIntoId: null } }))
      ) {
        fill.phoneE164 = v.phoneE164;
        fill.phoneRaw = input.phone;
      }
      if (!person.city && input.city) fill.city = input.city;
      if (Object.keys(fill).length) {
        person = await tx.person.update({ where: { id: person.id }, data: fill });
        contactChanged = true;
      }
    }
    if (contactChanged) await this.duplicates.detectFor(tx, person.id, now);

    // 4. Lead: one active lead per person per brand.
    let lead = await this.activeLead(tx, brandId, person.id);
    let classification:
      | 'NEW_LEAD'
      | 'EXISTING_PERSON'
      | 'EXISTING_LEAD'
      | 'CROSS_CHANNEL_DUPLICATE'
      | 'RETURNING_LEAD';
    if (lead) {
      if (origin.duplicatePolicy === 'SKIP_EXISTING') {
        return {
          outcome: 'SKIPPED_EXISTING',
          leadId: lead.id,
          leadNumber: lead.leadNumber,
          warnings: v.warnings,
        };
      }
      const last = await tx.enquiry.findFirst({
        where: { leadId: lead.id },
        orderBy: { receivedAt: 'desc' },
        select: { channel: true, receivedAt: true },
      });
      classification =
        last &&
        last.channel !== origin.channel &&
        Math.abs(receivedAt.getTime() - last.receivedAt.getTime()) <= CROSS_CHANNEL_WINDOW_MS
          ? 'CROSS_CHANNEL_DUPLICATE'
          : 'EXISTING_LEAD';
      lead = await tx.lead.update({
        where: { id: lead.id },
        data: {
          enquiryCount: { increment: 1 },
          lastEnquiryAt: receivedAt > lead.lastEnquiryAt ? receivedAt : lead.lastEnquiryAt,
          ...(lead.courseId ? {} : { courseId: v.courseId ?? null }),
        },
      });
    } else {
      const previous = await tx.lead.findFirst({
        where: { brandId, personId: person.id },
        orderBy: { createdAt: 'desc' },
      });
      classification = previous ? 'RETURNING_LEAD' : knownPerson ? 'EXISTING_PERSON' : 'NEW_LEAD';
      lead = await tx.lead.create({
        data: {
          organizationId,
          brandId,
          personId: person.id,
          leadNumber: await this.nextLeadNumber(tx, organizationId),
          courseId: v.courseId ?? null,
          previousLeadId: previous?.id ?? null,
          firstEnquiryAt: receivedAt,
          lastEnquiryAt: receivedAt,
        },
      });
      // Phase 10: a lost lead waiting for recovery is superseded by the fresh enquiry.
      if (previous?.status === 'LOST')
        await cancelRecoveryOnReturn(tx, previous.id, lead.leadNumber, now);
    }

    // 5. Immutable attribution record.
    const source = origin.sourceId
      ? await tx.leadSource.findUnique({ where: { id: origin.sourceId } })
      : null;
    const enquiry = await tx.enquiry.create({
      data: {
        organizationId,
        brandId,
        leadId: lead.id,
        personId: person.id,
        classification,
        channel: origin.channel,
        sourceId: source?.id ?? null,
        campaignId: v.campaignId ?? null,
        courseId: v.courseId ?? null,
        dedupKey,
        externalId: input.externalId,
        receivedAt,
        submittedName: input.name,
        submittedPhone: input.phone,
        submittedEmail: input.email,
        courseText: input.course ?? input.courseCode,
        city: input.city,
        message: input.message,
        utmSource: input.utm_source,
        utmMedium: input.utm_medium,
        utmCampaign: input.utm_campaign,
        utmTerm: input.utm_term,
        utmContent: input.utm_content,
        landingPage: input.landingPage,
        referrer: input.referrer,
        adId: input.adId,
        adsetId: input.adsetId,
        formId: input.formId,
        isPaid: source?.isPaid ?? ['META_ADS', 'GOOGLE_ADS'].includes(origin.channel),
        consentMarketing: input.consentMarketing,
        consentText: input.consentText,
        consentAt: input.consentMarketing !== undefined ? receivedAt : null,
        importId: origin.importId ?? null,
        createdById: origin.createdById ?? null,
        extra: (origin.extra ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });

    const created =
      classification !== 'EXISTING_LEAD' && classification !== 'CROSS_CHANNEL_DUPLICATE';
    await tx.outboxEvent.create({
      data: {
        organizationId,
        type: created ? 'lead.created' : 'enquiry.received',
        aggregateType: 'lead',
        aggregateId: lead.id,
        payload: {
          leadId: lead.id,
          enquiryId: enquiry.id,
          brandId,
          classification,
          channel: origin.channel,
        },
      },
    });
    await this.audit.record(tx, {
      organizationId,
      brandId,
      actorUserId: origin.createdById ?? null,
      action: created ? 'lead.created' : 'lead.enquiry_added',
      entityType: 'lead',
      entityId: lead.id,
      after: {
        leadNumber: lead.leadNumber,
        enquiryId: enquiry.id,
        classification,
        channel: origin.channel,
      },
    });
    return {
      outcome: created ? 'CREATED_LEAD' : 'ADDED_ENQUIRY',
      leadId: lead.id,
      leadNumber: lead.leadNumber,
      enquiryId: enquiry.id,
      warnings: v.warnings,
    };
  }

  private async validate(
    tx: Tx,
    brand: { id: string; country: 'IN' | 'AE' },
    input: LeadInput,
  ): Promise<Validated | { errors: FieldIssue[]; warnings: FieldIssue[] }> {
    const errors: FieldIssue[] = [];
    const warnings: FieldIssue[] = [];
    const name = input.name?.trim();
    if (!name) errors.push({ field: 'name', message: 'Name is required' });
    const phone = normalizePhone(input.phone, brand.country);
    const email = normalizeEmail(input.email);
    if (phone.issue) errors.push(phone.issue);
    if (email.issue) errors.push(email.issue);
    if (!input.phone?.trim() && !input.email?.trim())
      errors.push({ field: 'phone', message: 'A phone number or email address is required' });
    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : this.clock.now();
    if (receivedAt.getTime() > this.clock.now().getTime() + 5 * 60_000)
      errors.push({ field: 'receivedAt', message: 'Enquiry time is in the future' });

    // Course and campaign are best-effort: unknown values are kept as text, not rejected.
    let courseId: string | undefined;
    if (input.courseId || input.courseCode) {
      const course = await tx.course.findFirst({
        where: {
          brandId: brand.id,
          ...(input.courseId
            ? { id: input.courseId }
            : { code: input.courseCode!.trim().toUpperCase() }),
        },
      });
      if (course) courseId = course.id;
      else
        warnings.push({ field: 'course', message: 'Course not found in this brand; kept as text' });
    }
    let campaignId: string | undefined;
    if (input.campaignId || input.utm_campaign) {
      const campaign = await tx.campaign.findFirst({
        where: {
          brandId: brand.id,
          ...(input.campaignId ? { id: input.campaignId } : { utmCampaign: input.utm_campaign }),
        },
      });
      if (campaign) campaignId = campaign.id;
      else if (input.campaignId)
        warnings.push({
          field: 'campaignId',
          message: 'Campaign not found in this brand; ignored',
        });
    }
    if (errors.length) return { errors, warnings };
    return {
      name: name!,
      phoneE164: phone.e164,
      email: email.email,
      courseId,
      campaignId,
      receivedAt,
      warnings,
    };
  }

  /** Exact phone, else exact email. Contacts of merged people resolve to the surviving person. */
  private async findPerson(tx: Tx, v: { phoneE164?: string; email?: string }) {
    const activeFirst = [
      { mergedIntoId: { sort: 'asc' as const, nulls: 'first' as const } },
      { createdAt: 'asc' as const },
    ];
    let found = v.phoneE164
      ? await tx.person.findFirst({ where: { phoneE164: v.phoneE164 }, orderBy: activeFirst })
      : null;
    if (!found && v.email)
      found = await tx.person.findFirst({ where: { email: v.email }, orderBy: activeFirst });
    for (let hops = 0; found?.mergedIntoId && hops < 10; hops++) {
      found = await tx.person.findUnique({ where: { id: found.mergedIntoId } });
    }
    return found;
  }

  private activeLead(tx: Tx, brandId: string, personId: string) {
    return tx.lead.findFirst({
      where: { brandId, personId, status: { in: ['OPEN', 'ON_HOLD', 'IN_RECOVERY'] } },
    });
  }

  private async nextLeadNumber(tx: Tx, organizationId: string): Promise<string> {
    const [row] = await tx.$queryRaw<Array<{ value: bigint }>>`
      INSERT INTO org_counters (organization_id, name, value) VALUES (${organizationId}::uuid, 'lead', 1)
      ON CONFLICT (organization_id, name) DO UPDATE SET value = org_counters.value + 1
      RETURNING value`;
    return `L-${String(row.value).padStart(6, '0')}`;
  }
}
