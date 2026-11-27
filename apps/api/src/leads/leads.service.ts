import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LeadListQuerySchema, ManualLeadSchema, z } from '@crm/contracts';
import type { OrgPrincipal } from '../auth/principal';
import { AuditService } from '../audit/audit.service';
import { Clock } from '../common/clock';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { pageArgs } from '../common/scope';
import { Db, Tx } from '../db/db.service';
import { IntakeService } from './intake.service';
import { FieldIssue, maskEmail, maskPhone, normalizeEmail, normalizePhone } from './normalize';
import { DuplicateDetector } from './duplicate-detector';
import { nameKey } from './duplicate-rules';

/**
 * Lead visibility (backend-enforced):
 * - lead.read at organization/brand scope → all leads of those brands
 * - lead.read at branch/team scope → leads owned by members of those teams (owners arrive in Phase 6)
 * - lead.read_own → leads the user owns or personally entered
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly db: Db,
    private readonly intake: IntakeService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly detector: DuplicateDetector,
  ) {}

  private async visibility(tx: Tx, p: OrgPrincipal): Promise<Prisma.LeadWhereInput | null> {
    const s = p.authz.scope('lead.read');
    if (s.all) return {};
    const or: Prisma.LeadWhereInput[] = [];
    if (s.brandIds.length) or.push({ brandId: { in: s.brandIds } });
    if (s.branchIds.length || s.teamIds.length) {
      const members = await tx.teamMember.findMany({
        where: {
          leftAt: null,
          team: { OR: [{ id: { in: s.teamIds } }, { branchId: { in: s.branchIds } }] },
        },
        select: { userId: true },
      });
      if (members.length) or.push({ ownerId: { in: [...new Set(members.map((m) => m.userId))] } });
    }
    if (p.authz.has('lead.read_own')) {
      or.push({ ownerId: p.userId }, { enquiries: { some: { createdById: p.userId } } });
    }
    return or.length ? { OR: or } : null;
  }

  private canSeeFullPii(p: OrgPrincipal, brandId: string): boolean {
    const v = p.authz.visibleBrandIds('pii.view_full');
    return v.all || v.brandIds.includes(brandId);
  }

  private presentPerson(
    p: OrgPrincipal,
    brandId: string,
    person: {
      id: string;
      fullName: string;
      phoneE164: string | null;
      email: string | null;
      city: string | null;
      doNotContact: boolean;
    },
  ) {
    const full = this.canSeeFullPii(p, brandId);
    return {
      id: person.id,
      fullName: person.fullName,
      phone: full ? person.phoneE164 : maskPhone(person.phoneE164),
      email: full ? person.email : maskEmail(person.email),
      city: person.city,
      doNotContact: person.doNotContact,
      piiMasked: !full,
    };
  }

  async list(p: OrgPrincipal, q: z.infer<typeof LeadListQuerySchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const vis = await this.visibility(tx, p);
      if (!vis) throw forbidden();
      const where: Prisma.LeadWhereInput = {
        AND: [
          vis,
          q.brandId ? { brandId: q.brandId } : {},
          q.status ? { status: q.status } : { status: { not: 'MERGED' } },
          q.q
            ? {
                OR: [
                  { leadNumber: { contains: q.q, mode: 'insensitive' } },
                  { person: { fullName: { contains: q.q, mode: 'insensitive' } } },
                  { person: { phoneE164: { contains: q.q.replace(/[^\d+]/g, '') || q.q } } },
                  { person: { email: { contains: q.q.toLowerCase() } } },
                ],
              }
            : {},
        ],
      };
      const [rows, total] = await Promise.all([
        tx.lead.findMany({
          where,
          orderBy: { lastEnquiryAt: 'desc' },
          ...pageArgs(q.page, q.pageSize),
          include: {
            person: true,
            course: { select: { id: true, name: true } },
            enquiries: {
              orderBy: { receivedAt: 'asc' },
              take: 1,
              select: { channel: true, source: { select: { name: true } }, utmCampaign: true },
            },
          },
        }),
        tx.lead.count({ where }),
      ]);
      return {
        total,
        page: q.page,
        pageSize: q.pageSize,
        items: rows.map((l) => ({
          id: l.id,
          leadNumber: l.leadNumber,
          brandId: l.brandId,
          stage: l.stage,
          status: l.status,
          ownerId: l.ownerId,
          course: l.course,
          enquiryCount: l.enquiryCount,
          firstEnquiryAt: l.firstEnquiryAt,
          lastEnquiryAt: l.lastEnquiryAt,
          originalSource: l.enquiries[0]
            ? {
                channel: l.enquiries[0].channel,
                source: l.enquiries[0].source?.name ?? null,
                utmCampaign: l.enquiries[0].utmCampaign,
              }
            : null,
          person: this.presentPerson(p, l.brandId, l.person),
        })),
      };
    });
  }

  /** Lead ids whose history belongs to this lead (itself plus leads merged into it, transitively). */
  private async historyLeadIds(tx: Tx, id: string): Promise<string[]> {
    const ids = [id];
    let frontier = [id];
    for (let depth = 0; depth < 5 && frontier.length; depth++) {
      const next = await tx.lead.findMany({
        where: { mergedIntoLeadId: { in: frontier } },
        select: { id: true },
      });
      frontier = next.map((l) => l.id).filter((x) => !ids.includes(x));
      ids.push(...frontier);
    }
    return ids;
  }

  /** 404 unless the caller may see the lead. */
  async visibleLead(tx: Tx, p: OrgPrincipal, id: string) {
    const vis = await this.visibility(tx, p);
    const lead = vis
      ? await tx.lead.findFirst({
          where: { AND: [{ id }, vis] },
          include: { person: true, course: { select: { id: true, name: true, code: true } } },
        })
      : null;
    if (!lead) throw notFound('Lead');
    return lead;
  }

  async get(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.visibleLead(tx, p, id);
      const ids = await this.historyLeadIds(tx, id);
      const enquiries = await tx.enquiry.findMany({
        where: { leadId: { in: ids } },
        orderBy: { receivedAt: 'desc' },
        include: {
          source: { select: { id: true, name: true } },
          campaign: { select: { id: true, name: true } },
          course: { select: { id: true, name: true } },
        },
      });
      const full = this.canSeeFullPii(p, lead.brandId);
      const [owner, mergedInto, mergedLeads, openSuggestions] = await Promise.all([
        lead.ownerId
          ? tx.user.findUnique({ where: { id: lead.ownerId }, select: { id: true, name: true } })
          : null,
        lead.mergedIntoLeadId
          ? tx.lead.findUnique({
              where: { id: lead.mergedIntoLeadId },
              select: { id: true, leadNumber: true },
            })
          : null,
        tx.lead.findMany({
          where: { id: { in: ids.filter((x) => x !== id) } },
          select: { id: true, leadNumber: true },
        }),
        tx.duplicateCandidate.count({
          where: {
            status: 'OPEN',
            OR: [{ personAId: lead.personId }, { personBId: lead.personId }],
          },
        }),
      ]);
      const original = enquiries[enquiries.length - 1];
      return {
        ...lead,
        person: this.presentPerson(p, lead.brandId, lead.person),
        owner,
        mergedInto,
        mergedLeads,
        openDuplicateSuggestions: openSuggestions,
        originalAttribution: original
          ? {
              channel: original.channel,
              source: original.source,
              campaign: original.campaign,
              utmSource: original.utmSource,
              utmMedium: original.utmMedium,
              utmCampaign: original.utmCampaign,
              landingPage: original.landingPage,
              receivedAt: original.receivedAt,
              isPaid: original.isPaid,
            }
          : null,
        canEdit: this.canEdit(p, lead.brandId),
        enquiries: enquiries.map((e) => ({
          ...e,
          submittedPhone: full ? e.submittedPhone : maskPhone(e.submittedPhone),
          submittedEmail: full ? e.submittedEmail : maskEmail(e.submittedEmail),
        })),
      };
    });
  }

  canEdit(p: OrgPrincipal, brandId: string): boolean {
    const v = p.authz.visibleBrandIds('lead.edit');
    return v.all || v.brandIds.includes(brandId);
  }

  /** One ordered feed: enquiries + lead events (notes, profile changes, merges…), newest first. */
  async timeline(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.visibleLead(tx, p, id);
      const ids = await this.historyLeadIds(tx, id);
      const [enquiries, events, activities] = await Promise.all([
        tx.enquiry.findMany({
          where: { leadId: { in: ids } },
          include: { source: { select: { name: true } } },
        }),
        tx.leadEvent.findMany({ where: { leadId: { in: ids } } }),
        tx.activity.findMany({ where: { leadId: { in: ids } } }),
      ]);
      const messages = new Map(
        (
          await tx.outboundMessage.findMany({
            where: { activityId: { in: activities.map((a) => a.id) } },
            select: { activityId: true, status: true, lastError: true },
          })
        ).map((m) => [m.activityId, m]),
      );
      const actorIds = [
        ...new Set(
          [...events, ...activities].map((e) => e.actorUserId).filter((x): x is string => !!x),
        ),
      ];
      const actors = new Map(
        (
          await tx.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true },
          })
        ).map((u) => [u.id, u.name]),
      );
      const full = this.canSeeFullPii(p, lead.brandId);
      const items = [
        ...enquiries.map((e) => ({
          id: e.id,
          type: 'ENQUIRY',
          at: e.receivedAt,
          leadId: e.leadId,
          actor: null as string | null,
          title: `${e.classification.replace(/_/g, ' ').toLowerCase()} via ${e.source?.name ?? e.channel}`,
          body: e.message,
          data: {
            channel: e.channel,
            courseText: e.courseText,
            utmCampaign: e.utmCampaign,
            submittedPhone: full ? e.submittedPhone : maskPhone(e.submittedPhone),
          },
        })),
        ...events.map((e) => ({
          id: e.id,
          type: e.type,
          at: e.occurredAt,
          leadId: e.leadId,
          actor: e.actorUserId ? (actors.get(e.actorUserId) ?? null) : null,
          title: e.type.replace(/_/g, ' ').toLowerCase(),
          body: e.body,
          data: e.data,
        })),
        ...activities.map((a) => {
          const m = messages.get(a.id);
          const label = { CALL: 'call', WHATSAPP: 'WhatsApp', EMAIL: 'email', SMS: 'SMS' }[a.type];
          const parts = [
            `${a.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} ${label}`,
            a.outcome ? a.outcome.replace(/_/g, ' ').toLowerCase() : null,
            a.durationSec != null ? `${Math.round(a.durationSec / 60)} min` : null,
            m ? m.status.toLowerCase() : null,
          ].filter(Boolean);
          return {
            id: a.id,
            type: a.type,
            at: a.occurredAt,
            leadId: a.leadId,
            actor: a.actorUserId ? (actors.get(a.actorUserId) ?? null) : null,
            title: parts.join(' · '),
            body: a.subject ? `${a.subject}\n${a.body ?? ''}` : a.body,
            data: {
              direction: a.direction,
              outcome: a.outcome,
              durationSec: a.durationSec,
              messageStatus: m?.status ?? null,
              error: m?.lastError ?? null,
            } as Record<string, unknown>,
          };
        }),
      ];
      return items.sort((x, y) => y.at.getTime() - x.at.getTime());
    });
  }

  async addNote(p: OrgPrincipal, id: string, body: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.visibleLead(tx, p, id);
      if (!this.canEdit(p, lead.brandId)) throw forbidden();
      return tx.leadEvent.create({
        data: {
          organizationId: p.organizationId,
          leadId: id,
          type: 'NOTE',
          actorUserId: p.userId,
          body,
          occurredAt: this.clock.now(),
        },
      });
    });
  }

  /** Edits the person's profile from a lead. Phone/email changes are checked against other people. */
  async updateProfile(
    p: OrgPrincipal,
    id: string,
    input: {
      fullName?: string;
      phone?: string | null;
      email?: string | null;
      city?: string | null;
      language?: string | null;
      courseId?: string | null;
    },
  ) {
    const now = this.clock.now();
    const result = await this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.visibleLead(tx, p, id);
      if (!this.canEdit(p, lead.brandId)) throw forbidden();
      if (lead.status === 'MERGED')
        throw badRequest('LEAD_MERGED', 'This lead was merged; edit the surviving lead instead');
      const brand = await tx.brand.findUniqueOrThrow({ where: { id: lead.brandId } });
      const person = lead.person;
      const data: Prisma.PersonUpdateInput = {};
      const issues: FieldIssue[] = [];
      if (input.fullName !== undefined) {
        data.fullName = input.fullName.trim();
        data.nameKey = nameKey(input.fullName);
      }
      if (input.phone !== undefined) {
        if (input.phone === null || input.phone.trim() === '') data.phoneE164 = null;
        else {
          const n = normalizePhone(input.phone, brand.country);
          if (n.issue) issues.push(n.issue);
          else if (n.e164 !== person.phoneE164) {
            const owner = await tx.person.findFirst({
              where: { phoneE164: n.e164, mergedIntoId: null, id: { not: person.id } },
            });
            // Returned (not thrown) so the suggestion below is committed before refusing the edit.
            if (owner) return { phoneConflict: { personId: person.id, ownerId: owner.id } };
            data.phoneE164 = n.e164;
            data.phoneRaw = input.phone;
          }
        }
      }
      if (input.email !== undefined) {
        if (input.email === null || input.email.trim() === '') data.email = null;
        else {
          const n = normalizeEmail(input.email);
          if (n.issue) issues.push(n.issue);
          else data.email = n.email;
        }
      }
      if (input.city !== undefined) data.city = input.city?.trim() || null;
      if (input.language !== undefined) data.language = input.language?.trim() || null;
      if (issues.length)
        throw badRequest('VALIDATION_ERROR', 'Profile could not be updated', issues);
      const nextPhone = data.phoneE164 !== undefined ? data.phoneE164 : person.phoneE164;
      const nextEmail = data.email !== undefined ? data.email : person.email;
      if (!nextPhone && !nextEmail)
        throw badRequest('CONTACT_REQUIRED', 'Keep at least a phone number or an email address');

      if (input.courseId !== undefined) {
        if (
          input.courseId &&
          !(await tx.course.findFirst({ where: { id: input.courseId, brandId: lead.brandId } }))
        )
          throw notFound('Course');
        await tx.lead.update({ where: { id }, data: { courseId: input.courseId } });
      }
      const after = Object.keys(data).length
        ? await tx.person.update({ where: { id: person.id }, data })
        : person;
      const changed = Object.keys(data).filter((k) => k !== 'nameKey' && k !== 'phoneRaw');
      if (changed.length || input.courseId !== undefined) {
        await tx.leadEvent.create({
          data: {
            organizationId: p.organizationId,
            leadId: id,
            type: 'PROFILE_UPDATED',
            actorUserId: p.userId,
            body: `Updated ${[...changed, ...(input.courseId !== undefined ? ['course'] : [])].join(', ')}`,
            occurredAt: now,
          },
        });
        await this.audit.record(tx, {
          organizationId: p.organizationId,
          brandId: lead.brandId,
          action: 'person.updated',
          entityType: 'person',
          entityId: person.id,
          before: person,
          after,
        });
        if (data.fullName || data.phoneE164 || data.email)
          await this.detector.detectFor(tx, person.id, now);
      }
      return { ok: true as const };
    });
    if ('phoneConflict' in result && result.phoneConflict) {
      const { personId, ownerId } = result.phoneConflict;
      await this.db.tenant(p.organizationId, (tx) =>
        this.raiseSamePhone(tx, p.organizationId, personId, ownerId, now),
      );
      throw conflict(
        'PHONE_BELONGS_TO_OTHER_PERSON',
        'This number belongs to another person. A duplicate suggestion has been created for review.',
      );
    }
    return { ok: true };
  }

  private async raiseSamePhone(tx: Tx, organizationId: string, x: string, y: string, now: Date) {
    const [a, b] = x < y ? [x, y] : [y, x];
    const existing = await tx.duplicateCandidate.findUnique({
      where: { personAId_personBId: { personAId: a, personBId: b } },
    });
    if (existing) {
      if (existing.status !== 'OPEN')
        await tx.duplicateCandidate.update({
          where: { id: existing.id },
          data: {
            status: 'OPEN',
            resolvedAt: null,
            resolvedById: null,
            reasons: [...new Set([...existing.reasons, 'SAME_PHONE'])],
            score: 1,
          },
        });
      return;
    }
    await tx.duplicateCandidate.create({
      data: {
        organizationId,
        personAId: a,
        personBId: b,
        score: 1,
        reasons: ['SAME_PHONE'],
        detectedAt: now,
      },
    });
  }

  /** Manual entry by staff: same pipeline as every other channel; invalid input is returned, not queued. */
  async createManual(p: OrgPrincipal, input: z.infer<typeof ManualLeadSchema>) {
    const v = p.authz.visibleBrandIds('lead.create');
    if (!v.all && !v.brandIds.includes(input.brandId)) throw notFound('Brand');
    const { brandId, sourceId, channel, ...lead } = input;
    if (sourceId) {
      const ok = await this.db.tenant(p.organizationId, (tx) =>
        tx.leadSource.findFirst({ where: { id: sourceId, brandId } }),
      );
      if (!ok) throw notFound('Lead source');
    }
    return this.intake.ingest(
      {
        organizationId: p.organizationId,
        brandId,
        channel,
        sourceId,
        createdById: p.userId,
        exceptionOnInvalid: false,
      },
      lead,
    );
  }
}
