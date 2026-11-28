import { Controller, Get, Param, ParseUUIDPipe, Patch, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AdSpendSchema,
  BreakdownQuerySchema,
  DrilldownQuerySchema,
  ExportQuerySchema,
  IncentiveRuleSchema,
  IncentiveRunSchema,
  ReportFilterSchema,
  TargetQuerySchema,
  TargetSchema,
  UpdateTargetSchema,
  z,
} from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { badRequest, forbidden } from '../common/errors';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { Db } from '../db/db.service';
import { ReportsService } from './reports.service';
import { TargetsService } from './targets.service';

const BrandQ = z.object({ brandId: z.uuid() });
const OptBrandQ = z.object({ brandId: z.uuid().optional() });

/** CSV cell: quoted, and formula-looking values neutralised (CSV injection). */
const cell = (v: unknown) => {
  let s =
    v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const csv = (header: string[], rows: unknown[][]) =>
  [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

@ApiTags('reports')
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly targets: TargetsService,
    private readonly audit: AuditService,
    private readonly db: Db,
  ) {}

  @Get('reports/summary')
  summary(
    @CurrentPrincipal() p: Principal,
    @ZQuery(ReportFilterSchema) q: z.infer<typeof ReportFilterSchema>,
  ) {
    return this.reports.summary(requireOrg(p), q);
  }

  @Get('reports/breakdown')
  breakdown(
    @CurrentPrincipal() p: Principal,
    @ZQuery(BreakdownQuerySchema) q: z.infer<typeof BreakdownQuerySchema>,
  ) {
    return this.reports.breakdown(requireOrg(p), q, q.by);
  }

  @Get('reports/drilldown')
  drilldown(
    @CurrentPrincipal() p: Principal,
    @ZQuery(DrilldownQuerySchema) q: z.infer<typeof DrilldownQuerySchema>,
  ) {
    return this.reports.drilldown(requireOrg(p), q, q.metric);
  }

  /** CSV export (report.export), audited with its filters. */
  @Get('reports/export')
  async export(
    @CurrentPrincipal() p: Principal,
    @ZQuery(ExportQuerySchema) q: z.infer<typeof ExportQuerySchema>,
    @Res() res: Response,
  ) {
    const o = requireOrg(p);
    if (!o.authz.has('report.export')) throw forbidden('You cannot export reports');
    let body: string;
    if (q.report === 'summary') {
      const s = await this.reports.summary(o, q);
      const m = s.metrics;
      const rows: unknown[][] = [
        ['Leads created', m.leadsCreated],
        ['Assigned leads', m.assigned],
        ['Contacted leads', m.contacted],
        ['Contact rate %', m.contactRate.pct],
        ['First response within target %', m.firstResponse.pct],
        ['Average first response (working min)', m.firstResponse.avgWorkingMinutes],
        ['Average first response (calendar min)', m.firstResponse.avgCalendarMinutes],
        ['Open tasks', m.openTasks],
        ['Overdue tasks', m.overdueTasks],
        ['Reassigned', m.reassigned],
        ['Lost', m.lost],
        ['Recovered', m.recovered],
        ['Counselling sessions', m.counselling],
        ['Admissions confirmed', m.admissions.confirmed],
        ['Admissions cancelled (refunded)', m.admissions.cancelled],
        ['Net admissions', m.admissions.net],
        ...m.revenue.map((r) => [`Net revenue ${r.currency} (minor units)`, r.netMinor]),
        ...m.outstanding.map((r) => [
          `Outstanding ${r.currency} (minor units)`,
          r.outstandingMinor,
        ]),
        ['Period', `${s.from} to ${s.to} (${s.timezone})`],
      ];
      body = csv(['Metric', 'Value'], rows);
    } else if (q.report === 'breakdown') {
      if (!q.by) throw badRequest('BY_REQUIRED', 'Choose how to break down the report');
      const b = await this.reports.breakdown(o, q, q.by);
      body = csv(
        [
          q.by,
          'Leads created',
          'Assigned',
          'Contacted',
          'Admissions',
          'First-contact admissions',
          'Lost',
          'Recovered',
          'Overdue tasks',
          'Net revenue',
        ],
        b.rows.map((r) => [
          r.label,
          r.leadsCreated,
          r.assigned,
          r.contacted,
          r.admissions.confirmed,
          r.admissions.firstContact,
          r.lost,
          r.recovered,
          r.overdueTasks,
          r.revenue.map((x) => `${x.currency} ${x.netMinor}`).join(' '),
        ]),
      );
    } else {
      if (!q.metric) throw badRequest('METRIC_REQUIRED', 'Choose the metric to list');
      const d = await this.reports.drilldown(o, q, q.metric);
      body = csv(
        ['Lead', 'Name', 'When', 'Executive', 'Amount (minor)', 'Currency'],
        d.rows.map((r) => [r.leadNumber, r.name, r.at, r.user, r.amountMinor, r.currency]),
      );
    }
    await this.db.tenant(o.organizationId, (tx) =>
      this.audit.record(tx, {
        organizationId: o.organizationId,
        brandId: q.brandId ?? null,
        actorUserId: o.userId,
        action: 'report.exported',
        entityType: 'report',
        entityId: null,
        after: { ...q },
      }),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${q.report}-${q.from}-${q.to}.csv"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(body);
  }

  // --------------------------------------------------------------- targets
  @Get('targets')
  listTargets(
    @CurrentPrincipal() p: Principal,
    @ZQuery(TargetQuerySchema) q: z.infer<typeof TargetQuerySchema>,
  ) {
    return this.targets.list(requireOrg(p), q);
  }

  @Post('targets')
  @ApiZodBody(TargetSchema)
  createTarget(
    @CurrentPrincipal() p: Principal,
    @ZBody(TargetSchema) body: z.infer<typeof TargetSchema>,
  ) {
    return this.targets.create(requireOrg(p), body);
  }

  @Patch('targets/:id')
  @ApiZodBody(UpdateTargetSchema)
  updateTarget(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateTargetSchema) body: z.infer<typeof UpdateTargetSchema>,
  ) {
    return this.targets.update(requireOrg(p), id, body);
  }

  // -------------------------------------------------------------- ad spend
  @Get('ad-spend')
  spend(@CurrentPrincipal() p: Principal, @ZQuery(OptBrandQ) q: z.infer<typeof OptBrandQ>) {
    return this.targets.listSpend(requireOrg(p), q.brandId);
  }

  @Post('ad-spend')
  @ApiZodBody(AdSpendSchema)
  recordSpend(
    @CurrentPrincipal() p: Principal,
    @ZBody(AdSpendSchema) body: z.infer<typeof AdSpendSchema>,
  ) {
    return this.targets.upsertSpend(requireOrg(p), body);
  }

  // ------------------------------------------------------------ incentives
  @Get('incentive-rules')
  rules(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.targets.rules(requireOrg(p), q.brandId);
  }

  @Post('incentive-rules')
  @ApiZodBody(IncentiveRuleSchema)
  createRule(
    @CurrentPrincipal() p: Principal,
    @ZBody(IncentiveRuleSchema) body: z.infer<typeof IncentiveRuleSchema>,
  ) {
    return this.targets.createRule(requireOrg(p), body);
  }

  @Get('incentive-runs')
  runs(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.targets.listRuns(requireOrg(p), q.brandId);
  }

  @Post('incentive-runs')
  @ApiZodBody(IncentiveRunSchema)
  run(
    @CurrentPrincipal() p: Principal,
    @ZBody(IncentiveRunSchema) body: z.infer<typeof IncentiveRunSchema>,
  ) {
    return this.targets.run(requireOrg(p), body);
  }

  @Get('incentive-runs/:id')
  getRun(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.targets.getRun(requireOrg(p), id);
  }

  @Post('incentive-runs/:id/approve')
  approve(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.targets.approve(requireOrg(p), id);
  }
}
