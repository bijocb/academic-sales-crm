import { computeInsights, type ExecRow, type InsightInput } from './rules';

const fig = (fr: [number, number], cr: [number, number], adm: number) => ({
  firstResponse: { withinTarget: fr[0], started: fr[1] },
  contactRate: { connected: cr[0], cohort: cr[1] },
  admissions: { confirmed: adm },
});
const exec = (key: string, o: Partial<ExecRow> = {}): ExecRow => ({
  key,
  label: `Exec ${key}`,
  assigned: 20,
  contacted: 16,
  firstResponse: { started: 10, withinTarget: 9 },
  overdueTasks: 2,
  openLeads: 5,
  avgOpenLeadAgeDays: 3,
  ...o,
});
const base = (o: Partial<InsightInput> = {}): InsightInput => ({
  current: fig([18, 20], [16, 20], 8),
  previous: fig([18, 20], [16, 20], 8),
  executives: [exec('a'), exec('b'), exec('c')],
  sources: [],
  targets: [],
  ...o,
});
const kinds = (i: InsightInput) => computeInsights(i).map((x) => x.kind);

describe('management insight rules (A-051)', () => {
  it('a steady period gives no insights', () => {
    expect(computeInsights(base())).toEqual([]);
  });

  it('flags drops in first response, contact rate and admissions, with severity by size', () => {
    const r = computeInsights(
      base({ current: fig([10, 20], [12, 20], 3), previous: fig([18, 20], [16, 20], 8) }),
    );
    const by = Object.fromEntries(r.map((x) => [x.kind, x]));
    expect(by.FIRST_RESPONSE_DROP).toMatchObject({
      severity: 'HIGH',
      evidence: { current: 50, previous: 90, dropPoints: 40 },
    });
    expect(by.CONTACT_RATE_DROP.severity).toBe('HIGH'); // 80 → 60
    expect(by.ADMISSIONS_DROP).toMatchObject({
      severity: 'HIGH',
      evidence: { current: 3, previous: 8 },
    });
    expect(r[0].severity).toBe('HIGH'); // HIGH first
  });

  it('stays quiet on small samples', () => {
    expect(
      kinds(base({ current: fig([1, 5], [1, 5], 0), previous: fig([5, 5], [5, 5], 3) })),
    ).toEqual([]);
  });

  it('finds executives who need support', () => {
    const r = computeInsights(
      base({
        executives: [
          exec('a'),
          exec('b'),
          exec('c', {
            overdueTasks: 12,
            assigned: 20,
            contacted: 8,
            firstResponse: { started: 10, withinTarget: 4 },
          }),
          exec('none', { label: 'Unassigned', overdueTasks: 50 }),
        ],
      }),
    );
    expect(
      r
        .filter((x) => x.subject.id === 'c')
        .map((x) => x.kind)
        .sort(),
    ).toEqual(['EXEC_LOW_CONTACT', 'EXEC_OVERDUE', 'EXEC_SLA_BREACHES']);
    expect(r.find((x) => x.kind === 'EXEC_SLA_BREACHES')!.severity).toBe('HIGH'); // 60 % missed
    expect(r.some((x) => x.subject.id === 'none')).toBe(false); // "Unassigned" is not a person
  });

  it('compares cost per admission per currency and flags spend without admissions', () => {
    const spend = (minor: bigint) => [{ currency: 'INR', amountMinor: minor }];
    const r = computeInsights(
      base({
        sources: [
          {
            kind: 'campaign',
            current: [
              {
                key: 'x',
                label: 'Diwali ads',
                leadsCreated: 40,
                admissions: { confirmed: 2 },
                spend: spend(100_000_00n),
              },
              {
                key: 'y',
                label: 'Search',
                leadsCreated: 25,
                admissions: { confirmed: 0 },
                spend: spend(30_000_00n),
              },
            ],
            previous: [
              {
                key: 'x',
                label: 'Diwali ads',
                leadsCreated: 40,
                admissions: { confirmed: 4 },
                spend: spend(100_000_00n),
              },
            ],
          },
        ],
      }),
    );
    expect(r.find((x) => x.kind === 'SOURCE_COST_SPIKE')).toMatchObject({
      subject: { type: 'campaign', id: 'x' },
      evidence: { cpaNow: 'INR 50,000', cpaBefore: 'INR 25,000' },
    });
    expect(r.find((x) => x.kind === 'SOURCE_NO_ADMISSIONS')!.subject.id).toBe('y');
  });

  it('targets behind linear pace after a quarter of the period', () => {
    const t = (achieved: bigint, elapsed: number) => ({
      id: 't',
      label: 'Admissions target — Team A',
      metric: 'ADMISSIONS',
      value: 40n,
      achieved,
      currency: null,
      elapsed,
    });
    expect(kinds(base({ targets: [t(5n, 0.2)] }))).toEqual([]); // too early
    expect(kinds(base({ targets: [t(17n, 0.5)] }))).toEqual([]); // 85 % of pace
    const r = computeInsights(base({ targets: [t(8n, 0.5)] })); // 40 % of pace
    expect(r[0]).toMatchObject({
      kind: 'TARGET_AT_RISK',
      severity: 'HIGH',
      evidence: { pacePct: 40 },
    });
  });

  it('old open leads in scope', () => {
    const r = computeInsights(
      base({
        executives: [
          exec('a', { openLeads: 8, avgOpenLeadAgeDays: 20 }),
          exec('b', { openLeads: 4, avgOpenLeadAgeDays: 10 }),
        ],
      }),
    );
    expect(r.find((x) => x.kind === 'STUCK_LEADS')!.evidence).toEqual({
      openLeads: 12,
      avgAgeDays: 17,
    });
  });
});
