import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

const MIN = 60_000;
const DAY = 86_400_000;

/**
 * Phase 13 exit gate: report values reconcile to a fixed fixture and to the underlying records.
 *
 * Fixture (week 2026-11-30 … 2026-12-06, brand B1 = INR / Asia/Kolkata, B2 = AED / Asia/Dubai):
 *   L1 B1 campaign C1 → e1, connected by e1, admission paid 20,000.00 INR
 *   L2 B1 campaign C1 → e2, connected by e2, reassigned to e1, admission paid 50,000.00 INR (split e2 / e1)
 *   L3 B1             → e1, no answer, lost
 *   L4 B1             → e3 (other team), connected by e3, paid 10,000.00 INR, fully refunded → cancelled
 *   L5 B1             unassigned
 *   M1 B2             → e4, connected by e4, paid 1,000.00 AED
 * Every course fee is 1,00,000.00 INR / 5,000.00 AED.
 */
describe('Reports, targets and incentives', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  const key: Record<string, string> = {};
  const course: Record<string, string> = {};
  const batch: Record<string, string> = {};
  const L: Record<string, { leadId: string; admissionId?: string; planId?: string }> = {};
  let c1 = '';
  let srcB1 = '';
  const MON_11 = new Date('2026-11-30T05:30:00Z');
  const WEEK = 'from=2026-11-30&to=2026-12-06';
  const WEEK2 = 'from=2026-12-07&to=2026-12-13';

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const patch = (who: string, url: string, body: object) =>
    ctx.http().patch(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const tick = (min: number) => ctx.clock.set(new Date(ctx.clock.now().getTime() + min * MIN));
  let n = 0;

  const newLead = async (brand: 'B1' | 'B2', name: string, campaignId?: string) => {
    n++;
    const res = await ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${key[brand]}`)
      .send({
        name,
        phone:
          brand === 'B1' ? `+91 90000 ${String(80000 + n)}` : `+971 50 000 ${String(1000 + n)}`,
        ...(campaignId ? { campaignId } : {}),
      });
    expect(res.status).toBe(201);
    const e = await ctx.owner.enquiry.findUniqueOrThrow({ where: { id: res.body.reference } });
    return e.leadId;
  };
  const assign = async (manager: string, leadId: string, userId: string) =>
    expect(
      (await post(manager, `/leads/${leadId}/assign`, { userId, reason: 'Test' })).status,
    ).toBeLessThan(300);
  const call = async (who: string, leadId: string, outcome = 'CONNECTED') => {
    tick(3);
    const r = await post(who, `/leads/${leadId}/calls`, {
      startedAt: new Date(ctx.clock.now().getTime() - MIN).toISOString(),
      durationSec: 60,
      outcome,
    });
    expect(r.status).toBe(201);
  };
  const admit = async (who: string, leadId: string, brand: 'B1' | 'B2') => {
    const q = await post(who, `/leads/${leadId}/quotations`, {
      courseId: course[brand],
      batchId: batch[brand],
    });
    expect(q.status).toBe(201);
    expect((await post(who, `/quotations/${q.body.id}/accept`)).status).toBeLessThan(300);
    const adm = await post(who, `/leads/${leadId}/admission`);
    expect(adm.status).toBe(201);
    const fin = await get(who, `/admissions/${adm.body.id}/finance`);
    return { leadId, admissionId: adm.body.id as string, planId: fin.body.plan.id as string };
  };
  const pay = async (planId: string, amountMinor: number) => {
    const r = await post('acc1', `/fee-plans/${planId}/payments`, {
      amountMinor,
      method: 'UPI',
      reference: `UPI-${planId.slice(0, 6)}-${amountMinor}`,
      receivedAt: ctx.clock.now().toISOString(),
    });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const refundAll = async (paymentId: string, amountMinor: number, paidOn: string) => {
    const r = await post('acc1', `/payments/${paymentId}/refunds`, {
      amountMinor,
      reason: 'Student withdrew',
    });
    expect(r.status).toBe(201);
    expect((await post('acc2', `/refunds/${r.body.id}/approve`)).status).toBeLessThan(300);
    expect(
      (
        await post('acc2', `/refunds/${r.body.id}/paid`, {
          method: 'UPI',
          reference: `R-${paymentId.slice(0, 6)}`,
          paidOn,
        })
      ).status,
    ).toBeLessThan(300);
  };
  const summary = async (who: string, q = '') => {
    const r = await get(who, `/reports/summary?${WEEK}${q}`);
    expect(r.status).toBe(200);
    return r.body;
  };
  type Rev = { currency: string; collectedMinor: number; refundedMinor: number; netMinor: number };
  const rev = (m: { revenue: Rev[] }, cur: string) => m.revenue.find((r) => r.currency === cur);
  const payIds: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'rep-a');
    const users: Array<[string, Parameters<typeof createUser>[3]]> = [
      ['admin', [{ role: 'ORG_ADMIN', scope: 'ORGANIZATION' }]],
      ['bm1', [{ role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B1' }]],
      ['bm2', [{ role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B2' }]],
      ['tl1', [{ role: 'TEAM_LEADER', scope: 'TEAM', brand: 'B1' }]],
      ['e1', [{ role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' }]],
      ['e2', [{ role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' }]],
      ['e3', [{ role: 'SALES_EXECUTIVE', scope: 'BRAND', brand: 'B1' }]],
      ['e4', [{ role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B2' }]],
      ['acc1', [{ role: 'ACCOUNTS_OFFICER', scope: 'ORGANIZATION' }]],
      ['acc2', [{ role: 'ACCOUNTS_OFFICER', scope: 'ORGANIZATION' }]],
      ['mkt', [{ role: 'MARKETING_MANAGER', scope: 'BRAND', brand: 'B1' }]],
      ['viewer', [{ role: 'MANAGEMENT_VIEWER', scope: 'ORGANIZATION' }]],
    ];
    for (const [k, grants] of users) {
      id[k] = await createUser(ctx.owner, a, `${k}@rep.test`, grants);
      t[k] = await bearer(ctx, `${k}@rep.test`);
    }
    // e3 works in a second B1 team, outside the team leader's team.
    const team2 = await ctx.owner.team.create({
      data: {
        organizationId: a.orgId,
        brandId: a.brands.B1,
        branchId: a.branches.B1,
        name: 'Team B1 North',
      },
    });
    await ctx.owner.teamMember.create({
      data: { organizationId: a.orgId, teamId: team2.id, userId: id.e3 },
    });
    ctx.clock.set(MON_11);
    for (const [brand, cur, fee] of [
      ['B1', 'INR', 10_000_000n],
      ['B2', 'AED', 500_000n],
    ] as const) {
      const src = await ctx.owner.leadSource.findFirstOrThrow({
        where: { brandId: a.brands[brand], channel: 'WEBSITE' },
      });
      if (brand === 'B1') srcB1 = src.id;
      key[brand] = (
        await post('admin', '/intake-keys', { sourceId: src.id, name: `web-${brand}` })
      ).body.key;
      course[brand] = (
        await ctx.owner.course.create({
          data: {
            organizationId: a.orgId,
            brandId: a.brands[brand],
            code: `C-${brand}`,
            name: `Course ${brand}`,
            deliveryMode: 'ONLINE',
            currency: cur,
            listFeeMinor: fee,
          },
        })
      ).id;
      batch[brand] = (
        await ctx.owner.batch.create({
          data: {
            organizationId: a.orgId,
            brandId: a.brands[brand],
            courseId: course[brand],
            code: `${brand}-JAN`,
            name: 'January',
            startDate: new Date('2027-01-11'),
            capacity: 50,
            status: 'OPEN',
          },
        })
      ).id;
    }
    c1 = (
      await ctx.owner.campaign.create({
        data: { organizationId: a.orgId, brandId: a.brands.B1, sourceId: srcB1, name: 'C1 Search' },
      })
    ).id;

    // --- the fixture week
    L.L1 = { leadId: await newLead('B1', 'Asha One', c1) };
    L.L2 = { leadId: await newLead('B1', 'Bala Two', c1) };
    L.L3 = { leadId: await newLead('B1', 'Chitra Three') };
    L.L4 = { leadId: await newLead('B1', 'Dev Four') };
    L.L5 = { leadId: await newLead('B1', '=HYPERLINK("x")') };
    L.M1 = { leadId: await newLead('B2', 'Meera Dubai') };
    await assign('bm1', L.L1.leadId, id.e1);
    await assign('bm1', L.L2.leadId, id.e2);
    await assign('bm1', L.L3.leadId, id.e1);
    await assign('bm1', L.L4.leadId, id.e3);
    await assign('bm2', L.M1.leadId, id.e4);
    await call('e1', L.L1.leadId);
    await call('e2', L.L2.leadId);
    await call('e1', L.L3.leadId, 'NO_ANSWER');
    await call('e3', L.L4.leadId);
    await call('e4', L.M1.leadId);
    tick(60);
    await assign('bm1', L.L2.leadId, id.e1); // reassignment
    const reason = await ctx.owner.lossReason.findFirstOrThrow({
      where: { brandId: a.brands.B1, code: 'FEE_TOO_HIGH' },
    });
    expect(
      (
        await post('e1', `/leads/${L.L3.leadId}/lost`, {
          lossReasonId: reason.id,
          notes: 'Wants a cheaper option',
          plan: 'RECOVER',
        })
      ).status,
    ).toBe(201);
    tick(60);
    Object.assign(L.L1, await admit('e1', L.L1.leadId, 'B1'));
    Object.assign(L.L2, await admit('e1', L.L2.leadId, 'B1'));
    Object.assign(L.L4, await admit('e3', L.L4.leadId, 'B1'));
    Object.assign(L.M1, await admit('e4', L.M1.leadId, 'B2'));
    payIds.L1 = await pay(L.L1.planId!, 2_000_000);
    payIds.L2 = await pay(L.L2.planId!, 5_000_000);
    payIds.L4 = await pay(L.L4.planId!, 1_000_000);
    payIds.M1 = await pay(L.M1.planId!, 100_000);
    tick(DAY / MIN);
    await refundAll(payIds.L4, 1_000_000, '2026-12-01');
    for (const k of ['L1', 'L2', 'M1'])
      expect(
        (await ctx.owner.admission.findUniqueOrThrow({ where: { id: L[k].admissionId } })).status,
      ).toBe('CONFIRMED');
    expect(
      (await ctx.owner.admission.findUniqueOrThrow({ where: { id: L.L4.admissionId } })).status,
    ).toBe('CANCELLED_REFUNDED');
  }, 120_000);
  afterAll(() => ctx.close());

  it('brand summary: every KPI equals the hand-computed value, with its period and date basis', async () => {
    const s = await summary('bm1');
    expect(s).toMatchObject({ from: '2026-11-30', to: '2026-12-06', timezone: 'Asia/Kolkata' });
    expect(s.dateBasis.admissions).toMatch(/A-007c/);
    const m = s.metrics;
    expect(m).toMatchObject({
      leadsCreated: 5,
      assigned: 4,
      contacted: 3,
      contactRate: { cohort: 4, connected: 3, pct: 75 },
      reassigned: 1,
      lost: 1,
      recovered: 0,
      quotationsAccepted: 3,
      admissions: { confirmed: 3, cancelled: 1, net: 2, firstContact: 3 },
    });
    expect(m.revenue).toEqual([
      { currency: 'INR', collectedMinor: 8_000_000, refundedMinor: 1_000_000, netMinor: 7_000_000 },
    ]);
    // Outstanding (snapshot): L1 80,000.00 + L2 50,000.00; the cancelled admission owes nothing.
    expect(m.outstanding).toEqual([{ currency: 'INR', outstandingMinor: 13_000_000 }]);
    // First-response SLA: one clock per assigned lead, all answered within minutes.
    const slas = await ctx.owner.slaInstance.findMany({
      where: { brandId: a.brands.B1, state: { not: 'CANCELLED' } },
    });
    expect(m.firstResponse.started).toBe(slas.length);
    expect(slas.length).toBe(4);
    expect(m.firstResponse.withinTarget).toBe(
      slas.filter((x) => x.state === 'RESOLVED' && !x.breachedAt).length,
    );
    expect(m.firstResponse.breached).toBe(0);
    // Funnel starts with the leads created; Admission Confirmed = 3 distinct leads.
    expect(s.funnel[0]).toEqual({ stage: 'NEW_ENQUIRY', leads: 5 });
    expect(s.funnel.find((f: { stage: string }) => f.stage === 'ADMISSION_CONFIRMED').leads).toBe(
      3,
    );
  });

  it('organization view keeps currencies apart; a brand outside scope is not found', async () => {
    const m = (await summary('admin')).metrics;
    expect(m.leadsCreated).toBe(6);
    expect(m.admissions).toMatchObject({ confirmed: 4, cancelled: 1, net: 3 });
    expect(m.revenue).toEqual([
      { currency: 'AED', collectedMinor: 100_000, refundedMinor: 0, netMinor: 100_000 },
      { currency: 'INR', collectedMinor: 8_000_000, refundedMinor: 1_000_000, netMinor: 7_000_000 },
    ]);
    expect(m.outstanding).toEqual(
      expect.arrayContaining([
        { currency: 'INR', outstandingMinor: 13_000_000 },
        { currency: 'AED', outstandingMinor: 400_000 },
      ]),
    );
    const b2 = await summary('admin', `&brandId=${a.brands.B2}`);
    expect(b2.timezone).toBe('Asia/Dubai');
    expect(b2.metrics.revenue.map((r: { currency: string }) => r.currency)).toEqual(['AED']);
    expect((await get('bm1', `/reports/summary?${WEEK}&brandId=${a.brands.B2}`)).status).toBe(404);
    // The same numbers come from the underlying tables.
    const inr = await ctx.owner.payment.aggregate({
      where: { currency: 'INR', organizationId: a.orgId },
      _sum: { amountMinor: true },
    });
    expect(Number(inr._sum.amountMinor)).toBe(rev(m, 'INR')!.collectedMinor);
  });

  it('breakdown rows add up to the totals for every dimension', async () => {
    const total = (await summary('bm1')).metrics;
    for (const by of ['executive', 'course', 'source', 'campaign', 'brand']) {
      const b = await get('bm1', `/reports/breakdown?${WEEK}&by=${by}`);
      expect(b.status).toBe(200);
      const sum = (f: (r: never) => number) =>
        (b.body.rows as never[]).reduce((s: number, r) => s + f(r), 0);
      expect(sum((r: { leadsCreated: number }) => r.leadsCreated)).toBe(total.leadsCreated);
      expect(sum((r: { admissions: { confirmed: number } }) => r.admissions.confirmed)).toBe(
        total.admissions.confirmed,
      );
      expect(sum((r: { admissions: { cancelled: number } }) => r.admissions.cancelled)).toBe(
        total.admissions.cancelled,
      );
      expect(
        sum(
          (r: { revenue: Array<{ currency: string; netMinor: number }> }) =>
            r.revenue.find((x) => x.currency === 'INR')?.netMinor ?? 0,
        ),
      ).toBe(rev(total, 'INR')!.netMinor);
      if (by !== 'executive') {
        // A lead has one brand / course / first-touch source, so distinct counts also add up.
        expect(sum((r: { assigned: number }) => r.assigned)).toBe(total.assigned);
        expect(sum((r: { contacted: number }) => r.contacted)).toBe(total.contacted);
      }
    }
    const exec = (await get('bm1', `/reports/breakdown?${WEEK}&by=executive`)).body.rows;
    const row = (u: string) => exec.find((r: { key: string }) => r.key === id[u]);
    expect(row('e1').admissions).toEqual({ confirmed: 2, cancelled: 0, firstContact: 1 });
    expect(row('e2').admissions).toEqual({ confirmed: 0, cancelled: 0, firstContact: 1 });
    expect(row('e3').admissions).toEqual({ confirmed: 1, cancelled: 1, firstContact: 1 });
    expect(exec.find((r: { key: string }) => r.key === 'none')).toMatchObject({
      label: 'Unassigned',
      leadsCreated: 1,
    });
  });

  it('CPL and CPA come from manual ad spend (campaign manage only); first-touch campaign attribution', async () => {
    expect(
      (await post('e1', '/ad-spend', { campaignId: c1, month: '2026-12', amountMinor: 1 })).status,
    ).toBe(403);
    const r = await post('mkt', '/ad-spend', {
      campaignId: c1,
      month: '2026-12',
      amountMinor: 900_000,
    });
    expect(r.status).toBe(201);
    // Correcting the month replaces the amount (one row per campaign and month).
    await post('mkt', '/ad-spend', { campaignId: c1, month: '2026-12', amountMinor: 1_000_000 });
    expect(await ctx.owner.adSpend.count({ where: { campaignId: c1 } })).toBe(1);
    const b = (await get('bm1', `/reports/breakdown?${WEEK}&by=campaign`)).body.rows;
    const c = b.find((x: { key: string }) => x.key === c1);
    expect(c).toMatchObject({
      label: 'C1 Search',
      leadsCreated: 2,
      admissions: { confirmed: 2 },
      spend: [{ currency: 'INR', amountMinor: 1_000_000 }],
      cpl: [{ currency: 'INR', minor: 500_000 }],
      cpa: [{ currency: 'INR', minor: 500_000 }],
    });
    const s = (await get('bm1', `/reports/breakdown?${WEEK}&by=source`)).body.rows;
    expect(s.find((x: { key: string }) => x.key === srcB1)).toMatchObject({
      leadsCreated: 5,
      cpl: [{ currency: 'INR', minor: 200_000 }],
    });
    const f = await summary('bm1', `&campaignId=${c1}`);
    expect(f.metrics).toMatchObject({ leadsCreated: 2, admissions: { confirmed: 2 } });
  });

  it('drill-down lists exactly the records behind each number', async () => {
    const m = (await summary('bm1')).metrics;
    const expected: Record<string, number> = {
      leadsCreated: m.leadsCreated,
      assigned: m.assigned,
      contacted: m.contacted,
      lost: m.lost,
      recovered: m.recovered,
      admissionsConfirmed: m.admissions.confirmed,
      payments: 3,
      overdueTasks: m.overdueTasks,
    };
    for (const [metric, count] of Object.entries(expected)) {
      const d = await get('bm1', `/reports/drilldown?${WEEK}&metric=${metric}`);
      expect(d.status).toBe(200);
      expect([metric, d.body.rows.length]).toEqual([metric, count]);
    }
    const p = (await get('bm1', `/reports/drilldown?${WEEK}&metric=payments`)).body.rows;
    expect(p.reduce((s: number, r: { amountMinor: number }) => s + r.amountMinor, 0)).toBe(
      rev(m, 'INR')!.collectedMinor,
    );
    const adm = (await get('bm1', `/reports/drilldown?${WEEK}&metric=admissionsConfirmed`)).body
      .rows;
    expect(adm.map((r: { leadId: string }) => r.leadId).sort()).toEqual(
      [L.L1.leadId, L.L2.leadId, L.L4.leadId].sort(),
    );
  });

  it('team leader sees the team only; executives see only their own numbers', async () => {
    const team = (await summary('tl1')).metrics;
    expect(team).toMatchObject({
      leadsCreated: 3,
      assigned: 3,
      contacted: 2,
      admissions: { confirmed: 2, cancelled: 0 },
      outstanding: [],
    });
    expect(team.revenue).toEqual([
      { currency: 'INR', collectedMinor: 7_000_000, refundedMinor: 0, netMinor: 7_000_000 },
    ]);
    expect((await get('tl1', `/reports/summary?${WEEK}&userId=${id.e3}`)).status).toBe(404);

    const e2 = (await summary('e2')).metrics;
    expect(e2).toMatchObject({
      leadsCreated: 0,
      assigned: 1,
      contacted: 1,
      admissions: { confirmed: 0, firstContact: 1 },
      revenue: [],
    });
    const e3 = (await summary('e3')).metrics;
    expect(e3).toMatchObject({
      contacted: 1,
      admissions: { confirmed: 1, cancelled: 1, net: 0 },
      revenue: [{ currency: 'INR', netMinor: 0 }],
    });
    // Asking for someone else's numbers or a team view does not widen an executive's scope.
    expect((await get('e2', `/reports/summary?${WEEK}&userId=${id.e1}`)).status).toBe(404);
    expect((await summary('e2', `&teamId=${a.teams.B1}`)).metrics.assigned).toBe(1);
    const d = (await get('e2', `/reports/drilldown?${WEEK}&metric=assigned`)).body.rows;
    expect(d.map((r: { leadId: string }) => r.leadId)).toEqual([L.L2.leadId]);
    // A manager's own dashboard.
    expect((await summary('bm1', '&mine=true')).metrics.leadsCreated).toBe(0);
  });

  it('personal performance report: own numbers vs previous period, daily trend, funnel, anonymous team average', async () => {
    const r = await get('e1', `/reports/me?${WEEK}`);
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.previousPeriod).toEqual({ from: '2026-11-23', to: '2026-11-29' });
    // e1 owns L1 and L3 and received L2 on reassignment; connected L1; closed L1 and L2.
    expect(b.current).toMatchObject({
      assigned: 3,
      contacted: 1,
      admissions: { confirmed: 2, cancelled: 0 },
    });
    expect(b.previous).toMatchObject({ assigned: 0, contacted: 0, admissions: { confirmed: 0 } });
    expect(b.trend).toHaveLength(7);
    const sum = (k: string) =>
      b.trend.reduce((x: number, d: Record<string, number>) => x + d[k], 0);
    expect(sum('assigned')).toBe(3);
    expect(sum('contacted')).toBe(1);
    expect(sum('admissions')).toBe(2);
    expect(b.funnel.map((f: { leads: number }) => f.leads)).toEqual([3, 1, 0, 2, 2]);
    // Team B1 = tl1, e1, e2: totals 3 assigned, 2 contacted, 2 admissions, INR 70,000.00 net → ÷ 3.
    expect(b.teamAverage).toMatchObject({
      members: 3,
      hidden: false,
      assigned: 1,
      contacted: 0.7,
      admissionsConfirmed: 0.7,
      revenue: [{ currency: 'INR', netMinor: 2_333_333 }],
    });
    // Aggregates only: no colleague is identified.
    const text = JSON.stringify(b);
    for (const other of ['e2', 'tl1', 'e3']) expect(text).not.toContain(id[other]);
    // A one-person team gets no average (it would expose the person's own numbers as "the team").
    expect((await get('e3', `/reports/me?${WEEK}`)).body.teamAverage).toEqual({
      members: 1,
      hidden: true,
    });
  });

  it('targets: progress uses the same KPIs; only target managers create or change them; audited', async () => {
    const body = {
      scope: 'USER',
      userId: id.e1,
      metric: 'ADMISSIONS',
      periodStart: '2026-11-30',
      periodEnd: '2026-12-06',
      value: 5,
    };
    expect((await post('e1', '/targets', body)).status).toBe(403);
    const u = await post('bm1', '/targets', { ...body, brandId: a.brands.B1 });
    expect(u.status).toBe(201);
    const money = await post('bm1', '/targets', {
      scope: 'BRAND',
      brandId: a.brands.B1,
      metric: 'REVENUE',
      currency: 'INR',
      periodStart: '2026-11-30',
      periodEnd: '2026-12-06',
      value: 10_000_000,
    });
    expect(money.status).toBe(201);
    const team = await post('bm1', '/targets', {
      scope: 'TEAM',
      teamId: a.teams.B1,
      metric: 'CONTACTED',
      periodStart: '2026-11-30',
      periodEnd: '2026-12-06',
      value: 10,
    });
    expect(team.status).toBe(201);
    expect(
      (
        await post('bm1', '/targets', {
          ...body,
          metric: 'COLLECTIONS',
        })
      ).status,
    ).toBe(400); // money target without a currency

    const mine = (await get('e1', '/targets?periodStart=2026-11-30&periodEnd=2026-12-06')).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: u.body.id, achieved: 2, value: 5 });
    const all = (await get('bm1', '/targets?periodStart=2026-11-30&periodEnd=2026-12-06')).body;
    const by = (x: string) => all.find((r: { id: string }) => r.id === x);
    expect(by(money.body.id).achieved).toBe(7_000_000);
    expect(by(team.body.id).achieved).toBe(2);

    expect((await patch('e1', `/targets/${u.body.id}`, { value: 1 })).status).toBe(403);
    expect((await patch('bm1', `/targets/${u.body.id}`, { value: 4 })).body.value).toBe(4);
    expect(
      await ctx.owner.auditLog.count({
        where: { entityId: u.body.id, action: { in: ['target.created', 'target.updated'] } },
      }),
    ).toBe(2);
  });

  describe('incentives', () => {
    let rule = '';
    let approvedRun = '';

    it('preview splits each admission between first contact and closer (A-005b), stores its inputs', async () => {
      const r = await post('bm1', '/incentive-rules', {
        brandId: a.brands.B1,
        name: 'Admissions',
        basis: 'PER_ADMISSION',
        amountMinor: 100_000,
        effectiveFrom: '2026-11-01',
      });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ version: 1, firstContactSharePct: 50, currency: 'INR' });
      rule = r.body.id;
      expect(
        (
          await post('e1', '/incentive-runs', {
            ruleId: rule,
            periodStart: '2026-11-30',
            periodEnd: '2026-12-06',
          })
        ).status,
      ).toBe(403);
      const run = await post('bm1', '/incentive-runs', {
        ruleId: rule,
        periodStart: '2026-11-30',
        periodEnd: '2026-12-06',
      });
      expect(run.status).toBe(201);
      expect(run.body).toMatchObject({ status: 'DRAFT', totalMinor: 300_000, currency: 'INR' });
      const line = (u: string) =>
        run.body.lines.find((l: { userId: string }) => l.userId === id[u]);
      expect(line('e1')).toMatchObject({ kind: 'EARNED', amountMinor: 150_000 });
      expect(line('e2')).toMatchObject({ kind: 'EARNED', amountMinor: 50_000 });
      expect(line('e3')).toMatchObject({ kind: 'EARNED', amountMinor: 100_000 });
      expect(line('e1').inputs).toMatchObject({ ruleVersion: 1, admissions: 2 });
      expect(
        line('e1')
          .inputs.credits.map((c: { ref: string }) => c.ref)
          .sort(),
      ).toEqual([L.L1.admissionId, L.L2.admissionId].sort());
      approvedRun = run.body.id;
    });

    it('a new version applies a threshold and a cap per person', async () => {
      const v2 = await post('bm1', '/incentive-rules', {
        brandId: a.brands.B1,
        name: 'Admissions',
        basis: 'PER_ADMISSION',
        amountMinor: 100_000,
        thresholdCount: 2,
        capMinor: 120_000,
        effectiveFrom: '2026-11-01',
      });
      expect(v2.body.version).toBe(2);
      const run = await post('bm1', '/incentive-runs', {
        ruleId: v2.body.id,
        periodStart: '2026-11-30',
        periodEnd: '2026-12-06',
      });
      const line = (u: string) =>
        run.body.lines.find((l: { userId: string }) => l.userId === id[u]);
      expect(line('e1')).toMatchObject({ amountMinor: 120_000 });
      expect(line('e1').inputs).toMatchObject({ thresholdMet: true, capped: true });
      expect(line('e2')).toMatchObject({ amountMinor: 0 });
      expect(line('e2').inputs.thresholdMet).toBe(false);
      expect(run.body.totalMinor).toBe(120_000);
      const pct = await post('bm1', '/incentive-rules', {
        brandId: a.brands.B1,
        name: 'Collections',
        basis: 'PERCENT_OF_COLLECTIONS',
        percentBp: 100,
        firstContactSharePct: 0,
        effectiveFrom: '2026-11-01',
      });
      const pr = await post('bm1', '/incentive-runs', {
        ruleId: pct.body.id,
        periodStart: '2026-11-30',
        periodEnd: '2026-12-06',
      });
      // 1 % of net collections, all to the closer: e1 70,000.00 → 700.00; e3 10,000.00 − 10,000.00 → 0.
      const pl = (u: string) => pr.body.lines.find((l: { userId: string }) => l.userId === id[u]);
      expect(pl('e1').amountMinor).toBe(70_000);
      expect(pl('e3').amountMinor).toBe(0);
      expect(pl('e2')).toBeUndefined();
    });

    it('approval is by someone else and locks the run', async () => {
      expect((await post('bm1', `/incentive-runs/${approvedRun}/approve`)).status).toBe(403);
      const ok = await post('admin', `/incentive-runs/${approvedRun}/approve`);
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ status: 'APPROVED', approvedById: id.admin });
      expect((await post('admin', `/incentive-runs/${approvedRun}/approve`)).status).toBe(409);
      await expect(
        ctx.owner.$executeRawUnsafe(
          `UPDATE incentive_runs SET total_minor = 1 WHERE id = '${approvedRun}'`,
        ),
      ).rejects.toThrow();
      await expect(
        ctx.owner.$executeRawUnsafe(
          `UPDATE incentive_lines SET amount_minor = 1 WHERE run_id = '${approvedRun}'`,
        ),
      ).rejects.toThrow();
      await expect(
        ctx.owner.$executeRawUnsafe(`DELETE FROM incentive_rules WHERE id = '${rule}'`),
      ).rejects.toThrow();
      expect((await get('e1', `/incentive-runs/${approvedRun}`)).status).toBe(404);
    });

    it('a refund after approval claws back in the next run (A-007c); the approved run is unchanged', async () => {
      ctx.clock.set(new Date('2026-12-08T05:30:00Z'));
      await refundAll(payIds.L1, 2_000_000, '2026-12-08');
      const run = await post('bm1', '/incentive-runs', {
        ruleId: rule,
        periodStart: '2026-12-07',
        periodEnd: '2026-12-13',
      });
      expect(run.status).toBe(201);
      expect(run.body.lines).toEqual([
        expect.objectContaining({
          userId: id.e1,
          kind: 'CLAWBACK',
          amountMinor: -100_000,
          inputs: expect.objectContaining({ admissionIds: [L.L1.admissionId] }),
        }),
      ]);
      expect(run.body.totalMinor).toBe(-100_000);
      expect((await get('bm1', `/incentive-runs/${approvedRun}`)).body.totalMinor).toBe(300_000);
      // Event-dated: the earlier week keeps its admissions; the new week shows the cancellation.
      expect((await summary('bm1')).metrics.admissions.confirmed).toBe(3);
      const w2 = (await get('bm1', `/reports/summary?${WEEK2}`)).body.metrics;
      expect(w2.admissions).toMatchObject({ confirmed: 0, cancelled: 1, net: -1 });
      expect(w2.revenue).toEqual([
        { currency: 'INR', collectedMinor: 0, refundedMinor: 2_000_000, netMinor: -2_000_000 },
      ]);
    });
  });

  it('CSV export needs report.export, neutralises formulas and is audited with its filters', async () => {
    expect((await get('viewer', `/reports/export?${WEEK}&report=summary`)).status).toBe(403);
    const s = await get('bm1', `/reports/export?${WEEK}&report=summary`);
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toMatch(/text\/csv/);
    expect(s.text).toContain('"Leads created","5"');
    const d = await get('bm1', `/reports/export?${WEEK}&report=drilldown&metric=leadsCreated`);
    expect(d.text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(d.text.trim().split('\r\n')).toHaveLength(6);
    const logs = await ctx.owner.auditLog.findMany({
      where: { organizationId: a.orgId, action: 'report.exported' },
    });
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => (l.after as { report: string }).report).sort()).toEqual([
      'drilldown',
      'summary',
    ]);
  });
});
