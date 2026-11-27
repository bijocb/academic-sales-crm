import { z } from 'zod';
import { PIPELINE_STAGE_KEYS } from './catalog';
import { NewTaskSchema } from './tasks';

export const INTEREST_LEVELS = ['HOT', 'WARM', 'COLD'] as const;
/** Set only by the admission/payment workflow (D-006), never by hand. */
export const SYSTEM_STAGES: readonly string[] = ['ADMISSION_CONFIRMED'];
/** ASSUMED (A-038): discounts above this share of the list fee need task.manage. */
export const DISCOUNT_APPROVAL_PERCENT = 10;

const reason = z.string().trim().min(3).max(500);
const text = (max: number) => z.string().trim().max(max).nullable().optional();

export const StageTransitionSchema = z.object({
  toStage: z.enum(PIPELINE_STAGE_KEYS),
  reason: reason.optional(),
});

export const BulkTransitionSchema = StageTransitionSchema.extend({
  leadIds: z.array(z.uuid()).min(1).max(100),
});

export const QualificationSchema = z.object({
  highestQualification: text(200),
  eligibilityNotes: text(2000),
  requirement: text(2000),
  interestLevel: z.enum(INTEREST_LEVELS).nullable().optional(),
  preferredCourseIds: z.array(z.uuid()).max(10).optional(),
  intake: text(50),
  feeReadiness: text(200),
  objections: text(2000),
});

export const CounsellingRecordSchema = z.object({
  counsellorId: z.uuid(),
  heldAt: z.iso.datetime({ offset: true }),
  durationMinutes: z.number().int().min(5).max(480).default(30),
  mode: z.enum(['IN_PERSON', 'PHONE', 'VIDEO']),
  attended: z.boolean().default(true),
  summary: z.string().trim().min(3).max(4000),
  nextTask: NewTaskSchema.optional(),
});

export const CreateQuotationSchema = z.object({
  courseId: z.uuid(),
  batchId: z.uuid().optional(),
  discountMinor: z.number().int().min(0).default(0),
  discountReason: z.string().trim().min(3).max(500).optional(),
  validDays: z.number().int().min(1).max(90).default(14),
  notes: z.string().trim().max(2000).optional(),
});

export const QuotationDecisionSchema = z.object({ reason: reason.optional() });
export const RejectQuotationSchema = z.object({ reason });

export const PipelineQuerySchema = z.object({
  brandId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  courseId: z.uuid().optional(),
  mine: z.enum(['true', 'false']).default('false'),
  perStage: z.coerce.number().int().min(1).max(100).default(30),
});

export const SavedViewSchema = z.object({
  page: z.enum(['leads', 'pipeline']),
  name: z.string().trim().min(1).max(60),
  filters: z.record(z.string(), z.string().max(200)),
});
