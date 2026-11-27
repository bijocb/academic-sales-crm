/** Money is stored in minor units (paise / fils). */
export function formatMoney(minor: number | null | undefined, currency: string): string {
  if (minor == null) return '—';
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-AE', {
    style: 'currency',
    currency,
  }).format(minor / 100);
}

export const toMinor = (major: string): number | null =>
  major.trim() === '' ? null : Math.round(Number(major) * 100);

export const minutesToTime = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const timeToMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatInZone(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Offset (ms) of `timeZone` from UTC at instant `utcMs`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - utcMs;
}

/** Interprets a datetime-local value ("2026-11-27T22:00") as wall-clock time in `timeZone`. */
export function zonedLocalToIso(local: string, timeZone: string): string {
  const asUtc = Date.parse(`${local}:00Z`);
  const guess = asUtc - zoneOffsetMs(asUtc, timeZone);
  return new Date(asUtc - zoneOffsetMs(guess, timeZone)).toISOString();
}
