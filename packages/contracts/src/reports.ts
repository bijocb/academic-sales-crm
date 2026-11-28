import { z } from 'zod';

const date = z.iso.date();
const uuid = z.uuid();

export const ReportFilterSchema = z
  .object({
    from: date,
    to: date,
    brandId: uuid.optional(),
    teamId: uuid.optional(),
    userId: uuid.optional(),
    courseId: uuid.optional(),
    sourceId: uuid.optional(),
    campaignId: uuid.optional(),
    /** Own numbers only (My dashboard). */
    mine: z.enum(['true', 'false']).default('false'),
  })
  .refine((v) => v.to >= v.from, {
    message: 'The end date must be on or after the start date',
    path: ['to'],
  });

export const BREAKDOWNS = ['executive', 'course', 'source', 'campaign', 'brand'] as const;
export const BreakdownQuerySchema = ReportFilterSchema.and(z.object({ by: z.enum(BREAKDOWNS) }));

export const DRILLDOWN_METRICS = [
  'leadsCreated',
  'assigned',
  'contacted',
  'lost',
  'recovered',
  'admissionsConfirmed',
  'payments',
  'overdueTasks',
] as const;
export const DrilldownQuerySchema = ReportFilterSchema.and(
  z.object({ metric: z.enum(DRILLDOWN_METRICS) }),
);
export const ExportQuerySchema = ReportFilterSchema.and(
  z.object({
    report: z.enum(['summary', 'breakdown', 'drilldown']),
    by: z.enum(BREAKDOWNS).optional(),
    metric: z.enum(DRILLDOWN_METRICS).optional(),
  }),
);

export const TARGET_METRICS = [
  'ASSIGNED',
  'CONTACTED',
  'COUNSELLING',
  'ADMISSIONS',
  'REVENUE',
  'COLLECTIONS',
] as const;
export const TargetSchema = z
  .object({
    scope: z.enum(['ORGANIZATION', 'BRAND', 'TEAM', 'USER']),
    brandId: uuid.optional(),
    teamId: uuid.optional(),
    userId: uuid.optional(),
    courseId: uuid.optional(),
    metric: z.enum(TARGET_METRICS),
    periodStart: date,
    periodEnd: date,
    value: z.number().int().positive().max(1e13),
    currency: z.enum(['INR', 'AED']).optional(),
  })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: 'The period end must be after its start',
    path: ['periodEnd'],
  })
  .refine((v) => (['REVENUE', 'COLLECTIONS'].includes(v.metric) ? !!v.currency : !v.currency), {
    message: 'Money targets need a currency (and count targets none)',
    path: ['currency'],
  });
export const UpdateTargetSchema = z.object({ value: z.number().int().positive().max(1e13) });
export const TargetQuerySchema = z.object({
  periodStart: date.optional(),
  periodEnd: date.optional(),
  brandId: uuid.optional(),
});

export const AdSpendSchema = z.object({
  campaignId: uuid,
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM'),
  amountMinor: z.number().int().min(0).max(1e13),
});

export const IncentiveRuleSchema = z
  .object({
    brandId: uuid,
    name: z.string().trim().min(2).max(80),
    basis: z.enum(['PER_ADMISSION', 'PERCENT_OF_COLLECTIONS']),
    amountMinor: z.number().int().positive().max(1e13).optional(),
    percentBp: z.number().int().min(1).max(10000).optional(),
    thresholdCount: z.number().int().min(0).max(10000).default(0),
    capMinor: z.number().int().positive().max(1e13).optional(),
    excludedCourseIds: z.array(uuid).max(50).default([]),
    firstContactSharePct: z.number().int().min(0).max(100).default(50),
    effectiveFrom: date,
    effectiveTo: date.optional(),
  })
  .refine((v) => (v.basis === 'PER_ADMISSION' ? !!v.amountMinor : !!v.percentBp), {
    message: 'Per-admission rules need an amount; collection rules need a percentage',
    path: ['amountMinor'],
  });

export const IncentiveRunSchema = z
  .object({ ruleId: uuid, periodStart: date, periodEnd: date })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: 'The period end must be after its start',
    path: ['periodEnd'],
  });
