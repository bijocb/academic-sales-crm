import { Injectable } from '@nestjs/common';
import { BREAKDOWNS, DRILLDOWN_METRICS, ReportFilterSchema, z } from '@crm/contracts';
import { DateTime } from 'luxon';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';

export type ReportFilter = z.infer<typeof ReportFilterSchema>;
type Breakdown = (typeof BREAKDOWNS)[number];
type DrillMetric = (typeof DRILLDOWN_METRICS)[number];

/** Dimensions every record carries, so totals, breakdowns and drill-downs are the same rows. */
interface Dims {
  leadId: string;
  brandId: string;
  courseId: string | null;
  sourceId: string | null;
  campaignId: string | null;
  userId: string | null;
}
interface Rec extends Dims {
  id: string;
  at: Date | null;
  amountMinor?: bigint;
  currency?: string;
  flags?: Record<string, boolean | number | string | null>;
}

interface Scope {
  all: boolean;
  brandIds: string[];
  /** null = no user restriction; otherwise only records attributed to these users. */
  userIds: Set<string> | null;
}

export interface ReportContext {
  tz: string;
  start: Date;
  end: Date;
  now: Date;
  scope: Scope;
  f: ReportFilter;
  /** Per-request cache of lead dimensions (filled by collect). */
  dims?: Map<string, LeadDim>;
}

interface LeadDim {
  brandId: string;
  courseId: string | null;
  sourceId: string | null;
  campaignId: string | null;
  ownerId: string | null;
  status: string;
  createdAt: Date;
}

const ACTIVE_LEAD = ['OPEN', 'ON_HOLD', 'IN_RECOVERY'];
/** Below this size a team average would reveal individual colleagues' numbers (D-008, ASSUMED). */
const MIN_TEAM_FOR_AVERAGE = 3;

