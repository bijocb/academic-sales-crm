import { z } from 'zod';

const date = z.iso.date();

/** Management insights (A-051). Without dates: the last 7 days compared with the 7 days before. */
export const InsightQuerySchema = z
  .object({
    from: date.optional(),
    to: date.optional(),
    brandId: z.uuid().optional(),
    teamId: z.uuid().optional(),
  })
  .refine((v) => !v.from || !v.to || v.to >= v.from, {
    message: 'The end date must be on or after the start date',
    path: ['to'],
  })
  .refine((v) => !!v.from === !!v.to, { message: 'Give both dates or neither', path: ['from'] });

/** "Ask the CRM" (A-052). History carries earlier turns of the same conversation (text only). */
export const AssistantAskSchema = z.object({
  question: z.string().trim().min(3).max(1000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(6000),
      }),
    )
    .max(10)
    .default([]),
});

export const AssistantSettingsSchema = z
  .object({
    enabled: z.boolean(),
    briefEnabled: z.boolean(),
    monthlyQuestionLimit: z.number().int().min(0).max(100000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });
