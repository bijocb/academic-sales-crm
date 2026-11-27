import { z } from 'zod';

export const LEAD_CHANNELS = [
  'META_ADS',
  'GOOGLE_ADS',
  'WEBSITE',
  'WHATSAPP',
  'CALL',
  'REFERRAL',
  'EVENT',
  'IMPORT',
  'MANUAL',
  'OTHER',
] as const;
export const LEAD_STATUSES = [
  'OPEN',
  'ON_HOLD',
  'LOST',
  'IN_RECOVERY',
  'CLOSED_LOST',
  'CONVERTED',
] as const;

const uuid = z.uuid();
const name = z.string().trim().min(1).max(200);
const opt = (max: number) => z.string().trim().max(max).optional();
const isoDate = z.iso.date();

/**
 * One inbound lead, as accepted by every channel (intake API, manual entry, import rows).
 * Light shape checks only: business validation (phone/email normalization) happens in the
 * intake pipeline so that failures land in the exception queue instead of being rejected.
 */
export const LeadInputSchema = z.object({
  name: z.string().trim().max(200).optional(),
  phone: opt(40),
  email: opt(254),
  courseId: uuid.optional(),
  courseCode: opt(32),
  course: opt(200),
  city: opt(100),
  language: opt(20),
  message: opt(2000),
  campaignId: uuid.optional(),
  utm_source: opt(200),
  utm_medium: opt(200),
  utm_campaign: opt(200),
  utm_term: opt(200),
  utm_content: opt(200),
  landingPage: opt(1000),
  referrer: opt(1000),
  adId: opt(100),
  adsetId: opt(100),
  formId: opt(100),
  externalId: opt(200),
  consentMarketing: z.boolean().optional(),
  consentText: opt(1000),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
});
export type LeadInput = z.infer<typeof LeadInputSchema>;

export const ManualLeadSchema = LeadInputSchema.extend({
  brandId: uuid,
  sourceId: uuid.optional(),
  channel: z.enum(LEAD_CHANNELS).default('MANUAL'),
});

export const CreateLeadSourceSchema = z.object({
  brandId: uuid,
  name,
  channel: z.enum(LEAD_CHANNELS),
  isPaid: z.boolean().default(false),
});
export const UpdateLeadSourceSchema = z
  .object({ name, isPaid: z.boolean(), status: z.enum(['ACTIVE', 'ARCHIVED']) })
  .partial();

export const CreateCampaignSchema = z.object({
  brandId: uuid,
  sourceId: uuid.optional(),
  name,
  utmCampaign: opt(200),
  externalId: opt(100),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
});
export const UpdateCampaignSchema = z
  .object({
    name,
    utmCampaign: z.string().trim().max(200).nullable(),
    externalId: z.string().trim().max(100).nullable(),
    status: z.enum(['ACTIVE', 'ARCHIVED']),
  })
  .partial();

export const CreateIntakeKeySchema = z.object({ sourceId: uuid, name });

export const ResolveExceptionSchema = z.object({
  lead: LeadInputSchema,
  note: z.string().trim().max(500).optional(),
});
export const DiscardExceptionSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const IMPORT_FIELDS = [
  'name',
  'phone',
  'email',
  'courseCode',
  'course',
  'city',
  'language',
  'message',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'externalId',
  'receivedAt',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export const MAX_IMPORT_ROWS_PER_REQUEST = 500;

const importRow = z.object({
  rowNumber: z.number().int().min(1),
  data: z.record(z.string(), z.string().max(2000)),
});
export const ValidateImportSchema = z.object({
  brandId: uuid,
  rows: z.array(importRow).min(1).max(MAX_IMPORT_ROWS_PER_REQUEST),
});
export const CreateImportSchema = z.object({
  brandId: uuid,
  sourceId: uuid.optional(),
  fileName: z.string().trim().min(1).max(255),
  duplicatePolicy: z.enum(['ADD_ENQUIRY', 'SKIP_EXISTING']),
  totalRows: z.number().int().min(1).max(100_000),
});
export const ImportRowsSchema = z.object({
  rows: z.array(importRow).min(1).max(MAX_IMPORT_ROWS_PER_REQUEST),
});

export const LeadListQuerySchema = z.object({
  brandId: uuid.optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------- Phase 5

export const LeadNoteSchema = z.object({ body: z.string().trim().min(1).max(5000) });

export const UpdateLeadProfileSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    phone: z.string().trim().max(40).nullable(),
    email: z.string().trim().max(254).nullable(),
    city: z.string().trim().max(100).nullable(),
    language: z.string().trim().max(20).nullable(),
    courseId: uuid.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const side = z.enum(['A', 'B']);
export const MergeDuplicateSchema = z.object({
  survivor: side,
  fields: z.object({ fullName: side, phone: side, email: side, city: side }),
  note: z.string().trim().max(500).optional(),
});
export const DismissDuplicateSchema = z.object({ note: z.string().trim().min(3).max(500) });
