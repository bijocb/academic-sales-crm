import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Lead, Person } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { DuplicateDetector } from './duplicate-detector';
import { nameKey } from './duplicate-rules';
import { maskEmail, maskPhone } from './normalize';

export type Side = 'A' | 'B';
export interface MergeInput {
  survivor: Side;
  fields: { fullName: Side; phone: Side; email: Side; city: Side };
  note?: string;
}

const ACTIVE = ['OPEN', 'ON_HOLD', 'IN_RECOVERY'] as const;
const isActive = (l: Lead) => (ACTIVE as readonly string[]).includes(l.status);

interface PlanItem {
  brandId: string;
  action: 'MERGE_INTO_SURVIVOR_LEAD' | 'MOVE_TO_SURVIVOR' | 'KEEP';
  leadId: string;
  leadNumber: string;
  intoLeadId?: string;
  intoLeadNumber?: string;
}

/** Duplicate review queue and safe person merge (FR-005). */
@Injectable()
export class DuplicatesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly detector: DuplicateDetector,
  ) {}

  /** A user may act on a pair only with lead.merge over every brand either person has leads in. */
  private allowed(p: OrgPrincipal, brandIds: string[]): boolean {
    if (p.authz.can('lead.merge')) return true;
    return brandIds.length > 0 && brandIds.every((b) => p.authz.can('lead.merge', { brandId: b }));
  }

  private async load(tx: Tx, candidateId: string) {
    const c = await tx.duplicateCandidate.findUnique({ where: { id: candidateId } });
    if (!c) return null;
    const people = await tx.person.findMany({
      where: { id: { in: [c.personAId, c.personBId] } },
      include: { leads: { orderBy: { createdAt: 'asc' } } },
    });
    const a = people.find((x) => x.id === c.personAId)!;
    const b = people.find((x) => x.id === c.personBId)!;
    return { c, a, b, brandIds: [...new Set([...a.leads, ...b.leads].map((l) => l.brandId))] };
  }

  private present(p: OrgPrincipal, person: Person & { leads: Lead[] }) {
    const v = p.authz.visibleBrandIds('pii.view_full');
    const full = v.all || person.leads.every((l) => v.brandIds.includes(l.brandId));
    return {
      id: person.id,
      fullName: person.fullName,
      phone: full ? person.phoneE164 : maskPhone(person.phoneE164),
      email: full ? person.email : maskEmail(person.email),
      city: person.city,
      createdAt: person.createdAt,
      mergedIntoId: person.mergedIntoId,
      leads: person.leads.map((l) => ({
        id: l.id,
        leadNumber: l.leadNumber,
        brandId: l.brandId,
        status: l.status,
        stage: l.stage,
        enquiryCount: l.enquiryCount,
        createdAt: l.createdAt,
      })),
    };
  }

  async list(p: OrgPrincipal, status: 'OPEN' | 'MERGED' | 'DISMISSED' = 'OPEN') {
    return this.db.tenant(p.organizationId, async (tx) => {
      const rows = await tx.duplicateCandidate.findMany({
        where: { status },
        orderBy: [{ score: 'desc' }, { detectedAt: 'desc' }],
        take: 200,
      });
      const out = [];
      for (const r of rows) {
        const d = await this.load(tx, r.id);
        if (!d || !this.allowed(p, d.brandIds)) continue;
        out.push({ ...r, personA: this.present(p, d.a), personB: this.present(p, d.b) });
      }
      return out;
    });
  }

  /** What a merge would do, without doing it. */
  async preview(p: OrgPrincipal, candidateId: string, survivor: Side = 'A') {
    return this.db.tenant(p.organizationId, async (tx) => {
      const d = await this.load(tx, candidateId);
      if (!d || !this.allowed(p, d.brandIds)) throw notFound('Duplicate suggestion');
      const [s, m] = survivor === 'A' ? [d.a, d.b] : [d.b, d.a];
      return {
        candidate: d.c,
        personA: this.present(p, d.a),
        personB: this.present(p, d.b),
        plan: this.plan(s.leads, m.leads),
      };
    });
  }

  /**
   * In each brand where both people have an active lead, the newer lead merges into the older
   * one. Every other lead of the merged person moves to the survivor. Enquiries never change.
   */
  private plan(survivorLeads: Lead[], mergedLeads: Lead[]): PlanItem[] {
    const items: PlanItem[] = [];
    for (const l of mergedLeads) {
      const target = isActive(l)
        ? survivorLeads.find((s) => s.brandId === l.brandId && isActive(s))
        : undefined;
      if (target) {
        // Keep the older lead (its number and original attribution come first).
        const [keep, fold] = target.createdAt <= l.createdAt ? [target, l] : [l, target];
        items.push({
          brandId: l.brandId,
          action: 'MERGE_INTO_SURVIVOR_LEAD',
          leadId: fold.id,
          leadNumber: fold.leadNumber,
          intoLeadId: keep.id,
          intoLeadNumber: keep.leadNumber,
        });
      } else {
        items.push({
          brandId: l.brandId,
          action: 'MOVE_TO_SURVIVOR',
          leadId: l.id,
          leadNumber: l.leadNumber,
        });
      }
    }
    return items;
  }

  async merge(p: OrgPrincipal, candidateId: string, input: MergeInput) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const d0 = await this.load(tx, candidateId);
      if (!d0 || !this.allowed(p, d0.brandIds)) throw notFound('Duplicate suggestion');
      if (d0.c.status !== 'OPEN')
        throw badRequest('SUGGESTION_CLOSED', 'This suggestion is already resolved');
      // Serialize against concurrent intake/merges touching either person.
      for (const id of [d0.c.personAId, d0.c.personBId].sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      }
      const d = (await this.load(tx, candidateId))!;
      if (d.a.mergedIntoId || d.b.mergedIntoId)
        throw conflict('ALREADY_MERGED', 'One of these people was already merged');
      if (!this.allowed(p, d.brandIds)) throw forbidden();

      const pick = { A: d.a, B: d.b };
      const survivor = pick[input.survivor];
      const merged = pick[input.survivor === 'A' ? 'B' : 'A'];
      const plan = this.plan(survivor.leads, merged.leads);
      const chosen = {
        fullName: pick[input.fields.fullName].fullName,
        phoneE164: pick[input.fields.phone].phoneE164 ?? survivor.phoneE164 ?? merged.phoneE164,
        phoneRaw: pick[input.fields.phone].phoneRaw ?? survivor.phoneRaw,
        email: pick[input.fields.email].email ?? survivor.email ?? merged.email,
        city: pick[input.fields.city].city ?? survivor.city ?? merged.city,
      };

      // 1. Retire the merged person first (frees its phone for the survivor under the partial unique index).
      await tx.person.update({
        where: { id: merged.id },
        data: { mergedIntoId: survivor.id, mergedAt: now },
      });
      await tx.person.update({
        where: { id: survivor.id },
        data: {
          ...chosen,
          nameKey: nameKey(chosen.fullName),
          doNotContact: survivor.doNotContact || merged.doNotContact,
        },
      });

      // 2. Leads.
      for (const item of plan) {
        if (item.action === 'MOVE_TO_SURVIVOR') {
          await tx.lead.update({ where: { id: item.leadId }, data: { personId: survivor.id } });
          await this.event(
            tx,
            p,
            item.leadId,
            'PERSON_MERGED',
            `Person record merged into ${chosen.fullName}`,
            { survivorPersonId: survivor.id, mergedPersonId: merged.id },
            now,
          );
          continue;
        }
        const fold = await tx.lead.findUniqueOrThrow({ where: { id: item.leadId } });
        const keep = await tx.lead.findUniqueOrThrow({ where: { id: item.intoLeadId! } });
        await tx.lead.update({
          where: { id: fold.id },
          data: { status: 'MERGED', mergedIntoLeadId: keep.id, personId: survivor.id },
        });
        await tx.lead.update({
          where: { id: keep.id },
          data: {
            personId: survivor.id,
            enquiryCount: keep.enquiryCount + fold.enquiryCount,
            firstEnquiryAt:
              fold.firstEnquiryAt < keep.firstEnquiryAt ? fold.firstEnquiryAt : keep.firstEnquiryAt,
            lastEnquiryAt:
              fold.lastEnquiryAt > keep.lastEnquiryAt ? fold.lastEnquiryAt : keep.lastEnquiryAt,
            courseId: keep.courseId ?? fold.courseId,
          },
        });
        await this.event(
          tx,
          p,
          keep.id,
          'LEAD_MERGED',
          `${fold.leadNumber} merged into this lead`,
          { mergedLeadId: fold.id },
          now,
        );
        await this.event(
          tx,
          p,
          fold.id,
          'LEAD_MERGED',
          `Merged into ${keep.leadNumber}`,
          { intoLeadId: keep.id },
          now,
        );
      }

      // 3. History, suggestion bookkeeping, events.
      const record = await tx.personMerge.create({
        data: {
          organizationId: p.organizationId,
          survivorId: survivor.id,
          mergedId: merged.id,
          candidateId,
          fieldChoices: input.fields,
          leadPlan: plan as unknown as Prisma.InputJsonValue,
          survivorBefore: JSON.parse(JSON.stringify(survivor)) as Prisma.InputJsonValue,
          mergedBefore: JSON.parse(JSON.stringify(merged)) as Prisma.InputJsonValue,
          note: input.note,
          mergedById: p.userId,
          mergedAt: now,
        },
      });
      await tx.duplicateCandidate.update({
        where: { id: candidateId },
        data: {
          status: 'MERGED',
          resolvedAt: now,
          resolvedById: p.userId,
          resolutionNote: input.note,
        },
      });
      await tx.duplicateCandidate.updateMany({
        where: {
          status: 'OPEN',
          id: { not: candidateId },
          OR: [{ personAId: merged.id }, { personBId: merged.id }],
        },
        data: {
          status: 'DISMISSED',
          resolvedAt: now,
          resolvedById: p.userId,
          resolutionNote: 'Superseded by merge',
        },
      });
      await this.detector.detectFor(tx, survivor.id, now);
      await tx.outboxEvent.create({
        data: {
          organizationId: p.organizationId,
          type: 'person.merged',
          aggregateType: 'person',
          aggregateId: survivor.id,
          payload: {
            mergeId: record.id,
            survivorId: survivor.id,
            mergedId: merged.id,
            plan,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        action: 'person.merged',
        entityType: 'person',
        entityId: survivor.id,
        before: { survivor, merged },
        after: { chosen, plan },
        reason: input.note,
      });
      return { mergeId: record.id, survivorId: survivor.id, mergedId: merged.id, plan };
    });
  }

  async dismiss(p: OrgPrincipal, candidateId: string, note: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const d = await this.load(tx, candidateId);
      if (!d || !this.allowed(p, d.brandIds)) throw notFound('Duplicate suggestion');
      if (d.c.status !== 'OPEN')
        throw badRequest('SUGGESTION_CLOSED', 'This suggestion is already resolved');
      const now = this.clock.now();
      const r = await tx.duplicateCandidate.update({
        where: { id: candidateId },
        data: {
          status: 'DISMISSED',
          resolvedAt: now,
          resolvedById: p.userId,
          resolutionNote: note,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        action: 'duplicate.dismissed',
        entityType: 'duplicate_candidate',
        entityId: candidateId,
        reason: note,
      });
      return r;
    });
  }

  /** Re-scan existing people (e.g. after an import). Returns number of new suggestions. */
  async scan(p: OrgPrincipal) {
    if (!p.authz.can('lead.merge'))
      throw forbidden('Scanning requires organization-wide merge permission');
    return this.db.tenant(
      p.organizationId,
      async (tx) => {
        const now = this.clock.now();
        const people = await tx.person.findMany({
          where: { mergedIntoId: null },
          select: { id: true, fullName: true, nameKey: true },
        });
        let created = 0;
        for (const person of people) {
          if (!person.nameKey)
            await tx.person.update({
              where: { id: person.id },
              data: { nameKey: nameKey(person.fullName) },
            });
        }
        for (const person of people) created += await this.detector.detectFor(tx, person.id, now);
        return { scanned: people.length, created };
      },
      { timeout: 60_000 },
    );
  }

  private event(
    tx: Tx,
    p: OrgPrincipal,
    leadId: string,
    type: string,
    body: string,
    data: Record<string, unknown>,
    at: Date,
  ) {
    return tx.leadEvent.create({
      data: {
        organizationId: p.organizationId,
        leadId,
        type,
        actorUserId: p.userId,
        body,
        data: data as Prisma.InputJsonValue,
        occurredAt: at,
      },
    });
  }
}
