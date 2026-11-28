import { z } from 'zod';

export const MANUAL_PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'UPI',
  'CHEQUE',
  'CARD_MACHINE',
] as const;
const reason = z.string().trim().min(3).max(500);
const minor = z.number().int().positive().max(1e13);

export const ScheduleSchema = z.union([
  z.object({
    mode: z.literal('EQUAL'),
    count: z.number().int().min(1).max(24),
    firstDueDate: z.iso.date(),
    intervalDays: z.number().int().min(1).max(366).default(30),
  }),
  z.object({
    mode: z.literal('CUSTOM'),
    instalments: z
      .array(z.object({ dueDate: z.iso.date(), amountMinor: minor }))
      .min(1)
      .max(24),
  }),
]);

export const FeeAdjustmentSchema = z.object({
  amountMinor: z
    .number()
    .int()
    .refine((v) => v !== 0, 'The adjustment cannot be zero')
    .refine((v) => Math.abs(v) <= 1e13, 'Too large'),
  reason,
});

export const PaymentLinkSchema = z.object({ amountMinor: minor.optional() });

export const ManualPaymentSchema = z.object({
  amountMinor: minor,
  method: z.enum(MANUAL_PAYMENT_METHODS),
  reference: z.string().trim().max(120).optional(),
  receivedAt: z.iso.datetime({ offset: true }),
  notes: z.string().trim().max(1000).optional(),
});

export const RefundRequestSchema = z.object({ amountMinor: minor, reason });
export const RefundDecisionSchema = z.object({ note: z.string().trim().max(500).optional() });
export const RefundRejectSchema = z.object({ note: reason });
export const RefundPaidSchema = z.object({
  method: z.enum(['BANK_TRANSFER', 'UPI', 'CASH', 'CHEQUE', 'GATEWAY_REFUND']),
  reference: z.string().trim().min(2).max(120),
  paidOn: z.iso.date(),
});

export const FinanceSettingsSchema = z.object({
  receiptNumberFormat: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .refine((v) => /\{SEQ(:\d)?\}/.test(v), 'The format needs a {SEQ} or {SEQ:n} token'),
  minConfirmAmountMinor: z.number().int().min(1).max(1e13),
  defaultDueDays: z.number().int().min(0).max(365),
  refundMakerChecker: z.boolean(),
});

export const RefundListQuerySchema = z.object({
  status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'PAID']).optional(),
  brandId: z.uuid().optional(),
});
