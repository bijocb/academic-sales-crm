import { AiService } from '../src/ai/ai.service';
import { JobsService } from '../src/jobs/jobs.service';
import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

const DAY = 86_400_000;
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Phase 14 exit gate: AI outage fallback, audit and bias/safety review.
 *
 * History (brand B1, website, created 30 days ago): 20 leads connected within 3 days (16 converted, 4 lost) and
 * 40 not connected (4 converted, 36 lost). Hand-computed with Laplace smoothing:
 *   prior = ln(21/41); each constant factor ln(21/22) − ln(41/42); not connected ln(5/22) − ln(37/42)
 *   → a new, not-yet-connected website lead: logit −2.136, probability 10.56 % (MEDIUM at the default 10 % / 25 %).
 */
describe('AI assistance', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  let ai: AiService;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  let key = '';
  let src = '';
  let course = '';
  const MON_11 = new Date('2026-11-30T05:30:00Z');

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const put = (who: string, url: string, body: object) =>
    ctx.http().put(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  let n = 0;
  const newLead = async (name: string, phone?: string) => {
    n++;
    const r = await ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${key}`)
      .send({ name, phone: phone ?? `+91 90000 ${String(60000 + n)}` });
    expect(r.status).toBe(201);
    const e = await ctx.owner.enquiry.findUniqueOrThrow({ where: { id: r.body.reference } });
    await post('bm1', `/leads/${e.leadId}/assign`, { userId: id.e1, reason: 'Test' });
    return e.leadId;
  };
  const panel = async (who: string, leadId: string) => {
    const r = await get(who, `/leads/${leadId}/ai`);
    expect(r.status).toBe(200);
    return r.body;
  };
  const settings = {
    enabled: true,
    scoringEnabled: true,
    nextActionsEnabled: true,
    highThresholdBp: 2500,
    mediumThresholdBp: 1000,
    minTrainingSize: 50,
  };
  const L: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'ai-a');
    for (const [k, role, scope] of [
      ['admin', 'ORG_ADMIN', 'ORGANIZATION'],
      ['bm1', 'BRAND_MANAGER', 'BRAND'],
      ['e1', 'SALES_EXECUTIVE', 'TEAM'],
      ['e2', 'SALES_EXECUTIVE', 'TEAM'],
    ] as const) {
      id[k] = await createUser(ctx.owner, a, `${k}@ai.test`, [
        { role, scope, ...(scope === 'ORGANIZATION' ? {} : { brand: 'B1' }) },
      ]);
      t[k] = await bearer(ctx, `${k}@ai.test`);
    }
    ai = ctx.app.get(AiService);
    ctx.clock.set(MON_11);
    src = (
      await ctx.owner.leadSource.findFirstOrThrow({
        where: { brandId: a.brands.B1, channel: 'WEBSITE' },
      })
    ).id;
    key = (await post('admin', '/intake-keys', { sourceId: src, name: 'web' })).body.key;
    course = (
      await ctx.owner.course.create({
        data: {
          organizationId: a.orgId,
          brandId: a.brands.B1,
          code: 'DS',
          name: 'Data Science',
          deliveryMode: 'ONLINE',
          currency: 'INR',
          listFeeMinor: 10_000_000n,
        },
      })
    ).id;
    // Decided history, inserted directly with known features.
    const created = new Date(MON_11.getTime() - 30 * DAY);
    const rows: Array<[boolean, boolean]> = [
      ...Array.from({ length: 16 }, (): [boolean, boolean] => [true, true]),
      ...Array.from({ length: 4 }, (): [boolean, boolean] => [true, false]),
      ...Array.from({ length: 4 }, (): [boolean, boolean] => [false, true]),
      ...Array.from({ length: 36 }, (): [boolean, boolean] => [false, false]),
    ];
    let converted = 0;
    for (const [i, [connected, won]] of rows.entries()) {
      const person = await ctx.owner.person.create({
        data: {
          organizationId: a.orgId,
          fullName: `History ${i}`,
          phoneE164: `+9180000${String(10000 + i)}`,
        },
      });
      const lead = await ctx.owner.lead.create({
        data: {
          organizationId: a.orgId,
          brandId: a.brands.B1,
          personId: person.id,
          leadNumber: `H-${i}`,
          status: won ? 'CONVERTED' : 'LOST',
          // 6 converted students chose Data Science (course suggestion evidence).
          courseId: won && converted++ < 6 ? course : null,
          firstEnquiryAt: created,
          lastEnquiryAt: created,
          createdAt: created,
        },
      });
      await ctx.owner.enquiry.create({
        data: {
          organizationId: a.orgId,
          brandId: a.brands.B1,
          leadId: lead.id,
          personId: person.id,
          classification: 'NEW_LEAD',
          channel: 'WEBSITE',
          sourceId: src,
          dedupKey: `hist-${i}`,
          receivedAt: created,
        },
      });
      if (connected)
        await ctx.owner.activity.create({
          data: {
            organizationId: a.orgId,
            brandId: a.brands.B1,
            leadId: lead.id,
            personId: person.id,
            type: 'CALL',
            direction: 'OUTBOUND',
            outcome: 'CONNECTED',
            occurredAt: new Date(created.getTime() + 3_600_000),
            createdAt: new Date(created.getTime() + 3_600_000),
          },
        });
    }
    L.L1 = await newLead('Asha Kumar');
  }, 120_000);
  afterAll(() => ctx.close());

  it('is off by default; only settings managers switch it on; changes are audited', async () => {
    expect(await panel('e1', L.L1)).toEqual({ enabled: false });
    expect((await put('e1', `/ai-settings?brandId=${a.brands.B1}`, settings)).status).toBe(403);
    expect(
      (
        await put('bm1', `/ai-settings?brandId=${a.brands.B1}`, {
          ...settings,
          highThresholdBp: 500,
        })
      ).status,
    ).toBe(400);
    const r = await put('bm1', `/ai-settings?brandId=${a.brands.B1}`, settings);
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(
      await ctx.owner.auditLog.count({
        where: { organizationId: a.orgId, action: 'ai_settings.updated' },
      }),
    ).toBe(1);
  });

  it('without a trained model it falls back to the labelled rules', async () => {
    const p = await panel('e1', L.L1);
    expect(p.advisory).toMatch(/not a guarantee/);
    expect(p.score).toMatchObject({
      method: 'RULES',
      modelVersion: 'rules-v1',
      score: 20,
      band: 'LOW',
      probabilityBp: null,
      degraded: false,
    });
    expect(p.score.fallbackReason).toMatch(/No model has been trained/);
    await panel('e1', L.L1); // unchanged → no new history row
    expect(await ctx.owner.leadScore.count({ where: { leadId: L.L1 } })).toBe(1);
    expect(await ctx.owner.lead.findUniqueOrThrow({ where: { id: L.L1 } })).toMatchObject({
      priorityBand: 'LOW',
      priorityRank: 1,
      priorityScore: 20,
    });
  });

  it('trains on decided history and matches the hand-computed probability; factors explain it exactly', async () => {
    expect((await post('e1', `/ai-settings/${a.brands.B1}/train`)).status).toBe(403);
    const m = await post('bm1', `/ai-settings/${a.brands.B1}/train`);
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({
      version: 'nb-v1',
      sampleSize: 60,
      conversions: 20,
      usable: true,
    });
    const s = (await panel('e1', L.L1)).score;
    expect(s).toMatchObject({
      method: 'MODEL',
      modelVersion: 'nb-v1',
      probabilityBp: 1056,
      score: 11,
      band: 'MEDIUM',
      confidence: 'LOW',
      basis: { sampleSize: 60, conversions: 20 },
      fallbackReason: null,
    });
    expect(s.prior).toBeCloseTo(Math.log(21 / 41), 3);
    const logit = s.prior + s.factors.reduce((x: number, f: { weight: number }) => x + f.weight, 0);
    expect(sigmoid(logit)).toBeCloseTo(0.10565, 3);
    expect(s.factors.map((f: { factor: string }) => f.factor).sort()).toEqual(
      [
        'channel',
        'connected3d',
        'courseChosen',
        'firstResponse',
        'paidCampaign',
        'repeatEnquiry',
      ].sort(),
    );
    expect(
      s.factors.find((f: { factor: string }) => f.factor === 'connected3d').weight,
    ).toBeCloseTo(Math.log(5 / 22) - Math.log(37 / 42), 3);
    expect(await ctx.owner.leadScore.count({ where: { leadId: L.L1 } })).toBe(2);
    // Connecting the call within 3 days raises the estimate to HIGH.
    L.L2 = await newLead('Bala Raman');
    expect(
      (
        await post('e1', `/leads/${L.L2}/calls`, {
          startedAt: ctx.clock.now().toISOString(),
          outcome: 'CONNECTED',
        })
      ).status,
    ).toBe(201);
    expect((await panel('e1', L.L2)).score.band).toBe('HIGH');
  });

  it('bias review: leads that differ only in personal details get identical scores', async () => {
    const x = await newLead('Mohammed Al Farsi', '+971 50 123 4567');
    const y = await newLead('Priya Sharma', '+91 98765 11111');
    const px = await ctx.owner.lead.findUniqueOrThrow({ where: { id: x } });
    await ctx.owner.person.update({
      where: { id: px.personId },
      data: { city: 'Dubai', language: 'ar', email: 'm@example.com' },
    });
    const sx = (await panel('e1', x)).score;
    const sy = (await panel('e1', y)).score;
    expect(sx.probabilityBp).toBe(sy.probabilityBp);
    expect(sx.factors).toEqual(sy.factors);
    expect(sx.band).toBe(sy.band);
  });

  it('outage: scoring failure degrades to the rules, and the lead page keeps working', async () => {
    ai.failScoring = true;
    try {
      const p = await panel('e1', L.L1);
      expect(p.score).toMatchObject({ method: 'RULES', degraded: true });
      expect(p.score.fallbackReason).toMatch(/unavailable/);
      expect((await get('e1', `/leads/${L.L1}`)).status).toBe(200);
    } finally {
      ai.failScoring = false;
    }
    // Switching scoring off removes the score, not the page.
    await put('bm1', `/ai-settings?brandId=${a.brands.B1}`, { ...settings, scoringEnabled: false });
    expect((await panel('e1', L.L1)).score).toBeNull();
    await put('bm1', `/ai-settings?brandId=${a.brands.B1}`, settings);
  });

  it('a person overrides the band with a reason; it is append-only, audited and drives the list order', async () => {
    expect(
      (await post('e2', `/leads/${L.L1}/ai/override`, { band: 'HIGH', reason: 'Parent called' }))
        .status,
    ).toBe(404);
    expect(
      (await post('e1', `/leads/${L.L1}/ai/override`, { band: 'HIGH', reason: 'ok' })).status,
    ).toBe(400);
    const o = await post('e1', `/leads/${L.L1}/ai/override`, {
      band: 'HIGH',
      reason: 'Parent called back and wants the January batch',
    });
    expect(o.status).toBe(201);
    const p = await panel('e1', L.L1);
    expect(p.override).toMatchObject({ band: 'HIGH', by: 'e1' });
    expect(p.effectiveBand).toBe('HIGH');
    expect(p.score.band).toBe('MEDIUM'); // the estimate itself is kept and still shown
    expect(
      await ctx.owner.auditLog.count({
        where: { entityId: L.L1, action: 'lead_priority.overridden' },
      }),
    ).toBe(1);
    await expect(
      ctx.owner.$executeRawUnsafe(
        `UPDATE lead_score_overrides SET band = 'LOW' WHERE lead_id = '${L.L1}'`,
      ),
    ).rejects.toThrow();
    await expect(
      ctx.owner.$executeRawUnsafe(`DELETE FROM lead_scores WHERE lead_id = '${L.L1}'`),
    ).rejects.toThrow();
    const list = await get('e1', '/leads?ownerId=me&sort=priority');
    // HIGH first (L2 by the model with a higher score, then L1 by the override), then the MEDIUM leads.
    const order = list.body.items.map((i: { id: string; priority: { band: string } | null }) => [
      i.id,
      i.priority?.band,
    ]);
    expect(order.slice(0, 2)).toEqual([
      [L.L2, 'HIGH'],
      [L.L1, 'HIGH'],
    ]);
    expect(order.slice(2).every(([, b]: [string, string]) => b !== 'HIGH')).toBe(true);
  });

  it('next actions: accepting creates one task; a course suggestion changes the lead only after approval', async () => {
    const p = await panel('e1', L.L2);
    const kinds = p.suggestions.map((s: { kind: string }) => s.kind);
    expect(kinds).toContain('BOOK_COUNSELLING');
    const c = p.suggestions.find((s: { kind: string }) => s.kind === 'SUGGEST_COURSE');
    expect(c).toMatchObject({ needsApproval: true, courseId: course });
    expect(c.reason).toMatch(/6 of 6/);
    expect((await ctx.owner.lead.findUniqueOrThrow({ where: { id: L.L2 } })).courseId).toBeNull();

    expect((await post('e2', `/leads/${L.L2}/ai/suggestions/BOOK_COUNSELLING/accept`)).status).toBe(
      404,
    );
    const acc = await post('e1', `/leads/${L.L2}/ai/suggestions/BOOK_COUNSELLING/accept`);
    expect(acc.status).toBe(201);
    const task = await ctx.owner.task.findUniqueOrThrow({ where: { id: acc.body.taskId } });
    expect(task).toMatchObject({ type: 'COUNSELLING', ownerId: id.e1, status: 'OPEN' });
    const again = await post('e1', `/leads/${L.L2}/ai/suggestions/BOOK_COUNSELLING/accept`);
    expect(again.body.error.code).toBe('SUGGESTION_NOT_AVAILABLE');

    const ok = await post('e1', `/leads/${L.L2}/ai/suggestions/SUGGEST_COURSE/accept`);
    expect(ok.status).toBe(201);
    expect((await ctx.owner.lead.findUniqueOrThrow({ where: { id: L.L2 } })).courseId).toBe(course);
    expect(
      await ctx.owner.auditLog.count({
        where: { entityId: L.L2, action: 'ai_suggestion.course_approved' },
      }),
    ).toBe(1);

    // Dismissed suggestions stay hidden (7 days) and the dismissal is recorded.
    const d = await post('e1', `/leads/${L.L1}/ai/suggestions/SUGGEST_COURSE/dismiss`, {
      reason: 'Student wants a different course',
    });
    expect(d.status).toBe(201);
    expect(
      (await panel('e1', L.L1)).suggestions.map((s: { kind: string }) => s.kind),
    ).not.toContain('SUGGEST_COURSE');
    expect(
      await ctx.owner.aiSuggestionEvent.count({
        where: { organizationId: a.orgId },
      }),
    ).toBe(3);
    expect((await post('e1', `/leads/${L.L1}/ai/suggestions/NOPE/accept`)).body.error.code).toBe(
      'UNKNOWN_SUGGESTION',
    );

    await put('bm1', `/ai-settings?brandId=${a.brands.B1}`, {
      ...settings,
      nextActionsEnabled: false,
    });
    expect((await panel('e1', L.L1)).suggestions).toEqual([]);
    await put('bm1', `/ai-settings?brandId=${a.brands.B1}`, settings);
  });

  it('jobs: daily training and hourly rescoring are scheduled once per period and run idempotently', async () => {
    ctx.clock.set(new Date(MON_11.getTime() + 2 * DAY));
    await ai.schedule();
    await ai.schedule();
    const jobs = await ctx.owner.job.findMany({ where: { type: { startsWith: 'ai.' } } });
    expect(jobs.map((j) => j.key).sort()).toEqual(
      [`ai.rescore:${a.brands.B1}:2026-12-02T05`, `ai.train:${a.brands.B1}:2026-12-02`].sort(),
    );
    await ctx.app.get(JobsService).runDue({ workerId: 'test' });
    expect(
      (await ctx.owner.job.findMany({ where: { type: { startsWith: 'ai.' } } })).map(
        (j) => j.status,
      ),
    ).toEqual(['DONE', 'DONE']);
    expect(await ctx.owner.aiModel.count({ where: { brandId: a.brands.B1 } })).toBe(2);
    // Every open lead now has a stored priority.
    const open = await ctx.owner.lead.findMany({
      where: { brandId: a.brands.B1, status: 'OPEN' },
      select: { priorityBand: true },
    });
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((l) => l.priorityBand)).toBe(true);
  });
});
