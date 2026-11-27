import { z } from 'zod';

// ---------------------------------------------------------------- defaults

/** Pipeline stages from the workflow diagram (keys and order fixed; labels editable). */
export const PIPELINE_STAGE_KEYS = [
  'NEW_ENQUIRY',
  'CONTACTED',
  'QUALIFIED',
  'INTERESTED',
  'COUNSELLING_COMPLETED',
  'COURSE_SELECTED',
  'PAYMENT_PENDING',
  'ADMISSION_CONFIRMED',
] as const;
export type PipelineStageKey = (typeof PIPELINE_STAGE_KEYS)[number];

/** Fields a stage can require before a lead may enter it (enforced from Phase 9). */
export const STAGE_FIELD_CATALOG = {
  name: 'Name',
  mobile: 'Mobile number',
  source: 'Lead source',
  contactOutcome: 'Contact attempt and outcome',
  qualification: 'Qualification',
  eligibility: 'Eligibility notes',
  requirement: 'Student requirement',
  interestLevel: 'Interest level',
  coursePreference: 'Course preference',
  counsellingDate: 'Counselling date',
  counsellingRemarks: 'Counselling remarks',
  course: 'Course',
  batch: 'Batch',
  feeQuote: 'Fee quotation',
  amountDue: 'Amount due',
  paymentStatus: 'Payment status',
  admissionId: 'Admission ID',
  paymentVerified: 'Verified payment',
} as const;
export type StageField = keyof typeof STAGE_FIELD_CATALOG;
const STAGE_FIELDS = Object.keys(STAGE_FIELD_CATALOG) as [StageField, ...StageField[]];

/** SRS §3.2 / workflow study defaults. */
export const DEFAULT_PIPELINE: Array<{
  key: PipelineStageKey;
  label: string;
  requiredFields: StageField[];
}> = [
  { key: 'NEW_ENQUIRY', label: 'New Enquiry', requiredFields: ['name', 'mobile', 'source'] },
  { key: 'CONTACTED', label: 'Contacted', requiredFields: ['contactOutcome'] },
  {
    key: 'QUALIFIED',
    label: 'Qualified',
    requiredFields: ['qualification', 'eligibility', 'requirement'],
  },
  { key: 'INTERESTED', label: 'Interested', requiredFields: ['interestLevel', 'coursePreference'] },
  {
    key: 'COUNSELLING_COMPLETED',
    label: 'Counselling Completed',
    requiredFields: ['counsellingDate', 'counsellingRemarks'],
  },
  {
    key: 'COURSE_SELECTED',
    label: 'Course Selected',
    requiredFields: ['course', 'batch', 'feeQuote'],
  },
  {
    key: 'PAYMENT_PENDING',
    label: 'Payment Pending',
    requiredFields: ['amountDue', 'paymentStatus'],
  },
  {
    key: 'ADMISSION_CONFIRMED',
    label: 'Admission Confirmed',
    requiredFields: ['admissionId', 'paymentVerified'],
  },
];

export const SLA_ACTIONS = [
  'REMIND_OWNER',
  'ALERT_TEAM_LEADER',
  'REASSIGN',
  'ESCALATE_MANAGER',
] as const;
export const TIME_BASES = ['WORKING', 'CALENDAR'] as const;

/** Diagram values: 5 / 15 / 30 / 60 minutes, working-time basis (A-003a), 3 attempts (A-010). */
export const DEFAULT_SLA_POLICY = {
  firstResponseMinutes: 15,
  firstResponseBasis: 'WORKING' as const,
  maxReassignAttempts: 3,
  reassignCooldownMinutes: 24 * 60,
  checkpoints: [
    { action: 'REMIND_OWNER' as const, afterMinutes: 5, basis: 'WORKING' as const },
    { action: 'ALERT_TEAM_LEADER' as const, afterMinutes: 15, basis: 'WORKING' as const },
    { action: 'REASSIGN' as const, afterMinutes: 30, basis: 'WORKING' as const },
    { action: 'REASSIGN' as const, afterMinutes: 60, basis: 'WORKING' as const },
    { action: 'ESCALATE_MANAGER' as const, afterMinutes: 90, basis: 'WORKING' as const },
  ],
};

/** A-018 default working week per country (ISO weekday 1 = Monday). Editable per brand. */
export const DEFAULT_WORKING_HOURS: Record<
  'IN' | 'AE',
  Array<{ weekday: number; startMinute: number; endMinute: number }>
> = {
  IN: [1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startMinute: 9 * 60 + 30,
    endMinute: 18 * 60 + 30,
  })),
  AE: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 18 * 60 })),
};

// ---------------------------------------------------------------- schemas

const uuid = z.uuid();
const name = z.string().trim().min(1).max(200);
const code = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Z0-9_-]+$/, 'Use upper-case letters, digits, - or _');
const isoDate = z.iso.date();
const recordStatus = z.enum(['ACTIVE', 'ARCHIVED']);

export const CreateCourseCategorySchema = z.object({ brandId: uuid, name, code });
export const UpdateCourseCategorySchema = z.object({ name, status: recordStatus }).partial();

