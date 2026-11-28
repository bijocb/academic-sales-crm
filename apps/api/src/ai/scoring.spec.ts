import {
  bandForProbability,
  bandForRules,
  FACTOR_KEYS,
  Features,
  predict,
  PROHIBITED,
  rules,
  train,
  usable,
} from './scoring';

const base: Features = {
  channel: 'WEBSITE',
  paidCampaign: 'no',
  courseChosen: 'no',
  repeatEnquiry: '1',
  firstResponse: 'none',
  connected3d: 'no',
};
const sample = (connected: boolean, converted: boolean) => ({
  features: { ...base, connected3d: connected ? ('yes' as const) : ('no' as const) },
  converted,
});

describe('explainable scoring', () => {
  // 5 connected (4 converted), 5 not connected (1 converted).
  const stats = train([
    ...Array.from({ length: 4 }, () => sample(true, true)),
    sample(true, false),
    sample(false, true),
    ...Array.from({ length: 4 }, () => sample(false, false)),
  ]);

  it('matches the hand-computed naive Bayes probability; factors add up to the log-odds', () => {
    expect(stats).toMatchObject({ n: 10, positives: 5 });
    const r = predict(stats, { ...base, connected3d: 'yes' });
    // prior ln(6/6) = 0; constant factors cancel; connected: ln(5/7) − ln(2/7) = ln 2.5.
    expect(r.prior).toBe(0);
    expect(r.contributions.find((c) => c.factor === 'connected3d')!.weight).toBeCloseTo(
      Math.log(2.5),
      3,
    );
    expect(r.probability).toBeCloseTo(5 / 7, 3);
    const sum = r.prior + r.contributions.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBeCloseTo(r.logit, 2);
    expect(predict(stats, base).probability).toBeCloseTo(2 / 7, 3);
  });

  it('needs enough history with both outcomes before the model is used', () => {
    expect(usable(stats, 50)).toBe(false);
    expect(usable(stats, 10)).toBe(true);
    expect(usable(train(Array.from({ length: 60 }, () => sample(true, true))), 50)).toBe(false);
  });

  it('rules fallback is transparent and banded', () => {
    expect(rules(base).score).toBe(20);
    expect(rules({ ...base, connected3d: 'yes', courseChosen: 'yes' }).score).toBe(65);
    expect(bandForRules(65)).toBe('HIGH');
    expect(bandForRules(35)).toBe('MEDIUM');
    expect(bandForRules(20)).toBe('LOW');
    expect(bandForProbability(0.25, 2500, 1000)).toBe('HIGH');
    expect(bandForProbability(0.1, 2500, 1000)).toBe('MEDIUM');
    expect(bandForProbability(0.0999, 2500, 1000)).toBe('LOW');
  });

  it('bias review: no personal or sensitive attribute is a factor', () => {
    const lower = FACTOR_KEYS.map((k) => k.toLowerCase());
    for (const p of PROHIBITED) expect(lower).not.toContain(p.toLowerCase());
    expect([...FACTOR_KEYS].sort()).toEqual(
      [
        'channel',
        'connected3d',
        'courseChosen',
        'firstResponse',
        'paidCampaign',
        'repeatEnquiry',
      ].sort(),
    );
  });
});
