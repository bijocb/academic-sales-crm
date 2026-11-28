import { z } from 'zod';

export const AI_BANDS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const AI_SUGGESTION_KINDS = [
  'FIRST_CALL',
  'CALL_BACK',
  'BOOK_COUNSELLING',
  'SEND_QUOTATION',
  'SUGGEST_COURSE',
] as const;

export const AiSettingsSchema = z
  .object({
    enabled: z.boolean(),
    scoringEnabled: z.boolean(),
    nextActionsEnabled: z.boolean(),
    highThresholdBp: z.number().int().min(1).max(10000),
    mediumThresholdBp: z.number().int().min(1).max(10000),
    minTrainingSize: z.number().int().min(20).max(100000),
  })
  .refine((v) => v.highThresholdBp > v.mediumThresholdBp, {
    message: 'The High threshold must be above the Medium threshold',
    path: ['highThresholdBp'],
  });

export const ScoreOverrideSchema = z.object({
  band: z.enum(AI_BANDS),
  reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500),
});

export const DismissSuggestionSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
