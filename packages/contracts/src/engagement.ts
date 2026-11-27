import { z } from 'zod';
import { CALL_OUTCOMES, NewTaskSchema } from './tasks';

export const MESSAGE_CHANNELS = ['WHATSAPP', 'EMAIL'] as const;
export const APPOINTMENT_MODES = ['IN_PERSON', 'PHONE', 'VIDEO'] as const;
export const TEMPLATE_PLACEHOLDERS = [
  'first_name',
  'full_name',
  'course',
  'owner_name',
  'brand',
] as const;

const instant = z.iso.datetime({ offset: true });
const reason = z.string().trim().min(3).max(500);

export const LogCallSchema = z.object({
  direction: z.enum(['OUTBOUND', 'INBOUND']).default('OUTBOUND'),
  startedAt: instant,
  durationSec: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600)
    .optional(),
  outcome: z.enum(CALL_OUTCOMES),
  notes: z.string().trim().max(2000).optional(),
  providerRef: z.string().trim().max(200).optional(),
});

export const SendMessageSchema = z
  .object({
    channel: z.enum(MESSAGE_CHANNELS),
    templateId: z.uuid().optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(4000).optional(),
  })
  .refine((v) => v.templateId || v.body, {
    message: 'Choose a template or write a message',
    path: ['body'],
  });

export const ContactPreferenceSchema = z.object({
  doNotContact: z.boolean(),
  reason,
});

export const TemplateSchema = z.object({
  brandId: z.uuid(),
  channel: z.enum(MESSAGE_CHANNELS),
  name: z.string().trim().min(2).max(80),
  language: z.string().trim().min(2).max(10).default('en'),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(4000),
  providerTemplateName: z.string().trim().max(200).optional(),
});

export const UpdateTemplateSchema = z
  .object({
    subject: z.string().trim().max(200).nullable(),
    body: z.string().trim().min(1).max(4000),
    providerTemplateName: z.string().trim().max(200).nullable(),
    status: z.enum(['DRAFT', 'APPROVED', 'ARCHIVED']),
  })
  .partial();

export const CreateAppointmentSchema = z.object({
  counsellorId: z.uuid(),
  startsAt: instant,
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(8 * 60)
    .default(30),
  mode: z.enum(APPOINTMENT_MODES),
  location: z.string().trim().max(300).optional(),
});

export const CompleteAppointmentSchema = z.object({
  attended: z.boolean(),
  summary: z.string().trim().min(3).max(4000),
  nextTask: NewTaskSchema.optional(),
});

export const RescheduleAppointmentSchema = z.object({
  startsAt: instant,
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(8 * 60)
    .optional(),
  reason: reason.optional(),
});

export const CancelAppointmentSchema = z.object({ reason });

export const AppointmentListQuerySchema = z.object({
  mine: z.enum(['true', 'false']).default('true'),
  from: instant.optional(),
  to: instant.optional(),
  status: z.enum(['SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED']).optional(),
});

/** Renders {{placeholders}}; unknown placeholders are left visible so mistakes are noticed. */
export function renderTemplate(
  text: string,
  vars: Partial<Record<string, string | null | undefined>>,
): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null || v === '' ? m : v;
  });
}
