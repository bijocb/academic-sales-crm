import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { Target } from '@prisma/client';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { forbidden } from '../common/errors';
import { Db } from '../db/db.service';
import { ReportsService } from '../reports/reports.service';
import { TargetsService } from '../reports/targets.service';
import { computeInsights, type Insight, type SourceRow, type TargetRow } from './rules';

export interface InsightQuery {
  from?: string;
  to?: string;
  brandId?: string;
  teamId?: string;
}

const METRIC_LABEL: Record<string, string> = {
  ASSIGNED: 'Assigned leads',
  CONTACTED: 'Contacted leads',
  COUNSELLING: 'Counselling sessions',
  ADMISSIONS: 'Admissions',
  REVENUE: 'Net revenue',
  COLLECTIONS: 'Collections',
};

/** Team-level report access or above (executives only see their own numbers and get no insights). */
export function isManager(p: OrgPrincipal): boolean {
  const s = p.authz.scope('report.read');
  return s.all || s.brandIds.length > 0 || s.teamIds.length > 0 || s.branchIds.length > 0;
}

const day = (iso: string) => DateTime.fromISO(iso, { zone: 'UTC' });
const shift = (iso: string, days: number) => day(iso).plus({ days }).toISODate()!;

/**
 * Management insights (A-051): the report figures of a period and of the previous period of the same length, run
 * through the pure rules in rules.ts. Everything is read through the report engine, so the caller's scope applies.
 */
@Injectable()
export class InsightsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly reports: ReportsService,
    private readonly targets: TargetsService,
  ) {}

  /** Today's date in the brand's (else the organization's) time zone. */
  async today(p: OrgPrincipal, brandId?: string): Promise<string> {
    const tz = await this.db.tenant(p.organizationId, async (tx) =>
      brandId
        ? (await tx.brand.findUniqueOrThrow({ where: { id: brandId }, select: { timezone: true } }))
            .timezone
        : (
            await tx.organization.findUniqueOrThrow({
              where: { id: p.organizationId },
              select: { timezone: true },
            })
          ).timezone,
    );
    return DateTime.fromJSDate(this.clock.now(), { zone: tz }).toISODate()!;
  }

  async compute(p: OrgPrincipal, q: InsightQuery) {
    if (!isManager(p))
      throw forbidden(
        'Insights are for team leaders and management (your reports show your own numbers)',
      );
    const today = await this.today(p, q.brandId);
    const to = q.to ?? today;
    const from = q.from ?? shift(to, -6);
    const days = Math.round(day(to).diff(day(from), 'days').days) + 1;
    const prevTo = shift(from, -1);
    const prevFrom = shift(prevTo, -(days - 1));
    const base = { brandId: q.brandId, teamId: q.teamId, mine: 'false' as const };
    const cur = await this.reports.insightFigures(p, { ...base, from, to });
    const prev = await this.reports.insightFigures(p, { ...base, from: prevFrom, to: prevTo });
    const targets = await this.targetsInScope(p, q, today, cur.ctx.scope);
    const src = (rows: typeof cur.sources): SourceRow[] =>
      rows.map((r) => ({
        key: r.key,
        label: r.label,
        leadsCreated: r.leadsCreated,
        admissions: { confirmed: r.admissions.confirmed },
        spend: 'spend' in r ? r.spend : undefined,
      }));
    const insights: Insight[] = computeInsights({
      current: cur.metrics,
      previous: prev.metrics,
      executives: cur.executives,
      sources: [
        { kind: 'source', current: src(cur.sources), previous: src(prev.sources) },
        { kind: 'campaign', current: src(cur.campaigns), previous: src(prev.campaigns) },
      ],
      targets,
    });
    return {
      period: { from, to },
      previous: { from: prevFrom, to: prevTo },
      generatedAt: this.clock.now().toISOString(),
      counts: {
        high: insights.filter((i) => i.severity === 'HIGH').length,
        medium: insights.filter((i) => i.severity === 'MEDIUM').length,
      },
      insights,
      // Headline figures for summaries (aggregates only).
      headline: {
        leadsCreated: cur.metrics.leadsCreated,
        contactRatePct: cur.metrics.contactRate.pct,
        firstResponsePct: cur.metrics.firstResponse.pct,
        admissions: cur.metrics.admissions.confirmed,
        previousAdmissions: prev.metrics.admissions.confirmed,
        overdueTasks: cur.metrics.overdueTasks,
      },
    };
  }

  /** Targets running today that fall inside the caller's report scope, with achieved values. */
  async targetsInScope(
    p: OrgPrincipal,
    q: InsightQuery,
    today: string,
    known?: { all: boolean; brandIds: string[]; userIds: Set<string> | null },
  ): Promise<TargetRow[]> {
    if (!isManager(p)) throw forbidden();
    const scope =
      known ??
      (await this.reports.scopeOf(p, {
        from: today,
        to: today,
        brandId: q.brandId,
        teamId: q.teamId,
        mine: 'false',
      }));
    const list = (await this.targets.list(p, {
      periodStart: today,
      periodEnd: today,
      ...(q.brandId ? { brandId: q.brandId } : {}),
    })) as Array<Target & { achieved: bigint }>;
    const myTeams = new Set(p.authz.scope('report.read').teamIds);
    const brandOk = (b: string | null) => !!b && (scope.all || scope.brandIds.includes(b));
    const inScope = (t: Target) => {
      if (q.teamId) return t.teamId === q.teamId || (!!t.userId && !!scope.userIds?.has(t.userId));
      if (scope.userIds === null)
        return t.scope === 'ORGANIZATION' ? scope.all && !q.brandId : brandOk(t.brandId);
      if (t.scope === 'TEAM') return !!t.teamId && myTeams.has(t.teamId);
      if (t.scope === 'USER') return !!t.userId && scope.userIds.has(t.userId);
      return false;
    };
    const rows = list.filter(inScope);
    if (!rows.length) return [];
    const names = await this.db.tenant(p.organizationId, async (tx) => {
      const ids = (k: 'brandId' | 'teamId' | 'userId') => [
        ...new Set(rows.map((r) => r[k]).filter((x): x is string => !!x)),
      ];
      const [b, t, u] = await Promise.all([
        tx.brand.findMany({
          where: { id: { in: ids('brandId') } },
          select: { id: true, name: true },
        }),
        tx.team.findMany({
          where: { id: { in: ids('teamId') } },
          select: { id: true, name: true },
        }),
        tx.user.findMany({
          where: { id: { in: ids('userId') } },
          select: { id: true, name: true },
        }),
      ]);
      return new Map([...b, ...t, ...u].map((x) => [x.id, x.name]));
    });
    const todayD = day(today);
    return rows.map((t) => {
      const start = DateTime.fromJSDate(t.periodStart, { zone: 'UTC' });
      const end = DateTime.fromJSDate(t.periodEnd, { zone: 'UTC' });
      const total = end.diff(start, 'days').days + 1;
      const gone = todayD.diff(start, 'days').days + 1;
      const who =
        (t.userId && names.get(t.userId)) ||
        (t.teamId && names.get(t.teamId)) ||
        (t.brandId && names.get(t.brandId)) ||
        'Organization';
      return {
        id: t.id,
        label: `${METRIC_LABEL[t.metric] ?? t.metric} target — ${who}`,
        metric: t.metric,
        value: t.value,
        achieved: t.achieved,
        currency: t.currency,
        elapsed: Math.max(0, Math.min(1, gone / total)),
      };
    });
  }
}
