import { FixedClock } from './clock';

describe('FixedClock', () => {
  it('returns copies and advances', () => {
    const c = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    const a = c.now();
    a.setFullYear(2000);
    expect(c.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    c.advance(90_000);
    expect(c.now().toISOString()).toBe('2026-01-01T00:01:30.000Z');
  });
});
