import { DateTime } from 'luxon';

/**
 * Pure business-time arithmetic for a brand (no I/O). Used by SLA timers (Phase 7)
 * and the settings preview. All inputs/outputs are absolute instants (UTC Dates);
 * shifts and holidays are interpreted in the brand's IANA time zone.
 */
export interface CalendarSpec {
  timezone: string;
  /** ISO weekday 1..7 → shifts as [startMinute, endMinute) from local midnight. */
  shifts: Array<{ weekday: number; startMinute: number; endMinute: number }>;
  /** Local dates (YYYY-MM-DD) with no working time. */
  holidays: ReadonlySet<string>;
}

const MAX_DAYS_SCANNED = 400;

/** Working intervals for one local date, as absolute DateTimes, sorted. */
function intervalsOn(day: DateTime, cal: CalendarSpec): Array<[DateTime, DateTime]> {
  if (cal.holidays.has(day.toISODate()!)) return [];
  return cal.shifts
    .filter((s) => s.weekday === day.weekday)
    .sort((a, b) => a.startMinute - b.startMinute)
    .map((s) => [day.plus({ minutes: s.startMinute }), day.plus({ minutes: s.endMinute })]);
}

function assertUsable(cal: CalendarSpec): void {
  if (!DateTime.local().setZone(cal.timezone).isValid)
    throw new Error(`Invalid time zone ${cal.timezone}`);
  if (cal.shifts.length === 0) throw new Error('Calendar has no working shifts');
}

/** The instant after `minutes` of working time have elapsed from `start`. */
export function addWorkingMinutes(start: Date, minutes: number, cal: CalendarSpec): Date {
  assertUsable(cal);
  let remainingMs = Math.round(minutes * 60_000);
  let cursor: DateTime = DateTime.fromJSDate(start, { zone: cal.timezone });
  let day = cursor.startOf('day');
  for (let i = 0; i < MAX_DAYS_SCANNED; i++, day = day.plus({ days: 1 })) {
    for (const [from, to] of intervalsOn(day, cal)) {
      if (to <= cursor) continue;
      const begin = from > cursor ? from : cursor;
      const available = to.toMillis() - begin.toMillis();
      if (remainingMs <= available) return begin.plus({ milliseconds: remainingMs }).toJSDate();
      remainingMs -= available;
      cursor = to;
    }
  }
  throw new Error('No working time found within 400 days (check holidays and shifts)');
}

/** Working minutes between two instants (0 if end <= start). */
export function workingMinutesBetween(start: Date, end: Date, cal: CalendarSpec): number {
  assertUsable(cal);
  if (end <= start) return 0;
  const a = DateTime.fromJSDate(start, { zone: cal.timezone });
  const b = DateTime.fromJSDate(end, { zone: cal.timezone });
  let ms = 0;
  for (let day = a.startOf('day'), i = 0; day <= b && i < 5000; day = day.plus({ days: 1 }), i++) {
    for (const [from, to] of intervalsOn(day, cal)) {
      const lo = from > a ? from : a;
      const hi = to < b ? to : b;
      if (hi > lo) ms += hi.toMillis() - lo.toMillis();
    }
  }
  return ms / 60_000;
}

/** Whether `at` falls inside working time. */
export function isWorkingTime(at: Date, cal: CalendarSpec): boolean {
  const t = DateTime.fromJSDate(at, { zone: cal.timezone });
  return intervalsOn(t.startOf('day'), cal).some(([from, to]) => t >= from && t < to);
}
