import { dedupKeyFor, maskEmail, maskPhone, normalizeEmail, normalizePhone } from './normalize';

describe('lead normalization', () => {
  it('normalizes Indian and UAE numbers using the brand country', () => {
    expect(normalizePhone('98765 43210', 'IN').e164).toBe('+919876543210');
    expect(normalizePhone('+91-98765-43210', 'AE').e164).toBe('+919876543210');
    expect(normalizePhone('050 123 4567', 'AE').e164).toBe('+971501234567');
    expect(normalizePhone('00971501234567', 'IN').e164).toBe('+971501234567');
  });

  it('flags invalid phones and accepts empty values', () => {
    expect(normalizePhone('12345', 'IN').issue?.field).toBe('phone');
    expect(normalizePhone('call me', 'IN').issue).toBeDefined();
    expect(normalizePhone(undefined, 'IN')).toEqual({});
    expect(normalizePhone('   ', 'IN')).toEqual({});
  });

  it('normalizes emails', () => {
    expect(normalizeEmail('  Rahul.K@Gmail.com ').email).toBe('rahul.k@gmail.com');
    expect(normalizeEmail('not-an-email').issue?.field).toBe('email');
  });

  it('masks personal data', () => {
    expect(maskPhone('+919876543210')).toBe('+91••••••••10');
    expect(maskEmail('rahul.k@gmail.com')).toBe('r••••••@gmail.com');
    expect(maskEmail('a@b.com')).toBe('a•••@b.com');
  });

  it('dedup key: external id wins; identical same-day submissions collapse; next day does not', () => {
    const day1 = new Date('2026-11-27T10:00:00Z');
    const day1later = new Date('2026-11-27T18:00:00Z');
    const day2 = new Date('2026-11-28T10:00:00Z');
    const lead = { name: 'Rahul', phone: '9876543210', course: 'Data Science' };
    expect(dedupKeyFor('WEBSITE', { ...lead, externalId: 'abc' }, day1)).toBe('ext:WEBSITE:abc');
    expect(dedupKeyFor('WEBSITE', lead, day1)).toBe(
      dedupKeyFor('WEBSITE', { ...lead, name: ' rahul ' }, day1later),
    );
    expect(dedupKeyFor('WEBSITE', lead, day1)).not.toBe(dedupKeyFor('WEBSITE', lead, day2));
    expect(dedupKeyFor('WEBSITE', lead, day1)).not.toBe(dedupKeyFor('IMPORT', lead, day1));
  });
});
