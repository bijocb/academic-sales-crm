import { z } from 'zod';
import { LEAD_CHANNELS } from './leads';

const uuid = z.uuid();
export const ALLOCATION_STRATEGIES = ['LEAST_LOADED', 'ROUND_ROBIN'] as const;

export const AllocationSettingsSchema = z
  .object({
    enabled: z.boolean(),
    respectWorkingHours: z.boolean(),
    defaultStrategy: z.enum(ALLOCATION_STRATEGIES),
  })
  .partial();

const RuleBase = z.object({
  brandId: uuid,
  name: z.string().trim().min(1).max(200),
  active: z.boolean().default(true),
  courseIds: z.array(uuid).max(100).default([]),
  channels: z.array(z.enum(LEAD_CHANNELS)).max(20).default([]),
  languages: z.array(z.string().trim().toLowerCase().min(2).max(10)).max(20).default([]),
  cities: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  teamId: uuid.nullable().default(null),
  userIds: z.array(uuid).max(200).default([]),
  strategy: z.enum(ALLOCATION_STRATEGIES).default('LEAST_LOADED'),
});
export const AllocationRuleSchema = RuleBase.refine((r) => !!r.teamId || r.userIds.length > 0, {
  message: 'Choose a team or at least one user',
  path: ['teamId'],
});
export const UpdateAllocationRuleSchema = RuleBase.omit({ brandId: true }).partial();
export const ReorderRulesSchema = z.object({
  brandId: uuid,
  ruleIds: z.array(uuid).min(1).max(200),
});

export const AssignLeadSchema = z.object({
  userId: uuid,
  reason: z.string().trim().min(3).max(500),
});
export const AvailabilitySchema = z.object({ isAvailable: z.boolean() });
export const CreateLeaveSchema = z
  .object({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'End date must be on or after the start date',
    path: ['endDate'],
  });
