import { z } from 'zod';
import { NewTaskSchema } from './tasks';

/** ASSUMED (A-040) starter loss reasons per brand; editable. */
export const DEFAULT_LOSS_REASONS: Array<{ code: string; label: string; recoverable: boolean }> = [
  { code: 'NOT_INTERESTED_NOW', label: 'Not interested right now', recoverable: true },
  { code: 'FEE_TOO_HIGH', label: 'Fee too high', recoverable: true },
  { code: 'CHOSE_COMPETITOR', label: 'Chose another institute', recoverable: true },
  { code: 'COURSE_NOT_SUITABLE', label: 'Course not suitable', recoverable: true },
  { code: 'LATER_INTAKE', label: 'Timing — wants a later intake', recoverable: true },
  { code: 'LOCATION_OR_MODE', label: 'Location or study mode', recoverable: true },
  { code: 'NOT_REACHABLE', label: 'Not reachable', recoverable: true },
  { code: 'ALREADY_ENROLLED', label: 'Already enrolled elsewhere', recoverable: false },
  { code: 'INVALID_ENQUIRY', label: 'Invalid or fake enquiry', recoverable: false },
  { code: 'OTHER', label: 'Other', recoverable: true },
];

/** ASSUMED (A-040) defaults; O-07 is open. */
export const DEFAULT_RECOVERY_POLICY = {
  enabled: true,
  cooldownDays: 7,
  maxAttempts: 3,
  attemptIntervalDays: 3,
  ownerMode: 'DIFFERENT_EXECUTIVE' as const,
  autoCloseAfterMax: true,
};

export const RECOVERY_OUTCOMES = [
  'NO_RESPONSE',
  'CALL_BACK_LATER',
  'NOT_INTERESTED',
  'INTERESTED',
  'OPTED_OUT',
] as const;
export const RECOVERY_CHANNELS = ['CALL', 'WHATSAPP', 'EMAIL'] as const;

const reason = z.string().trim().min(3).max(500);

export const MarkLostSchema = z.object({
  lossReasonId: z.uuid(),
  notes: z.string().trim().min(3).max(2000),
  plan: z.enum(['RECOVER', 'CLOSE']),
});

export const RecoveryAttemptSchema = z.object({
  channel: z.enum(RECOVERY_CHANNELS),
  outcome: z.enum(RECOVERY_OUTCOMES),
  notes: z.string().trim().max(2000).optional(),
  offeredCourseId: z.uuid().optional(),
  nextAttemptAt: z.iso.datetime({ offset: true }).optional(),
  /** Required when the lead is reopened (INTERESTED): the next sales action. */
  nextTask: NewTaskSchema.optional(),
});

export const CloseRecoverySchema = z.object({ reason });

export const LossReasonSchema = z.object({
  brandId: z.uuid(),
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9_]+$/, 'Use capitals, digits and underscores'),
  label: z.string().trim().min(2).max(100),
  recoverable: z.boolean().default(true),
});

export const UpdateLossReasonSchema = z
  .object({
    label: z.string().trim().min(2).max(100),
    recoverable: z.boolean(),
    active: z.boolean(),
  })
  .partial();

export const RecoveryPolicySchema = z.object({
  enabled: z.boolean(),
  cooldownDays: z.number().int().min(0).max(365),
  maxAttempts: z.number().int().min(1).max(20),
  attemptIntervalDays: z.number().int().min(0).max(90),
  ownerMode: z.enum(['DIFFERENT_EXECUTIVE', 'SAME_OWNER', 'QUEUE']),
  autoCloseAfterMax: z.boolean(),
});

export const RecoveryQueueQuerySchema = z.object({
  brandId: z.uuid().optional(),
  view: z.enum(['mine', 'all']).default('mine'),
  status: z.enum(['SCHEDULED', 'ACTIVE', 'RECOVERED', 'CLOSED', 'CANCELLED']).default('ACTIVE'),
});
