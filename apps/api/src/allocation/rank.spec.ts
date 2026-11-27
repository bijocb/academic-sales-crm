import { CandidateInput, decide, matchRule } from './rank';

const c = (userId: string, o: Partial<CandidateInput> = {}): CandidateInput => ({
  userId,
  name: userId,
  isAvailable: true,
  onLeave: false,
  activeLeads: 0,
  maxActiveLeads: null,
  languages: [],
  lastAssignedAt: null,
  ...o,
});
const t = (iso: string) => new Date(iso);

describe('allocation ranking', () => {
  it('least loaded wins, relative to capacity', () => {
    const d = decide(
      [
        c('a', { activeLeads: 20, maxActiveLeads: 50 }),
        c('b', { activeLeads: 35, maxActiveLeads: 50 }),
        c('c', { activeLeads: 10, maxActiveLeads: 50 }),
        c('d', { activeLeads: 45, maxActiveLeads: 50 }),
      ],
      { strategy: 'LEAST_LOADED' },
    );
    expect(d.chosen).toBe('c');
    expect(d.candidates.find((x) => x.userId === 'a')!.rank).toBe(2);
  });

  it('equal load: least recently assigned, then user id (deterministic)', () => {
    expect(
      decide(
        [
          c('b', { lastAssignedAt: t('2026-11-27T10:00Z') }),
          c('a', { lastAssignedAt: t('2026-11-27T11:00Z') }),
        ],
        { strategy: 'LEAST_LOADED' },
      ).chosen,
    ).toBe('b');
    expect(decide([c('b'), c('a')], { strategy: 'LEAST_LOADED' }).chosen).toBe('a');
    expect(decide([c('a'), c('b')], { strategy: 'LEAST_LOADED' }).chosen).toBe('a');
  });

  it('round robin ignores load', () => {
    const d = decide(
      [
        c('a', { activeLeads: 0, lastAssignedAt: t('2026-11-27T11:00Z') }),
        c('b', { activeLeads: 40, lastAssignedAt: t('2026-11-27T10:00Z') }),
      ],
      { strategy: 'ROUND_ROBIN' },
    );
    expect(d.chosen).toBe('b');
  });

  it('explains every exclusion and returns null when nobody is eligible', () => {
    const d = decide(
      [
        c('away', { isAvailable: false }),
        c('leave', { onLeave: true }),
        c('full', { activeLeads: 5, maxActiveLeads: 5 }),
        c('hindi', { languages: ['hi'] }),
        c('prev'),
        c('other'),
      ],
      {
        strategy: 'LEAST_LOADED',
        leadLanguage: 'ml',
        exclude: new Set(['prev']),
        pool: new Set(['away', 'leave', 'full', 'hindi', 'prev']),
      },
    );
    expect(d.chosen).toBeNull();
    const why = Object.fromEntries(d.candidates.map((x) => [x.userId, x.excluded]));
    expect(why).toEqual({
      away: ['UNAVAILABLE'],
      leave: ['ON_LEAVE'],
      full: ['AT_CAPACITY'],
      hindi: ['LANGUAGE_MISMATCH'],
      prev: ['EXCLUDED'],
      other: ['NOT_IN_RULE_POOL'],
    });
  });

  it('users without languages accept any language', () => {
    expect(decide([c('any')], { strategy: 'LEAST_LOADED', leadLanguage: 'ar' }).chosen).toBe('any');
  });

  it('first matching active rule wins; empty conditions match anything', () => {
    const rules = [
      { id: 'off', active: false, courseIds: [], channels: [], languages: [], cities: [] },
      {
        id: 'ds-kochi',
        active: true,
        courseIds: ['ds'],
        channels: [],
        languages: [],
        cities: ['Kochi'],
      },
      {
        id: 'ads',
        active: true,
        courseIds: [],
        channels: ['GOOGLE_ADS', 'META_ADS'],
        languages: [],
        cities: [],
      },
      { id: 'all', active: true, courseIds: [], channels: [], languages: [], cities: [] },
    ];
    expect(
      matchRule(rules, { courseId: 'ds', channel: 'WEBSITE', language: null, city: 'kochi' })?.id,
    ).toBe('ds-kochi');
    expect(
      matchRule(rules, { courseId: 'ds', channel: 'META_ADS', language: null, city: 'Dubai' })?.id,
    ).toBe('ads');
    expect(
      matchRule(rules, { courseId: null, channel: 'WEBSITE', language: null, city: null })?.id,
    ).toBe('all');
  });
});
