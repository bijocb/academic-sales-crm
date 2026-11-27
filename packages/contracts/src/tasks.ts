import { z } from 'zod';

export const TASK_TYPES = [
  'FIRST_CALL',
  'CALL_BACK',
  'WHATSAPP',
  'EMAIL',
  'COUNSELLING',
  'DOCUMENT_COLLECTION',
  'PAYMENT_FOLLOW_UP',
  'ADMISSION_CONFIRMATION',
  'CUSTOM',
] as const;
export const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const TASK_STATUSES = ['OPEN', 'COMPLETED', 'CANCELLED'] as const;
export const CALL_OUTCOMES = [
  'CONNECTED',
  'NO_ANSWER',
  'BUSY',
  'SWITCHED_OFF',
  'WRONG_NUMBER',
  'CALL_BACK_REQUESTED',
] as const;
export const OTHER_OUTCOMES = ['MESSAGE_SENT', 'DONE'] as const;
export const TASK_OUTCOMES = [...CALL_OUTCOMES, ...OTHER_OUTCOMES] as const;
/** Task types whose completion is a call attempt (outcome must be a call outcome). */
export const CALL_TASK_TYPES: readonly string[] = ['FIRST_CALL', 'CALL_BACK'];

export type TaskType = (typeof TASK_TYPES)[number];
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

/** Outcomes allowed when completing a task of this type (FR-008: required outcome fields). */
export function outcomesFor(type: string): readonly TaskOutcome[] {
  if (CALL_TASK_TYPES.includes(type)) return CALL_OUTCOMES;
  if (type === 'WHATSAPP' || type === 'EMAIL') return ['MESSAGE_SENT', 'DONE'];
  return ['DONE'];
}

const reason = z.string().trim().min(3).max(500);
const dueAt = z.iso.datetime({ offset: true });

export const NewTaskSchema = z.object({
  type: z.enum(TASK_TYPES),
  title: z.string().trim().min(1).max(200).optional(),
  dueAt,
  priority: z.enum(TASK_PRIORITIES).default('NORMAL'),
  notes: z.string().trim().max(2000).optional(),
});

export const CreateTaskSchema = NewTaskSchema.extend({
  /** Defaults to the lead owner (or the caller). Another user needs `task.manage`. */
  ownerId: z.uuid().optional(),
});

export const CompleteTaskSchema = z.object({
  outcome: z.enum(TASK_OUTCOMES),
  notes: z.string().trim().max(2000).optional(),
  /** Required when this is the lead's last open task (next-action rule). */
  nextTask: NewTaskSchema.optional(),
});

export const RescheduleTaskSchema = z.object({ dueAt, reason: reason.optional() });

export const CancelTaskSchema = z.object({ reason, nextTask: NewTaskSchema.optional() });

export const TaskListQuerySchema = z.object({
  view: z.enum(['mine', 'team']).default('mine'),
  ownerId: z.uuid().optional(),
  brandId: z.uuid().optional(),
  status: z.enum(TASK_STATUSES).default('OPEN'),
  due: z.enum(['overdue', 'upcoming', 'all']).default('all'),
  /** e.g. end of the viewer's local day, for a "due today" view. */
  dueBefore: z.iso.datetime({ offset: true }).optional(),
});

export const HoldLeadSchema = z.object({
  reason,
  until: z.iso.date().optional(),
});

export const ResumeLeadSchema = z.object({ nextTask: NewTaskSchema.optional() });

export type NewTaskInput = z.infer<typeof NewTaskSchema>;
