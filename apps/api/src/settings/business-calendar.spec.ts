import { DEFAULT_WORKING_HOURS } from '@crm/contracts';
import {
  addWorkingMinutes,
  CalendarSpec,
  isWorkingTime,
  workingMinutesBetween,
} from './business-calendar';

const india: CalendarSpec = {
  timezone: 'Asia/Kolkata',
  shifts: DEFAULT_WORKING_HOURS.IN,
  holidays: new Set(),
};
const uae: CalendarSpec = {
  timezone: 'Asia/Dubai',
  shifts: DEFAULT_WORKING_HOURS.AE,
  holidays: new Set(),
};
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

// 2026-11-27 is a Friday.
describe('business calendar — India (Mon–Sat 09:30–18:30 IST)', () => {
  it('adds minutes inside a working day', () => {
    expect(iso(addWorkingMinutes(at('2026-11-27T10:00:00+05:30'), 15, india))).toBe(
      '2026-11-27T04:45:00.000Z',
    );
  });

  it('a lead arriving at 22:00 waits for the next morning', () => {
    // Sat 09:45 IST
    expect(iso(addWorkingMinutes(at('2026-11-27T22:00:00+05:30'), 15, india))).toBe(
      '2026-11-28T04:15:00.000Z',
    );
  });

  it('a lead arriving before opening starts at opening time', () => {
    expect(iso(addWorkingMinutes(at('2026-11-27T07:00:00+05:30'), 5, india))).toBe(
      '2026-11-27T04:05:00.000Z',
    );
  });

  it('skips Sunday', () => {
    // Sat 18:20 + 15 → 10 min Saturday, Monday 09:35 IST
    expect(iso(addWorkingMinutes(at('2026-11-28T18:20:00+05:30'), 15, india))).toBe(
      '2026-11-30T04:05:00.000Z',
    );
  });

  it('skips holidays', () => {
    const cal = { ...india, holidays: new Set(['2026-11-30']) };
    expect(iso(addWorkingMinutes(at('2026-11-28T18:20:00+05:30'), 15, cal))).toBe(
      '2026-12-01T04:05:00.000Z',
    );
  });

  it('counts working minutes between instants', () => {
    // Fri 22:00 → Mon 10:00 = all of Saturday (540) + Monday 09:30–10:00 (30)
    expect(
      workingMinutesBetween(
        at('2026-11-27T22:00:00+05:30'),
        at('2026-11-30T10:00:00+05:30'),
        india,
      ),
    ).toBe(570);
    expect(
      workingMinutesBetween(
        at('2026-11-27T11:00:00+05:30'),
        at('2026-11-27T10:00:00+05:30'),
        india,
      ),
    ).toBe(0);
  });

  it('reports whether an instant is working time', () => {
    expect(isWorkingTime(at('2026-11-27T10:00:00+05:30'), india)).toBe(true);
    expect(isWorkingTime(at('2026-11-27T18:30:00+05:30'), india)).toBe(false);
    expect(isWorkingTime(at('2026-11-29T11:00:00+05:30'), india)).toBe(false);
  });
});

describe('business calendar — UAE (Mon–Fri 09:00–18:00 GST)', () => {
  it('carries over the weekend', () => {
    // Fri 17:50 + 30 → 10 min Friday, Monday 09:20 GST
    expect(iso(addWorkingMinutes(at('2026-11-27T17:50:00+04:00'), 30, uae))).toBe(
      '2026-11-30T05:20:00.000Z',
    );
  });

  it('same instant, different brands, different due times', () => {
    const lead = at('2026-11-28T10:00:00+05:30'); // Saturday morning in India = 08:30 in Dubai
    expect(iso(addWorkingMinutes(lead, 15, india))).toBe('2026-11-28T04:45:00.000Z');
    expect(iso(addWorkingMinutes(lead, 15, uae))).toBe('2026-11-30T05:15:00.000Z');
  });
});

describe('business calendar — shifts and edge cases', () => {
  const split: CalendarSpec = {
    timezone: 'Asia/Kolkata',
    shifts: [
      { weekday: 5, startMinute: 9 * 60, endMinute: 13 * 60 },
      { weekday: 5, startMinute: 14 * 60, endMinute: 18 * 60 },
      { weekday: 1, startMinute: 9 * 60, endMinute: 18 * 60 },
    ],
    holidays: new Set(),
  };

  it('skips the lunch break between shifts', () => {
    expect(iso(addWorkingMinutes(at('2026-11-27T12:50:00+05:30'), 30, split))).toBe(
      '2026-11-27T08:50:00.000Z',
    );
  });

  it('works in a daylight-saving time zone', () => {
    const london: CalendarSpec = {
      timezone: 'Europe/London',
      shifts: DEFAULT_WORKING_HOURS.AE,
      holidays: new Set(),
    };
    // Fri 27 Mar 2026 17:30 GMT + 60 → 30 min Fri, Mon 30 Mar 09:30 BST (08:30Z) after clocks change
    expect(iso(addWorkingMinutes(at('2026-03-27T17:30:00Z'), 60, london))).toBe(
      '2026-03-30T08:30:00.000Z',
    );
  });

  it('rejects calendars with no working time', () => {
    expect(() =>
      addWorkingMinutes(at('2026-11-27T10:00:00Z'), 5, { ...india, shifts: [] }),
    ).toThrow(/no working shifts/);
  });
});
