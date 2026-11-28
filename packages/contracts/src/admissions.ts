import { z } from 'zod';

/** ASSUMED (A-041) starter document checklist per brand; O-08 is open. Editable per brand and course. */
export const DEFAULT_DOCUMENT_TYPES: Array<{
  code: string;
  label: string;
  description: string;
  requiredByDefault: boolean;
}> = [
  {
    code: 'PHOTO',
    label: 'Passport-size photo',
    description: 'Recent colour photo',
    requiredByDefault: true,
  },
  {
    code: 'ID_PROOF',
    label: 'Government ID',
    description: 'Aadhaar, Emirates ID or passport',
    requiredByDefault: true,
  },
  {
    code: 'QUALIFICATION',
    label: 'Highest qualification',
    description: 'Certificate or mark sheet',
    requiredByDefault: true,
  },
  {
    code: 'ADDRESS_PROOF',
    label: 'Address proof',
    description: 'Utility bill, rental agreement or bank statement',
    requiredByDefault: false,
  },
  {
    code: 'PASSPORT_VISA',
    label: 'Passport and visa copy',
    description: 'For international or UAE students',
    requiredByDefault: false,
  },
];

export const DOCUMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
/** Hosting request limit is 4.5 MB; files are capped at 4 MB. */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const ADMISSION_STATUSES = [
  'DRAFT',
  'DOCUMENTS_PENDING',
  'UNDER_VERIFICATION',
  'APPROVED',
  'CONFIRMED',
  'DEFERRED',
  'CANCELLED',
] as const;

const reason = z.string().trim().min(3).max(500);
const opt = (max: number) => z.string().trim().max(max).nullable().optional();

export const StartAdmissionSchema = z.object({
  courseId: z.uuid().optional(),
  batchId: z.uuid().optional(),
  quotationId: z.uuid().optional(),
  legalName: z.string().trim().min(2).max(200).optional(),
});

export const StudentProfileSchema = z
  .object({
    legalName: z.string().trim().min(2).max(200),
    dateOfBirth: z.iso.date().nullable(),
    gender: opt(30),
    guardianName: opt(200),
    guardianPhone: opt(30),
    address: opt(500),
    city: opt(100),
    country: opt(2),
    nationality: opt(60),
    idType: opt(60),
    idNumber: opt(60),
  })
  .partial();

export const AdmissionReasonSchema = z.object({ reason });
export const ApproveAdmissionSchema = z.object({
  /** Authorised over-capacity booking (course.manage) — FR-013. */
  overrideCapacityReason: reason.optional(),
});
export const DeferAdmissionSchema = z.object({ reason, batchId: z.uuid().optional() });
export const ChangeBatchSchema = z.object({
  batchId: z.uuid(),
  overrideCapacityReason: reason.optional(),
});
export const RejectDocumentSchema = z.object({ reason });

export const AdmissionListQuerySchema = z.object({
  brandId: z.uuid().optional(),
  status: z.enum(ADMISSION_STATUSES).optional(),
});

export const DocumentTypeSchema = z.object({
  brandId: z.uuid(),
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9_]+$/, 'Use capitals, digits and underscores'),
  label: z.string().trim().min(2).max(100),
  description: z.string().trim().max(300).optional(),
  requiredByDefault: z.boolean().default(true),
});

export const UpdateDocumentTypeSchema = z
  .object({
    label: z.string().trim().min(2).max(100),
    description: z.string().trim().max(300).nullable(),
    requiredByDefault: z.boolean(),
    active: z.boolean(),
  })
  .partial();

export const CourseRequirementsSchema = z.object({
  requirements: z.array(z.object({ documentTypeId: z.uuid(), required: z.boolean() })).max(50),
});

export const AdmissionSettingsSchema = z.object({
  numberFormat: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .refine((v) => /\{SEQ(:\d)?\}/.test(v), 'The format needs a {SEQ} or {SEQ:n} token'),
  requireApprovalToConfirm: z.boolean(),
});

/** Renders an admission number: {BRAND}, {YYYY}, {YY}, {SEQ:n}. */
export function formatAdmissionNumber(
  format: string,
  v: { brand: string; year: number; seq: number },
): string {
  return format
    .replace(/\{BRAND\}/g, v.brand)
    .replace(/\{YYYY\}/g, String(v.year))
    .replace(/\{YY\}/g, String(v.year).slice(-2))
    .replace(/\{SEQ(?::(\d))?\}/g, (_m, n: string | undefined) =>
      String(v.seq).padStart(Number(n ?? 1), '0'),
    );
}
