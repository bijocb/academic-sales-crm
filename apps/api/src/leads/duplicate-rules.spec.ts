import { nameKey, phoneNearMatch, scorePair, SUGGESTION_THRESHOLD } from './duplicate-rules';

const p = (
  fullName: string,
  phoneE164: string | null,
  email: string | null = null,
  city: string | null = null,
) => ({ fullName, phoneE164, email, city });

describe('duplicate rules', () => {
  it('normalizes names: order, punctuation, honorifics, accents, scripts', () => {
    expect(nameKey('Dr. Kumar  Rahul')).toBe('kumar rahul');
    expect(nameKey('Rahul Kumar')).toBe('kumar rahul');
    expect(nameKey('José   Álvarez')).toBe('alvarez jose');
    expect(nameKey('محمد علي')).toBe(nameKey('علي محمد'));
    expect(nameKey('  ')).toBeNull();
  });

  it('detects one-digit typos and swapped digits only', () => {
    expect(phoneNearMatch('+919876543210', '+919876543219')).toBe(true);
    expect(phoneNearMatch('+919876543210', '+919876543201')).toBe(true);
    expect(phoneNearMatch('+919876543210', '+919876543288')).toBe(false);
    expect(phoneNearMatch('+919876543210', '+919876543210')).toBe(false);
    expect(phoneNearMatch('+97150123456', '+919876543210')).toBe(false);
  });

  it('suggests same email, or name + phone typo, but not a common name alone', () => {
    expect(
      scorePair(p('Rahul Kumar', '+919000000001', 'r@x.com'), p('R K', '+919111111111', 'r@x.com'))
        .score,
    ).toBeGreaterThanOrEqual(SUGGESTION_THRESHOLD);
    const typo = scorePair(p('Rahul Kumar', '+919876543210'), p('Kumar Rahul', '+919876543219'));
    expect(typo.reasons).toEqual(['PHONE_NEAR_MATCH', 'SAME_NAME']);
    expect(typo.score).toBe(0.8);
    const sameName = scorePair(
      p('Rahul Kumar', '+919000000001', null, 'Kochi'),
      p('Rahul Kumar', '+918000000002', null, 'Kochi'),
    );
    expect(sameName.score).toBe(0.4);
    expect(sameName.score).toBeLessThan(SUGGESTION_THRESHOLD);
  });

  it('phone typo plus a shared name word is enough', () => {
    const r = scorePair(p('Fatima Al Zaabi', '+971501234567'), p('Fatima Zaabi', '+971501234576'));
    expect(r.reasons).toContain('PHONE_NEAR_MATCH');
    expect(r.score).toBeGreaterThanOrEqual(SUGGESTION_THRESHOLD);
  });
});
