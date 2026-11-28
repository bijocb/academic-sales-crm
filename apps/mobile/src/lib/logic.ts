/**
 * Pure logic for the executive app: no React Native imports, so it is unit-tested with Node (`npm test`).
 */

export interface TaskRow {
  id: string;
  leadId: string;
  type: string;
  title: string;
  priority: string;
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED';
  dueAt: string;
  overdue: boolean;
  allowedOutcomes: string[];
  lead: { id: string; leadNumber: string; status: string; person: { fullName: string } } | null;
}

export const CALL_OUTCOMES = [
  'CONNECTED',
  'NO_ANSWER',
  'BUSY',
  'SWITCHED_OFF',
  'WRONG_NUMBER',
  'CALL_BACK_REQUESTED',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** Task types whose completion is a call (the server records the call when such a task is completed). */
export const CALL_TASK_TYPES = ['FIRST_CALL', 'CALL_BACK'];

export const SITUATIONS = [
  'COURSE_DETAILS',
  'COLLEGE_DETAILS',
  'FOLLOW_UP',
  'FEE_DETAILS',
  'GENERAL',
] as const;

export const label = (code: string) =>
  code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

/** End of the viewer's local day as an ISO string (the "due today" boundary). */
export function endOfDay(now: Date): string {
  const d = new Date(now.getTime());
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

export interface TodayGroups {
  overdue: TaskRow[];
  today: TaskRow[];
}

/** Open tasks split into overdue and due today, most urgent first. */
export function groupToday(tasks: TaskRow[]): TodayGroups {
  const rank: Record<string, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
  const sorted = [...tasks]
    .filter((t) => t.status === 'OPEN')
    .sort(
      (a, b) => a.dueAt.localeCompare(b.dueAt) || (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9),
    );
  return {
    overdue: sorted.filter((t) => t.overdue),
    today: sorted.filter((t) => !t.overdue),
  };
}

/** The open call task to complete when a call to this lead is logged (oldest due first). */
export function callTaskFor(tasks: TaskRow[], leadId: string): TaskRow | undefined {
  return tasks
    .filter((t) => t.status === 'OPEN' && t.leadId === leadId && CALL_TASK_TYPES.includes(t.type))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
}

/** Whole seconds between leaving the app to dial and coming back; null when implausible. */
export function callDuration(startedAt: Date, returnedAt: Date): number | null {
  const s = Math.round((returnedAt.getTime() - startedAt.getTime()) / 1000);
  return s >= 0 && s <= 24 * 3600 ? s : null;
}

/** `tel:` link for a full phone number; null for a masked or missing number. */
export function telUrl(phone: string | null, masked: boolean): string | null {
  if (!phone || masked || /[*•x]/i.test(phone)) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  return digits.length >= 6 ? `tel:${digits}` : null;
}

export type FollowUp = 'NONE' | 'IN_2_HOURS' | 'TOMORROW' | 'IN_3_DAYS';
export const FOLLOW_UPS: FollowUp[] = ['NONE', 'IN_2_HOURS', 'TOMORROW', 'IN_3_DAYS'];
export const FOLLOW_UP_LABEL: Record<FollowUp, string> = {
  NONE: 'No follow-up',
  IN_2_HOURS: 'In 2 hours',
  TOMORROW: 'Tomorrow 10:00',
  IN_3_DAYS: 'In 3 days 10:00',
};

/** Due time of the next follow-up, in the phone's local time. */
export function followUpAt(choice: FollowUp, now: Date): string | null {
  if (choice === 'NONE') return null;
  if (choice === 'IN_2_HOURS') return new Date(now.getTime() + 2 * 3600_000).toISOString();
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + (choice === 'TOMORROW' ? 1 : 3));
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

/** A sensible default follow-up for an outcome. */
export function defaultFollowUp(outcome: CallOutcome): FollowUp {
  if (outcome === 'WRONG_NUMBER') return 'NONE';
  if (outcome === 'NO_ANSWER' || outcome === 'BUSY' || outcome === 'SWITCHED_OFF')
    return 'IN_2_HOURS';
  return 'TOMORROW';
}

/** The body for logging a call: complete the open call task, or log a standalone call. */
export function callPlan(input: {
  leadId: string;
  tasks: TaskRow[];
  outcome: CallOutcome;
  notes: string;
  startedAt: Date;
  durationSec: number | null;
  followUp: FollowUp;
  now: Date;
}):
  | { kind: 'complete'; taskId: string; body: Record<string, unknown> }
  | { kind: 'log'; body: Record<string, unknown>; nextTask: Record<string, unknown> | null } {
  const notes = input.notes.trim() || undefined;
  const due = followUpAt(input.followUp, input.now);
  const nextTask = due ? { type: 'CALL_BACK', dueAt: due, priority: 'NORMAL' } : null;
  const task = callTaskFor(input.tasks, input.leadId);
  if (task && task.allowedOutcomes.includes(input.outcome))
    return {
      kind: 'complete',
      taskId: task.id,
      body: { outcome: input.outcome, notes, ...(nextTask ? { nextTask } : {}) },
    };
  return {
    kind: 'log',
    body: {
      direction: 'OUTBOUND',
      startedAt: input.startedAt.toISOString(),
      ...(input.durationSec !== null ? { durationSec: input.durationSec } : {}),
      outcome: input.outcome,
      notes,
    },
    nextTask,
  };
}

/** Short relative time for lists ("in 2 h", "3 d ago"). */
export function relative(iso: string, now: Date): string {
  const min = Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(min);
  const v =
    abs < 60
      ? `${abs} min`
      : abs < 48 * 60
        ? `${Math.round(abs / 60)} h`
        : `${Math.round(abs / 1440)} d`;
  return min >= 0 ? `in ${v}` : `${v} ago`;
}

/** The screen a tapped notification opens, from its data payload. */
export function notificationTarget(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const link = typeof d.link === 'string' ? d.link : null;
  const m = link?.match(/\/leads\/([0-9a-f-]{36})/i);
  if (m) return `/lead/${m[1]}`;
  if (typeof d.leadId === 'string' && /^[0-9a-f-]{36}$/i.test(d.leadId)) return `/lead/${d.leadId}`;
  return link?.startsWith('/tasks') ? '/' : null;
}
