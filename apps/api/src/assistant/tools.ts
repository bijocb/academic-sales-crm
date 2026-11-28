import { z } from '@crm/contracts';
import { BREAKDOWNS } from '@crm/contracts';
import type { OrgPrincipal } from '../auth/principal';
import { badRequest } from '../common/errors';
import { Db } from '../db/db.service';
import { InsightsService } from '../insights/insights.service';
import { ReportsService } from '../reports/reports.service';
import type { ToolSpec } from './provider';

/**
 * The only things the assistant can look at (A-052): scoped report figures, run as the asking user. No tool returns
 * lead-level data (no names, phones, e-mails or notes of students) — only counts, rates, money totals and the names of
 * brands, teams, executives, courses, sources and campaigns.
 */

const date = { type: 'string', description: 'Date YYYY-MM-DD' };
const nullableId = (what: string) => ({
  type: ['string', 'null'],
  description: `${what} id from list_scope, or null for all in scope`,
});
const obj = (properties: Record<string, unknown>): ToolSpec['input_schema'] => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'list_scope',
    description:
      "Today's date, the time zone, and the brands and teams the user can report on (with ids). Call this first when the question names a brand, a team or a relative period.",
    input_schema: obj({}),
  },
  {
    name: 'get_summary',
    description:
      'Headline KPIs for a date range: leads created, assigned, contacted, contact rate, first response within SLA, open and overdue tasks, lost, recovered, counselling, admissions, revenue per currency (minor units), and the funnel.',
    input_schema: obj({
      from: date,
      to: date,
      brandId: nullableId('Brand'),
      teamId: nullableId('Team'),
    }),
  },
  {
    name: 'get_breakdown',
    description:
      'The same KPIs per executive, course, source, campaign or brand for a date range. Source and campaign rows include ad spend, cost per lead and cost per admission when spend was entered.',
    input_schema: obj({
      by: { type: 'string', enum: [...BREAKDOWNS] },
      from: date,
      to: date,
      brandId: nullableId('Brand'),
      teamId: nullableId('Team'),
    }),
  },
  {
    name: 'get_insights',
    description:
      'Rule-based insights comparing a period with the previous period of the same length: drops in first response, contact rate and admissions, executives needing support, costly sources, targets behind pace, old open leads. Each has evidence and a suggested action. Dates default to the last 7 days.',
    input_schema: obj({
      from: { type: ['string', 'null'], description: 'YYYY-MM-DD or null' },
      to: { type: ['string', 'null'], description: 'YYYY-MM-DD or null' },
      brandId: nullableId('Brand'),
      teamId: nullableId('Team'),
    }),
  },
  {
    name: 'get_targets',
    description:
      'Targets running today in scope: metric, target value, achieved so far and how much of the period has passed.',
    input_schema: obj({ brandId: nullableId('Brand') }),
  },
];

const isoDate = z.iso.date();
const id = z.uuid().nullable();
const Range = z
  .object({ from: isoDate, to: isoDate, brandId: id, teamId: id })
  .refine((v) => v.to >= v.from, 'to must be on or after from')
  .refine(
    (v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366,
    'At most one year per question',
  );
const ARGS = {
  list_scope: z.object({}),
  get_summary: Range,
  get_breakdown: z.intersection(Range, z.object({ by: z.enum(BREAKDOWNS) })),
  get_insights: z.object({
    from: isoDate.nullable(),
    to: isoDate.nullable(),
    brandId: id,
    teamId: id,
  }),
  get_targets: z.object({ brandId: id }),
};

const opt = (v: string | null) => v ?? undefined;
const MAX_ROWS = 60;

export class AssistantTools {
  constructor(
    private readonly db: Db,
    private readonly reports: ReportsService,
    private readonly insights: InsightsService,
  ) {}

  /** Runs one tool call as the asking user. Invalid arguments come back to the model as a tool error. */
  async run(p: OrgPrincipal, name: string, raw: Record<string, unknown>): Promise<unknown> {
    if (!(name in ARGS)) throw badRequest('UNKNOWN_TOOL', `Unknown tool ${name}`);
    const parsed = ARGS[name as keyof typeof ARGS].safeParse(raw);
    if (!parsed.success)
      throw badRequest('INVALID_TOOL_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
    const a = parsed.data as Record<string, string | null>;
    switch (name) {
      case 'list_scope':
        return this.scope(p);
      case 'get_summary': {
        const s = await this.reports.summary(p, {
          from: a.from!,
          to: a.to!,
          brandId: opt(a.brandId),
          teamId: opt(a.teamId),
          mine: 'false',
        });
        return { period: { from: a.from, to: a.to }, metrics: s.metrics, funnel: s.funnel };
      }
      case 'get_breakdown': {
        const b = await this.reports.breakdown(
          p,
          {
            from: a.from!,
            to: a.to!,
            brandId: opt(a.brandId),
            teamId: opt(a.teamId),
            mine: 'false',
          },
          a.by as (typeof BREAKDOWNS)[number],
        );
        return {
          period: { from: a.from, to: a.to },
          by: a.by,
          rows: b.rows.slice(0, MAX_ROWS),
          ...(b.rows.length > MAX_ROWS ? { truncatedRows: b.rows.length - MAX_ROWS } : {}),
        };
      }
      case 'get_insights':
        return this.insights.compute(p, {
          from: opt(a.from),
          to: opt(a.to),
          brandId: opt(a.brandId),
          teamId: opt(a.teamId),
        });
      case 'get_targets': {
        const today = await this.insights.today(p, opt(a.brandId));
        return this.insights.targetsInScope(p, { brandId: opt(a.brandId) }, today);
      }
    }
    return null;
  }

  private async scope(p: OrgPrincipal) {
    const s = p.authz.scope('report.read');
    const today = await this.insights.today(p);
    return this.db.tenant(p.organizationId, async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: p.organizationId },
        select: { name: true, timezone: true },
      });
      const teamScoped = !s.all && !s.brandIds.length;
      const teams = await tx.team.findMany({
        where: teamScoped
          ? { OR: [{ id: { in: s.teamIds } }, { branchId: { in: s.branchIds } }] }
          : s.all
            ? {}
            : { brandId: { in: s.brandIds } },
        select: { id: true, name: true, brandId: true },
        orderBy: { name: 'asc' },
      });
      const brandIds = s.all
        ? undefined
        : [...new Set([...s.brandIds, ...teams.map((t) => t.brandId)])];
      const brands = await tx.brand.findMany({
        where: brandIds ? { id: { in: brandIds } } : {},
        select: { id: true, name: true, timezone: true },
        orderBy: { name: 'asc' },
      });
      return {
        today,
        organization: org.name,
        timezone: org.timezone,
        level: s.all ? 'organization' : s.brandIds.length ? 'brand' : 'team',
        brands,
        teams,
      };
    });
  }
}