/**
 * KPI engine (FR-017). Computes from the history tables; every KPI and its date basis is
 * defined in docs/KPI.md. See docs/plans/PHASE-13.md.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------- scope
  private async scopeFor(tx: Tx, p: OrgPrincipal, f: ReportFilter): Promise<Scope> {
    let scope: Scope;
    const s = p.authz.scope('report.read');
    if (
      f.mine === 'true' ||
      (!s.all && !s.brandIds.length && !s.teamIds.length && !s.branchIds.length)
    ) {
      // Own numbers only, in the brands where the user works.
      const leadBrands = p.authz.visibleBrandIds('lead.read_own');
      const read = p.authz.visibleBrandIds('lead.read');
      scope = {
        all: leadBrands.all || read.all,
        brandIds: [...new Set([...leadBrands.brandIds, ...read.brandIds])],
        userIds: new Set([p.userId]),
      };
      if (!scope.all && !scope.brandIds.length) throw forbidden();
    } else if (s.all || s.brandIds.length) {
      scope = { all: s.all, brandIds: s.brandIds, userIds: null };
    } else {
      // Team / branch level: the members of those teams, inside their brands.
      const teams = await tx.team.findMany({
        where: { OR: [{ id: { in: s.teamIds } }, { branchId: { in: s.branchIds } }] },
        select: { id: true, brandId: true },
      });
      const members = await tx.teamMember.findMany({
        where: { leftAt: null, teamId: { in: teams.map((t) => t.id) } },
        select: { userId: true },
      });
      scope = {
        all: false,
        brandIds: [...new Set(teams.map((t) => t.brandId))],
        userIds: new Set(members.map((m) => m.userId)),
      };
    }
    if (f.brandId) {
      if (!scope.all && !scope.brandIds.includes(f.brandId)) throw notFound('Brand');
      scope = { ...scope, all: false, brandIds: [f.brandId] };
    }
    if (f.teamId) {
      const members = await tx.teamMember.findMany({
        where: { teamId: f.teamId, leftAt: null },
        select: { userId: true },
      });
      const ids = members
        .map((m) => m.userId)
        .filter((u) => !scope.userIds || scope.userIds.has(u));
      scope = { ...scope, userIds: new Set(ids) };
    }
    if (f.userId) {
      if (scope.userIds && !scope.userIds.has(f.userId)) throw notFound('User');
      scope = { ...scope, userIds: new Set([f.userId]) };
    }
    return scope;
  }

  async context(tx: Tx, p: OrgPrincipal, f: ReportFilter): Promise<ReportContext> {
    const scope = await this.scopeFor(tx, p, f);
    const tz = f.brandId
      ? (await tx.brand.findUniqueOrThrow({ where: { id: f.brandId }, select: { timezone: true } }))
          .timezone
      : (
          await tx.organization.findUniqueOrThrow({
            where: { id: p.organizationId },
            select: { timezone: true },
          })
        ).timezone;
    return {
      tz,
      start: DateTime.fromISO(f.from, { zone: tz }).startOf('day').toJSDate(),
      end: DateTime.fromISO(f.to, { zone: tz }).plus({ days: 1 }).startOf('day').toJSDate(),
      now: this.clock.now(),
      scope,
      f,
    };
  }

  // ----------------------------------------------------------- dimensions
  /** Lead attributes + first-touch source/campaign (the original enquiry, D-004). */
  private async leadDims(tx: Tx, leadIds: string[], cache = new Map<string, LeadDim>()) {
    const ids = [...new Set(leadIds)].filter((id) => !cache.has(id));
    if (ids.length) {
      const [leads, first] = await Promise.all([
        tx.lead.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            brandId: true,
            courseId: true,
            ownerId: true,
            status: true,
            createdAt: true,
          },
        }),
        tx.$queryRaw<
          Array<{ lead_id: string; source_id: string | null; campaign_id: string | null }>
        >`
          SELECT DISTINCT ON (lead_id) lead_id, source_id, campaign_id FROM enquiries
          WHERE lead_id = ANY(${ids}::uuid[]) ORDER BY lead_id, received_at ASC`,
      ]);
      const f = new Map(first.map((r) => [r.lead_id, r]));
      for (const l of leads)
        cache.set(l.id, {
          brandId: l.brandId,
          courseId: l.courseId,
          ownerId: l.ownerId,
          status: l.status,
          createdAt: l.createdAt,
          sourceId: f.get(l.id)?.source_id ?? null,
          campaignId: f.get(l.id)?.campaign_id ?? null,
        });
    }
    return cache;
  }

  /** Owner of each lead at a moment in time, from the append-only assignment history. */
  private async ownerAt(tx: Tx, pairs: Array<{ leadId: string; at: Date }>) {
    const ids = [...new Set(pairs.map((x) => x.leadId))];
    const rows = ids.length
      ? await tx.leadAssignment.findMany({
          where: { leadId: { in: ids } },
          orderBy: [{ assignedAt: 'asc' }, { attemptNo: 'asc' }],
          select: { leadId: true, toUserId: true, assignedAt: true },
        })
      : [];
    const byLead = new Map<string, typeof rows>();
    for (const r of rows) byLead.set(r.leadId, [...(byLead.get(r.leadId) ?? []), r]);
    return (leadId: string, at: Date) => {
      let owner: string | null = null;
      for (const r of byLead.get(leadId) ?? []) if (r.assignedAt <= at) owner = r.toUserId;
      return owner;
    };
  }

  /** Applies brand scope and the lead-level filters; user scope applies to the attributed user. */
  private keep(ctx: ReportContext, r: Dims) {
    const { scope, f } = ctx;
    if (!scope.all && !scope.brandIds.includes(r.brandId)) return false;
    if (scope.userIds && (!r.userId || !scope.userIds.has(r.userId))) return false;
    if (f.courseId && r.courseId !== f.courseId) return false;
    if (f.sourceId && r.sourceId !== f.sourceId) return false;
    if (f.campaignId && r.campaignId !== f.campaignId) return false;
    return true;
  }

  private async build<T extends { leadId: string }>(
    tx: Tx,
    ctx: ReportContext,
    rows: T[],
    map: (
      row: T,
      lead: {
        brandId: string;
        courseId: string | null;
        sourceId: string | null;
        campaignId: string | null;
        ownerId: string | null;
        status: string;
      },
    ) => Omit<Rec, keyof Dims> & { userId: string | null; courseId?: string | null },
  ): Promise<Rec[]> {
    const dims = await this.leadDims(
      tx,
      rows.map((r) => r.leadId),
      ctx.dims,
    );
    const out: Rec[] = [];
    for (const row of rows) {
      const d = dims.get(row.leadId);
      if (!d || d.status === 'MERGED') continue;
      const m = map(row, d);
      const rec: Rec = {
        leadId: row.leadId,
        brandId: d.brandId,
        courseId: m.courseId !== undefined ? m.courseId : d.courseId,
        sourceId: d.sourceId,
        campaignId: d.campaignId,
        ...m,
      };
      if (this.keep(ctx, rec)) out.push(rec);
    }
    return out;
  }

  // -------------------------------------------------------------- records
  /** Every KPI's underlying records for the period (definitions in docs/KPI.md). */
  async collect(tx: Tx, base: ReportContext) {
    const ctx: ReportContext = { ...base, dims: new Map() };
    const inPeriod = { gte: ctx.start, lt: ctx.end };
    // Scope pushed into the queries (the same rules are re-checked per record by keep()).
    const b = ctx.scope.all ? {} : { brandId: { in: ctx.scope.brandIds } };
    const users = ctx.scope.userIds ? [...ctx.scope.userIds] : null;
    const u = (col: string) => (users ? { [col]: { in: users } } : {});

    const leads = await tx.lead.findMany({
      where: { ...b, ...u('ownerId'), createdAt: inPeriod, status: { not: 'MERGED' } },
      select: { id: true, createdAt: true, ownerId: true },
    });
    const leadsCreated = await this.build(
      tx,
      ctx,
      leads.map((l) => ({ ...l, leadId: l.id })),
      (l) => ({ id: l.id, at: l.createdAt, userId: l.ownerId }),
    );

    const assignments = await tx.leadAssignment.findMany({
      where: { ...b, assignedAt: inPeriod },
      orderBy: [{ assignedAt: 'asc' }, { attemptNo: 'asc' }],
    });
    const assignedAll = await this.build(tx, ctx, assignments, (a) => ({
      id: a.id,
      at: a.assignedAt,
      userId: a.toUserId,
      flags: { type: a.type },
    }));
    const seenPair = new Set<string>();
    const assigned = assignedAll.filter((r) => {
      const k = `${r.leadId}:${r.userId}`;
      if (seenPair.has(k)) return false;
      seenPair.add(k);
      return true;
    });
    const reassigned = await this.build(
      tx,
      ctx,
      assignments.filter((a) => a.fromUserId),
      (a) => ({ id: a.id, at: a.assignedAt, userId: a.toUserId, flags: { type: a.type } }),
    );

    const calls = await tx.activity.findMany({
      where: { ...b, type: 'CALL', outcome: 'CONNECTED', occurredAt: inPeriod },
      orderBy: { occurredAt: 'asc' },
    });
    const contactedAll = await this.build(tx, ctx, calls, (c) => ({
      id: c.id,
      at: c.occurredAt,
      userId: c.actorUserId,
    }));
    const seenContact = new Set<string>();
    const contacted = contactedAll.filter((r) => {
      const k = `${r.leadId}:${r.userId}`;
      if (seenContact.has(k)) return false;
      seenContact.add(k);
      return true;
    });

    // Contact-rate cohort: leads assigned in the period; numerator = a connected call at any time after assignment.
    const cohortIds = [...new Set(assigned.map((r) => r.leadId))];
    const connectedEver = new Set(
      (cohortIds.length
        ? await tx.activity.findMany({
            where: { leadId: { in: cohortIds }, type: 'CALL', outcome: 'CONNECTED' },
            select: { leadId: true },
          })
        : []
      ).map((x) => x.leadId),
    );

    const sla = await tx.slaInstance.findMany({
      where: { ...b, ...u('ownerId'), startedAt: inPeriod, state: { not: 'CANCELLED' } },
    });
    const slaStarted = await this.build(tx, ctx, sla, (s) => ({
      id: s.id,
      at: s.startedAt,
      userId: s.ownerId,
      flags: {
        resolved: s.state === 'RESOLVED',
        compliant: s.state === 'RESOLVED' && !s.breachedAt,
        breached: !!s.breachedAt,
        workingMinutes: s.workingMinutes,
        calendarMinutes: s.calendarMinutes,
      },
    }));

    const tasks = await tx.task.findMany({ where: { ...b, ...u('ownerId'), status: 'OPEN' } });
    const openTasks = await this.build(tx, ctx, tasks, (t) => ({
      id: t.id,
      at: t.dueAt,
      userId: t.ownerId,
      flags: { overdue: t.dueAt < ctx.now },
    }));

    const openLeadRows = await tx.lead.findMany({
      where: { ...b, ...u('ownerId'), status: { in: ACTIVE_LEAD as never } },
      select: { id: true, ownerId: true, createdAt: true },
    });
    const openLeads = await this.build(
      tx,
      ctx,
      openLeadRows.map((l) => ({ ...l, leadId: l.id })),
      (l) => ({
        id: l.id,
        at: l.createdAt,
        userId: l.ownerId,
        flags: { ageDays: Math.floor((ctx.now.getTime() - l.createdAt.getTime()) / 86_400_000) },
      }),
    );

    const statusRows = await tx.leadStatusHistory.findMany({
      where: { ...b, occurredAt: inPeriod },
      orderBy: { occurredAt: 'asc' },
    });
    const owner = await this.ownerAt(tx, [
      ...statusRows.map((s) => ({ leadId: s.leadId, at: s.occurredAt })),
    ]);
    const lostRows = statusRows.filter(
      (s) =>
        (s.toStatus === 'LOST' || s.toStatus === 'CLOSED_LOST') &&
        (s.fromStatus === 'OPEN' || s.fromStatus === 'ON_HOLD'),
    );
    const lost = await this.build(tx, ctx, lostRows, (s) => ({
      id: s.id,
      at: s.occurredAt,
      userId: owner(s.leadId, s.occurredAt),
      flags: { reason: s.reasonCode },
    }));
    const recoveredRows = statusRows.filter(
      (s) => s.toStatus === 'OPEN' && s.reasonCode === 'RECOVERED',
    );
    const recovered = await this.build(tx, ctx, recoveredRows, (s) => ({
      id: s.id,
      at: s.occurredAt,
      userId: owner(s.leadId, s.occurredAt),
    }));

    const sessions = await tx.appointment.findMany({
      where: { ...b, ...u('counsellorId'), status: 'COMPLETED', startsAt: inPeriod },
    });
    const counselling = await this.build(tx, ctx, sessions, (a) => ({
      id: a.id,
      at: a.startsAt,
      userId: a.counsellorId,
    }));

    const quotes = await tx.quotation.findMany({
      where: { ...b, status: 'ACCEPTED', decidedAt: inPeriod },
    });
    const qOwner = await this.ownerAt(
      tx,
      quotes.map((q) => ({ leadId: q.leadId, at: q.decidedAt! })),
    );
    const quotationsAccepted = await this.build(tx, ctx, quotes, (q) => ({
      id: q.id,
      at: q.decidedAt,
      userId: qOwner(q.leadId, q.decidedAt!),
      courseId: q.courseId,
    }));

    // Admissions are event-dated (A-007c): confirmations and cancellations counted in the period they happen.
    const admHist = await tx.admissionStatusHistory.findMany({
      where: { occurredAt: inPeriod, toStatus: { in: ['CONFIRMED', 'CANCELLED_REFUNDED'] } },
    });
    const admissions = admHist.length
      ? await tx.admission.findMany({
          where: { id: { in: [...new Set(admHist.map((h) => h.admissionId))] } },
        })
      : [];
    const admById = new Map(admissions.map((a) => [a.id, a]));
    const aOwner = await this.ownerAt(
      tx,
      admHist.map((h) => ({ leadId: admById.get(h.admissionId)!.leadId, at: h.occurredAt })),
    );
    const firstContact = await this.firstContacts(
      tx,
      admissions.map((a) => a.leadId),
    );
    const admissionRows = admHist.map((h) => ({
      ...h,
      leadId: admById.get(h.admissionId)!.leadId,
    }));
    const admissionsConfirmed = await this.build(
      tx,
      ctx,
      admissionRows.filter((h) => h.toStatus === 'CONFIRMED'),
      (h) => ({
        id: h.admissionId,
        at: h.occurredAt,
        userId: aOwner(h.leadId, h.occurredAt),
        courseId: admById.get(h.admissionId)!.courseId,
        flags: {
          firstContactUserId: firstContact.get(h.leadId) ?? null,
          admissionNumber: admById.get(h.admissionId)!.admissionNumber,
        },
      }),
    );
    // First-contact credit (D-005, A-005a): same records, attributed to the first connected caller.
    const admissionsFirstContact = await this.build(
      tx,
      ctx,
      admissionRows.filter((h) => h.toStatus === 'CONFIRMED'),
      (h) => ({
        id: h.admissionId,
        at: h.occurredAt,
        userId: firstContact.get(h.leadId) ?? null,
        courseId: admById.get(h.admissionId)!.courseId,
      }),
    );
    const admissionsCancelled = await this.build(
      tx,
      ctx,
      admissionRows.filter((h) => h.toStatus === 'CANCELLED_REFUNDED'),
      (h) => ({
        id: h.admissionId,
        at: h.occurredAt,
        userId: aOwner(h.leadId, admById.get(h.admissionId)!.confirmedAt ?? h.occurredAt),
        courseId: admById.get(h.admissionId)!.courseId,
      }),
    );

    // Money: payments on receipt date, refunds on payout date (A-007c); closing executive attribution.
    const pays = await tx.payment.findMany({ where: { ...b, receivedAt: inPeriod } });
    const refundEvents = await tx.refundEvent.findMany({
      where: { type: 'PAID', occurredAt: inPeriod },
    });
    const refunds = refundEvents.length
      ? await tx.refund.findMany({ where: { id: { in: refundEvents.map((e) => e.refundId) } } })
      : [];
    const moneyAdmissions = await tx.admission.findMany({
      where: {
        id: {
          in: [
            ...new Set([...pays.map((x) => x.admissionId), ...refunds.map((r) => r.admissionId)]),
          ],
        },
      },
    });
    const mAdm = new Map(moneyAdmissions.map((a) => [a.id, a]));
    const mOwner = await this.ownerAt(
      tx,
      moneyAdmissions.map((a) => ({ leadId: a.leadId, at: a.confirmedAt ?? ctx.now })),
    );
    const closer = (admissionId: string) => {
      const a = mAdm.get(admissionId)!;
      return mOwner(a.leadId, a.confirmedAt ?? ctx.now);
    };
    const payments = await this.build(
      tx,
      ctx,
      pays.map((x) => ({ ...x, leadId: mAdm.get(x.admissionId)!.leadId })),
      (x) => ({
        id: x.id,
        at: x.receivedAt,
        userId: closer(x.admissionId),
        courseId: mAdm.get(x.admissionId)!.courseId,
        amountMinor: x.amountMinor,
        currency: x.currency,
        flags: { receiptNumber: x.receiptNumber, method: x.method },
      }),
    );
    const refundById = new Map(refunds.map((r) => [r.id, r]));
    const refundsPaid = await this.build(
      tx,
      ctx,
      refundEvents.map((e) => ({
        ...e,
        leadId: mAdm.get(refundById.get(e.refundId)!.admissionId)!.leadId,
      })),
      (e) => {
        const r = refundById.get(e.refundId)!;
        return {
          id: r.id,
          at: e.occurredAt,
          userId: closer(r.admissionId),
          courseId: mAdm.get(r.admissionId)!.courseId,
          amountMinor: r.amountMinor,
          currency: r.currency,
        };
      },
    );

    const stageRows = await tx.leadStageHistory.findMany({
      where: { ...b, occurredAt: inPeriod, direction: 'FORWARD' },
    });
    const sOwner = await this.ownerAt(
      tx,
      stageRows.map((s) => ({ leadId: s.leadId, at: s.occurredAt })),
    );
    const stageEntries = await this.build(tx, ctx, stageRows, (s) => ({
      id: s.id,
      at: s.occurredAt,
      userId: sOwner(s.leadId, s.occurredAt),
      flags: { stage: s.toStage },
    }));

    return {
      leadsCreated,
      assigned,
      contacted,
      cohort: {
        assigned: cohortIds.length,
        connected: cohortIds.filter((id) => connectedEver.has(id)).length,
      },
      slaStarted,
      openTasks,
      openLeads,
      reassigned,
      lost,
      recovered,
      counselling,
      quotationsAccepted,
      admissionsConfirmed,
      admissionsFirstContact,
      admissionsCancelled,
      payments,
      refundsPaid,
      stageEntries,
    };
  }

  private async firstContacts(tx: Tx, leadIds: string[]) {
    if (!leadIds.length) return new Map<string, string | null>();
    const rows = await tx.activity.findMany({
      where: { leadId: { in: leadIds }, type: 'CALL', outcome: 'CONNECTED' },
      orderBy: { occurredAt: 'asc' },
      select: { leadId: true, actorUserId: true },
    });
    const m = new Map<string, string | null>();
    for (const r of rows) if (!m.has(r.leadId)) m.set(r.leadId, r.actorUserId);
    return m;
  }

  // -------------------------------------------------------------- summary
  private distinctLeads = (rs: Rec[]) => new Set(rs.map((r) => r.leadId)).size;
  private money(rs: Rec[]) {
    const m: Record<string, bigint> = {};
    for (const r of rs) m[r.currency!] = (m[r.currency!] ?? 0n) + r.amountMinor!;
    return m;
  }

  private metrics(d: Awaited<ReturnType<ReportsService['collect']>>) {
    const collected = this.money(d.payments);
    const refunded = this.money(d.refundsPaid);
    const currencies = [...new Set([...Object.keys(collected), ...Object.keys(refunded)])].sort();
    const resolved = d.slaStarted.filter((s) => s.flags!.resolved);
    const avg = (xs: Array<number | null>) => {
      const v = xs.filter((x): x is number => typeof x === 'number');
      return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
    };
    const confirmed = d.admissionsConfirmed.length;
    const cancelled = d.admissionsCancelled.length;
    return {
      leadsCreated: d.leadsCreated.length,
      assigned: this.distinctLeads(d.assigned),
      contacted: this.distinctLeads(d.contacted),
      contactRate: {
        cohort: d.cohort.assigned,
        connected: d.cohort.connected,
        pct: d.cohort.assigned
          ? Math.round((1000 * d.cohort.connected) / d.cohort.assigned) / 10
          : null,
      },
      firstResponse: {
        started: d.slaStarted.length,
        withinTarget: d.slaStarted.filter((s) => s.flags!.compliant).length,
        breached: d.slaStarted.filter((s) => s.flags!.breached).length,
        pct: d.slaStarted.length
          ? Math.round(
              (1000 * d.slaStarted.filter((s) => s.flags!.compliant).length) / d.slaStarted.length,
            ) / 10
          : null,
        avgWorkingMinutes: avg(resolved.map((s) => s.flags!.workingMinutes as number | null)),
        avgCalendarMinutes: avg(resolved.map((s) => s.flags!.calendarMinutes as number | null)),
      },
      openTasks: d.openTasks.length,
      overdueTasks: d.openTasks.filter((t) => t.flags!.overdue).length,
      openLeads: d.openLeads.length,
      reassigned: d.reassigned.length,
      lost: this.distinctLeads(d.lost),
      recovered: this.distinctLeads(d.recovered),
      counselling: d.counselling.length,
      quotationsAccepted: d.quotationsAccepted.length,
      admissions: {
        confirmed,
        cancelled,
        net: confirmed - cancelled,
        firstContact: d.admissionsFirstContact.length,
      },
      revenue: currencies.map((c) => ({
        currency: c,
        collectedMinor: collected[c] ?? 0n,
        refundedMinor: refunded[c] ?? 0n,
        netMinor: (collected[c] ?? 0n) - (refunded[c] ?? 0n),
      })),
    };
  }

  private disclosure(ctx: ReportContext) {
    return {
      from: ctx.f.from,
      to: ctx.f.to,
      timezone: ctx.tz,
      dateBasis: {
        leadsCreated: 'lead created',
        assigned: 'assignment',
        contacted: 'connected call',
        firstResponse: 'clock started',
        admissions: 'confirmation / cancellation event (A-007c)',
        revenue: 'payment received / refund paid out',
        snapshots: 'now (open leads, open and overdue tasks, outstanding)',
      },
      attribution:
        'source and campaign: first touch (original enquiry); executive: owner at the event (closing) and first connected caller (first contact, D-005)',
      merged: 'merged leads excluded; each lead counted once per metric',
      currencies: 'never added together (A-012)',
    };
  }

  // ------------------------------------------------- personal performance
  /**
   * The signed-in user's own performance report (dashboard, D-008): current vs previous period of the same length,
   * daily trend, personal funnel, and the anonymous average of their team(s). Same KPI engine as the reports.
   */
  me(p: OrgPrincipal, f: ReportFilter) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const ctx = await this.context(tx, p, { ...f, mine: 'true' });
      const from = DateTime.fromISO(f.from, { zone: ctx.tz });
      const days = Math.round(DateTime.fromISO(f.to, { zone: ctx.tz }).diff(from, 'days').days) + 1;
      const prevF = {
        ...f,
        from: from.minus({ days }).toISODate()!,
        to: from.minus({ days: 1 }).toISODate()!,
      };
      const prevCtx = await this.context(tx, p, { ...prevF, mine: 'true' });
      const [d, prev] = [await this.collect(tx, ctx), await this.collect(tx, prevCtx)];
      const current = this.metrics(d);

      // Daily trend in the report time zone.
      const keys = Array.from({ length: days }, (_, i) => from.plus({ days: i }).toISODate()!);
      const day = (at: Date | null) =>
        at ? DateTime.fromJSDate(at, { zone: ctx.tz }).toISODate() : null;
      const perDay = (rs: Rec[], distinct: boolean) => {
        const m = new Map<string, Set<string> | number>();
        for (const r of rs) {
          const k = day(r.at);
          if (!k) continue;
          if (distinct) {
            const set = (m.get(k) as Set<string> | undefined) ?? new Set<string>();
            set.add(r.leadId);
            m.set(k, set);
          } else m.set(k, ((m.get(k) as number | undefined) ?? 0) + 1);
        }
        return (k: string) => {
          const v = m.get(k);
          return v === undefined ? 0 : typeof v === 'number' ? v : v.size;
        };
      };
      const [asg, con, adm] = [
        perDay(d.assigned, true),
        perDay(d.contacted, true),
        perDay(d.admissionsConfirmed, false),
      ];
      const trend = keys.map((k) => ({
        date: k,
        assigned: asg(k),
        contacted: con(k),
        admissions: adm(k),
      }));
      const counselled = new Set(
        d.stageEntries
          .filter((e) => e.flags!.stage === 'COUNSELLING_COMPLETED')
          .map((e) => e.leadId),
      ).size;
      const funnel = [
        { step: 'ASSIGNED', leads: current.assigned },
        { step: 'CONTACTED', leads: current.contacted },
        { step: 'COUNSELLING_COMPLETED', leads: counselled },
        { step: 'QUOTATION_ACCEPTED', leads: current.quotationsAccepted },
        { step: 'ADMISSION_CONFIRMED', leads: current.admissions.confirmed },
      ];
      return {
        ...this.disclosure(ctx),
        previousPeriod: { from: prevF.from, to: prevF.to },
        current,
        previous: this.metrics(prev),
        trend,
        funnel,
        teamAverage: await this.teamAverage(tx, p, ctx),
      };
    });
  }

  /** Anonymous team average: totals of the user's team(s) ÷ current members; hidden for teams under 3 people. */
  private async teamAverage(tx: Tx, p: OrgPrincipal, ctx: ReportContext) {
    const mine = await tx.teamMember.findMany({
      where: { userId: p.userId, leftAt: null },
      select: { teamId: true },
    });
    if (!mine.length) return null;
    const teams = await tx.team.findMany({
      where: { id: { in: mine.map((m) => m.teamId) } },
      select: { brandId: true },
    });
    const members = new Set(
      (
        await tx.teamMember.findMany({
          where: { teamId: { in: mine.map((m) => m.teamId) }, leftAt: null },
          select: { userId: true },
        })
      ).map((m) => m.userId),
    );
    if (members.size < MIN_TEAM_FOR_AVERAGE)
      return { members: members.size, hidden: true as const };
    const t = this.metrics(
      await this.collect(tx, {
        ...ctx,
        scope: {
          all: false,
          brandIds: [...new Set(teams.map((x) => x.brandId))],
          userIds: members,
        },
      }),
    );
    const n = members.size;
    const avg = (v: number) => Math.round((10 * v) / n) / 10;
    return {
      members: n,
      hidden: false as const,
      assigned: avg(t.assigned),
      contacted: avg(t.contacted),
      counselling: avg(t.counselling),
      quotationsAccepted: avg(t.quotationsAccepted),
      admissionsConfirmed: avg(t.admissions.confirmed),
      admissionsNet: avg(t.admissions.net),
      lost: avg(t.lost),
      overdueTasks: avg(t.overdueTasks),
      openLeads: avg(t.openLeads),
      // Rates are the team's own rate, not an average of averages.
      contactRatePct: t.contactRate.pct,
      firstResponsePct: t.firstResponse.pct,
      avgWorkingMinutes: t.firstResponse.avgWorkingMinutes,
      revenue: t.revenue.map((r) => ({
        currency: r.currency,
        netMinor: r.netMinor / BigInt(n),
      })),
    };
  }

  summary(p: OrgPrincipal, f: ReportFilter) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const ctx = await this.context(tx, p, f);
      const d = await this.collect(tx, ctx);
      const outstanding = await this.outstanding(tx, ctx);
      return {
        ...this.disclosure(ctx),
        metrics: { ...this.metrics(d), outstanding },
        funnel: this.funnel(d),
      };
    });
  }

  /** Snapshot: confirmed admissions' net fee − net collections, per currency (A-043). */
  private async outstanding(tx: Tx, ctx: ReportContext) {
    const adm = await tx.admission.findMany({
      where: {
        status: 'CONFIRMED',
        ...(ctx.scope.all ? {} : { brandId: { in: ctx.scope.brandIds } }),
      },
    });
    const kept = await this.build(tx, ctx, adm, (a) => ({
      id: a.id,
      at: a.confirmedAt,
      userId: null,
      courseId: a.courseId,
    }));
    // Outstanding is not attributed to a person, so the user scope does not narrow it (team/own views show none).
    const ids = ctx.scope.userIds ? [] : kept.map((k) => k.id);
    if (!ids.length) return [];
    // A fixed number of grouped queries, however many admissions are in scope.
    const plans = await tx.feePlan.findMany({ where: { admissionId: { in: ids } } });
    const planIds = plans.map((x) => x.id);
    const [adj, paid, refunds] = await Promise.all([
      tx.feeAdjustment.groupBy({
        by: ['planId'],
        where: { planId: { in: planIds } },
        _sum: { amountMinor: true },
      }),
      tx.payment.groupBy({
        by: ['planId'],
        where: { planId: { in: planIds } },
        _sum: { amountMinor: true },
      }),
      tx.refund.findMany({
        where: { admissionId: { in: ids } },
        select: { id: true, admissionId: true, amountMinor: true },
      }),
    ]);
    const paidOut = new Set(
      (refunds.length
        ? await tx.refundEvent.findMany({
            where: { refundId: { in: refunds.map((r) => r.id) }, type: 'PAID' },
            select: { refundId: true },
          })
        : []
      ).map((e) => e.refundId),
    );
    const adjBy = new Map(adj.map((a) => [a.planId, a._sum.amountMinor ?? 0n]));
    const paidBy = new Map(paid.map((a) => [a.planId, a._sum.amountMinor ?? 0n]));
    const refundedBy = new Map<string, bigint>();
    for (const r of refunds)
      if (paidOut.has(r.id))
        refundedBy.set(r.admissionId, (refundedBy.get(r.admissionId) ?? 0n) + r.amountMinor);
    const out: Record<string, bigint> = {};
    for (const plan of plans) {
      const due =
        plan.baseAmountMinor +
        (adjBy.get(plan.id) ?? 0n) -
        ((paidBy.get(plan.id) ?? 0n) - (refundedBy.get(plan.admissionId) ?? 0n));
      out[plan.currency] = (out[plan.currency] ?? 0n) + due;
    }
    return Object.entries(out).map(([currency, outstandingMinor]) => ({
      currency,
      outstandingMinor,
    }));
  }

  private funnel(d: Awaited<ReturnType<ReportsService['collect']>>) {
    const stages = [
      'CONTACTED',
      'QUALIFIED',
      'INTERESTED',
      'COUNSELLING_COMPLETED',
      'COURSE_SELECTED',
      'PAYMENT_PENDING',
      'ADMISSION_CONFIRMED',
    ];
    return [
      { stage: 'NEW_ENQUIRY', leads: d.leadsCreated.length },
      ...stages.map((s) => ({
        stage: s,
        leads: new Set(d.stageEntries.filter((e) => e.flags!.stage === s).map((e) => e.leadId))
          .size,
      })),
    ];
  }

  // ------------------------------------------------------------ breakdown
  breakdown(p: OrgPrincipal, f: ReportFilter, by: Breakdown) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const ctx = await this.context(tx, p, f);
      const d = await this.collect(tx, ctx);
      const rows = await this.rowsFor(tx, ctx, d, by);
      return { ...this.disclosure(ctx), by, rows };
    });
  }

  /** The caller's effective report scope for a filter (who and which brands the numbers cover). */
  scopeOf(p: OrgPrincipal, f: ReportFilter) {
    return this.db.tenant(p.organizationId, (tx) => this.scopeFor(tx, p, f));
  }

  /**
   * One period's figures for management insights (A-051): the summary metrics and the executive, source and
   * campaign breakdowns from a single collection, under the caller's report scope.
   */
  insightFigures(p: OrgPrincipal, f: ReportFilter) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const ctx = await this.context(tx, p, f);
      const d = await this.collect(tx, ctx);
      return {
        ctx,
        metrics: this.metrics(d),
        executives: await this.rowsFor(tx, ctx, d, 'executive'),
        sources: await this.rowsFor(tx, ctx, d, 'source'),
        campaigns: await this.rowsFor(tx, ctx, d, 'campaign'),
      };
    });
  }

  private async rowsFor(
    tx: Tx,
    ctx: ReportContext,
    d: Awaited<ReturnType<ReportsService['collect']>>,
    by: Breakdown,
  ) {
    const key = (r: Rec) =>
      (by === 'executive'
        ? r.userId
        : by === 'course'
          ? r.courseId
          : by === 'source'
            ? r.sourceId
            : by === 'campaign'
              ? r.campaignId
              : r.brandId) ?? 'none';
    const groups = new Map<string, Rec[]>();
    const add = (metric: string, rs: Rec[]) => {
      for (const r of rs) {
        const k = `${key(r)}|${metric}`;
        groups.set(k, [...(groups.get(k) ?? []), r]);
      }
    };
    const sets: Record<string, Rec[]> = {
      leadsCreated: d.leadsCreated,
      assigned: d.assigned,
      contacted: d.contacted,
      slaStarted: d.slaStarted,
      openTasks: d.openTasks,
      openLeads: d.openLeads,
      lost: d.lost,
      recovered: d.recovered,
      counselling: d.counselling,
      admissionsConfirmed: d.admissionsConfirmed,
      admissionsFirstContact: d.admissionsFirstContact,
      admissionsCancelled: d.admissionsCancelled,
      payments: d.payments,
      refundsPaid: d.refundsPaid,
    };
    for (const [m, rs] of Object.entries(sets)) add(m, rs);
    const keys = [...new Set([...groups.keys()].map((k) => k.split('|')[0]))];
    const labels = await this.labels(
      tx,
      by,
      keys.filter((k) => k !== 'none'),
    );
    const spend = by === 'campaign' || by === 'source' ? await this.spend(tx, ctx) : null;
    const rows = keys.map((k) => {
      const g = (m: string) => groups.get(`${k}|${m}`) ?? [];
      const sla = g('slaStarted');
      const collected = this.money(g('payments'));
      const refunded = this.money(g('refundsPaid'));
      const currencies = [...new Set([...Object.keys(collected), ...Object.keys(refunded)])].sort();
      const leadsCreated = g('leadsCreated').length;
      const confirmed = g('admissionsConfirmed').length;
      const spent = spend
        ? by === 'campaign'
          ? spend.byCampaign.get(k)
          : spend.bySource.get(k)
        : undefined;
      const ages = g('openLeads').map((r) => r.flags!.ageDays as number);
      return {
        key: k,
        label:
          k === 'none' ? (by === 'executive' ? 'Unassigned' : 'Not set') : (labels.get(k) ?? k),
        leadsCreated,
        assigned: this.distinctLeads(g('assigned')),
        contacted: this.distinctLeads(g('contacted')),
        firstResponse: {
          started: sla.length,
          withinTarget: sla.filter((s) => s.flags!.compliant).length,
        },
        openLeads: g('openLeads').length,
        avgOpenLeadAgeDays: ages.length
          ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length)
          : null,
        overdueTasks: g('openTasks').filter((t) => t.flags!.overdue).length,
        lost: this.distinctLeads(g('lost')),
        recovered: this.distinctLeads(g('recovered')),
        counselling: g('counselling').length,
        admissions: {
          confirmed,
          cancelled: g('admissionsCancelled').length,
          firstContact: g('admissionsFirstContact').length,
        },
        revenue: currencies.map((c) => ({
          currency: c,
          netMinor: (collected[c] ?? 0n) - (refunded[c] ?? 0n),
        })),
        ...(spent
          ? {
              spend: spent,
              cpl: spent.map((s) => ({
                currency: s.currency,
                minor: leadsCreated ? s.amountMinor / BigInt(leadsCreated) : null,
              })),
              cpa: spent.map((s) => ({
                currency: s.currency,
                minor: confirmed ? s.amountMinor / BigInt(confirmed) : null,
              })),
            }
          : {}),
      };
    });
    rows.sort((x, y) =>
      x.key === 'none' ? 1 : y.key === 'none' ? -1 : x.label.localeCompare(y.label),
    );
    return rows;
  }

  private async labels(tx: Tx, by: Breakdown, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const pick = async () => {
      switch (by) {
        case 'executive':
          return tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
        case 'course':
          return tx.course.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          });
        case 'source':
          return tx.leadSource.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          });
        case 'campaign':
          return tx.campaign.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          });
        default:
          return tx.brand.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          });
      }
    };
    return new Map((await pick()).map((x) => [x.id, x.name]));
  }

  /** Manual ad spend for the months touching the period (A-044), per campaign and per source. */
  private async spend(tx: Tx, ctx: ReportContext) {
    const first = DateTime.fromJSDate(ctx.start, { zone: ctx.tz }).startOf('month').toISODate()!;
    const last = DateTime.fromJSDate(ctx.end, { zone: ctx.tz })
      .minus({ days: 1 })
      .startOf('month')
      .toISODate()!;
    const rows = await tx.adSpend.findMany({
      where: {
        month: { gte: new Date(`${first}T00:00:00.000Z`), lte: new Date(`${last}T00:00:00.000Z`) },
        ...(ctx.scope.all ? {} : { brandId: { in: ctx.scope.brandIds } }),
        ...(ctx.f.campaignId ? { campaignId: ctx.f.campaignId } : {}),
      },
    });
    const campaigns = await tx.campaign.findMany({
      where: { id: { in: rows.map((r) => r.campaignId) } },
      select: { id: true, sourceId: true },
    });
    const src = new Map(campaigns.map((c) => [c.id, c.sourceId ?? 'none']));
    const fold = (
      m: Map<string, Array<{ currency: string; amountMinor: bigint }>>,
      k: string,
      r: { currency: string; amountMinor: bigint },
    ) => {
      const list = m.get(k) ?? [];
      const e = list.find((x) => x.currency === r.currency);
      if (e) e.amountMinor += r.amountMinor;
      else list.push({ currency: r.currency, amountMinor: r.amountMinor });
      m.set(k, list);
    };
    const byCampaign = new Map<string, Array<{ currency: string; amountMinor: bigint }>>();
    const bySource = new Map<string, Array<{ currency: string; amountMinor: bigint }>>();
    for (const r of rows) {
      fold(byCampaign, r.campaignId, r);
      fold(bySource, src.get(r.campaignId) ?? 'none', r);
    }
    return { byCampaign, bySource };
  }

  // ------------------------------------------------------------ drill-down
  drilldown(p: OrgPrincipal, f: ReportFilter, metric: DrillMetric) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const ctx = await this.context(tx, p, f);
      const d = await this.collect(tx, ctx);
      const pick: Record<DrillMetric, Rec[]> = {
        leadsCreated: d.leadsCreated,
        assigned: d.assigned.filter(
          (r, i, all) => all.findIndex((x) => x.leadId === r.leadId) === i,
        ),
        contacted: d.contacted.filter(
          (r, i, all) => all.findIndex((x) => x.leadId === r.leadId) === i,
        ),
        lost: d.lost.filter((r, i, all) => all.findIndex((x) => x.leadId === r.leadId) === i),
        recovered: d.recovered.filter(
          (r, i, all) => all.findIndex((x) => x.leadId === r.leadId) === i,
        ),
        admissionsConfirmed: d.admissionsConfirmed,
        payments: d.payments,
        overdueTasks: d.openTasks.filter((t) => t.flags!.overdue),
      };
      const rows = pick[metric];
      const leads = await tx.lead.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.leadId))] } },
        select: { id: true, leadNumber: true, person: { select: { fullName: true } } },
      });
      const lm = new Map(leads.map((l) => [l.id, l]));
      const users = await tx.user.findMany({
        where: { id: { in: rows.map((r) => r.userId).filter((x): x is string => !!x) } },
        select: { id: true, name: true },
      });
      const um = new Map(users.map((u) => [u.id, u.name]));
      return {
        ...this.disclosure(ctx),
        metric,
        rows: rows.map((r) => ({
          id: r.id,
          leadId: r.leadId,
          leadNumber: lm.get(r.leadId)?.leadNumber,
          name: lm.get(r.leadId)?.person.fullName,
          at: r.at,
          user: r.userId ? (um.get(r.userId) ?? null) : null,
          amountMinor: r.amountMinor ?? null,
          currency: r.currency ?? null,
          detail: r.flags ?? null,
        })),
      };
    });
  }

  /** Raw collection for other modules (targets, incentives) under the same scope rules. */
  async collectFor(tx: Tx, p: OrgPrincipal, f: ReportFilter) {
    const ctx = await this.context(tx, p, f);
    return { ctx, data: await this.collect(tx, ctx) };
  }

  /** For callers that already hold a context (no principal needed, e.g. incentive runs). */
  async collectWith(tx: Tx, ctx: ReportContext) {
    return this.collect(tx, ctx);
  }
}
