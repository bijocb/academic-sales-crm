import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LeadListQuerySchema, ManualLeadSchema, z } from '@crm/contracts';
import type { OrgPrincipal } from '../auth/principal';
import { forbidden, notFound } from '../common/errors';
import { pageArgs } from '../common/scope';
import { Db, Tx } from '../db/db.service';
import { IntakeService } from './intake.service';
import { maskEmail, maskPhone } from './normalize';

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
          q.status ? { status: q.status } : {},
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

  async get(p: OrgPrincipal, id: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const vis = await this.visibility(tx, p);
      const lead = vis
        ? await tx.lead.findFirst({
            where: { AND: [{ id }, vis] },
            include: {
              person: true,
              course: { select: { id: true, name: true, code: true } },
              enquiries: {
                orderBy: { receivedAt: 'desc' },
                include: {
                  source: { select: { id: true, name: true } },
                  campaign: { select: { id: true, name: true } },
                  course: { select: { id: true, name: true } },
                },
              },
            },
          })
        : null;
      if (!lead) throw notFound('Lead');
      const full = this.canSeeFullPii(p, lead.brandId);
      return {
        ...lead,
        person: this.presentPerson(p, lead.brandId, lead.person),
        enquiries: lead.enquiries.map((e) => ({
          ...e,
          submittedPhone: full ? e.submittedPhone : maskPhone(e.submittedPhone),
          submittedEmail: full ? e.submittedEmail : maskEmail(e.submittedEmail),
        })),
      };
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