const courseFields = {
  categoryId: uuid.nullable(),
  name,
  description: z.string().trim().max(5000).nullable(),
  eligibility: z.string().trim().max(2000).nullable(),
  deliveryMode: z.enum(['ONLINE', 'OFFLINE', 'HYBRID']),
  durationValue: z.number().int().min(1).max(1000).nullable(),
  durationUnit: z.enum(['DAYS', 'WEEKS', 'MONTHS', 'YEARS']).nullable(),
  /** Integer minor units (paise / fils) in the brand currency. */
  listFeeMinor: z.number().int().min(0).max(1_000_000_000_00).nullable(),
};
const durationPair = (
  v: { durationValue?: number | null; durationUnit?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (v.durationValue === undefined && v.durationUnit === undefined) return;
  if ((v.durationValue == null) !== (v.durationUnit == null)) {
    ctx.addIssue({
      code: 'custom',
      path: ['durationUnit'],
      message: 'Provide both duration value and unit, or neither',
    });
  }
};
export const CreateCourseSchema = z
  .object({ brandId: uuid, code, ...courseFields })
  .partial({
    categoryId: true,
    description: true,
    eligibility: true,
    durationValue: true,
    durationUnit: true,
    listFeeMinor: true,
  })
  .superRefine(durationPair);
export const UpdateCourseSchema = z
  .object({ ...courseFields, status: recordStatus })
  .partial()
  .superRefine(durationPair);

const batchStatus = z.enum(['PLANNED', 'OPEN', 'CLOSED', 'CANCELLED']);
const datesOrdered = (v: { startDate?: string; endDate?: string | null }, ctx: z.RefinementCtx) => {
  if (v.startDate && v.endDate && v.endDate < v.startDate) {
    ctx.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'End date must be on or after the start date',
    });
  }
};
export const CreateBatchSchema = z
  .object({
    courseId: uuid,
    branchId: uuid.optional(),
    code,
    name,
    startDate: isoDate,
    endDate: isoDate.optional(),
    capacity: z.number().int().min(0).max(100_000),
    schedule: z.string().trim().max(500).optional(),
    status: batchStatus.optional(),
  })
  .superRefine(datesOrdered);
export const UpdateBatchSchema = z
  .object({
    name,
    branchId: uuid.nullable(),
    startDate: isoDate,
    endDate: isoDate.nullable(),
    capacity: z.number().int().min(0).max(100_000),
    schedule: z.string().trim().max(500).nullable(),
    status: batchStatus,
  })
  .partial()
  .superRefine(datesOrdered);

const shift = z
  .object({
    weekday: z.number().int().min(1).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .refine((s) => s.endMinute > s.startMinute, {
    message: 'Shift must end after it starts',
    path: ['endMinute'],
  });
export const WorkingHoursSchema = z
  .object({ shifts: z.array(shift).max(50) })
  .superRefine((v, ctx) => {
    for (let d = 1; d <= 7; d++) {
      const day = v.shifts
        .filter((s) => s.weekday === d)
        .sort((a, b) => a.startMinute - b.startMinute);
      for (let i = 1; i < day.length; i++) {
        if (day[i].startMinute < day[i - 1].endMinute) {
          ctx.addIssue({
            code: 'custom',
            path: ['shifts'],
            message: `Overlapping shifts on weekday ${d}`,
          });
        }
      }
    }
    if (v.shifts.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['shifts'],
        message: 'At least one working shift is required',
      });
    }
  });

export const CreateHolidaySchema = z.object({ date: isoDate, name });

export const SlaPolicySchema = z
  .object({
    firstResponseMinutes: z.number().int().min(1).max(10_080),
    firstResponseBasis: z.enum(TIME_BASES),
    maxReassignAttempts: z.number().int().min(0).max(10),
    reassignCooldownMinutes: z.number().int().min(0).max(43_200),
    checkpoints: z
      .array(
        z.object({
          action: z.enum(SLA_ACTIONS),
          afterMinutes: z.number().int().min(1).max(10_080),
          basis: z.enum(TIME_BASES),
        }),
      )
      .min(1)
      .max(20),
  })
  .superRefine((v, ctx) => {
    for (let i = 1; i < v.checkpoints.length; i++) {
      if (v.checkpoints[i].afterMinutes <= v.checkpoints[i - 1].afterMinutes) {
        ctx.addIssue({
          code: 'custom',
          path: ['checkpoints', i, 'afterMinutes'],
          message: 'Checkpoints must be in increasing time order',
        });
      }
    }
    const reassigns = v.checkpoints.filter((c) => c.action === 'REASSIGN').length;
    if (reassigns > v.maxReassignAttempts) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxReassignAttempts'],
        message: 'More REASSIGN checkpoints than the maximum reassignment attempts',
      });
    }
  });

export const UpdatePipelineStageSchema = z
  .object({ label: name, requiredFields: z.array(z.enum(STAGE_FIELDS)).max(20) })
  .partial();

export const CalendarPreviewQuerySchema = z.object({
  start: z.iso.datetime({ offset: true }),
  minutes: z.coerce.number().int().min(1).max(10_080),
});

export type CreateCourseInput = z.infer<typeof CreateCourseSchema>;
export type CreateBatchInput = z.infer<typeof CreateBatchSchema>;
export type SlaPolicyInput = z.infer<typeof SlaPolicySchema>;
