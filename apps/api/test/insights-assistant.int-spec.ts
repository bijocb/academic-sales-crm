import { AssistantService } from '../src/assistant/assistant.service';
import { AssistantTools } from '../src/assistant/tools';
import { AuthService } from '../src/auth/auth.service';
import type { OrgPrincipal } from '../src/auth/principal';
import { Db } from '../src/db/db.service';
import { DigestService } from '../src/insights/digest.service';
import { InsightsService } from '../src/insights/insights.service';
import { JobsService } from '../src/jobs/jobs.service';
import { ReportsService } from '../src/reports/reports.service';
import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

/** Management insights (A-051) and the "Ask the CRM" assistant with the weekly brief (A-052). */
describe('Management insights and assistant', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  let key = '';

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const patch = (who: string, url: string, body: object = {}) =>
    ctx.http().patch(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const runJobs = async () => {
    for (let i = 0; i < 3; i++) await ctx.app.get(JobsService).runDue({ workerId: 'test' });
  };
  const principal = async (who: string) =>
    (await ctx.app.get(AuthService).authenticate(t[who].slice(7))) as OrgPrincipal;
  const newLead = async (name: string, phone: string, owner: string) => {
    const r = await ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${key}`)
      .send({ name, phone });
    const leadId = (await ctx.owner.enquiry.findUniqueOrThrow({ where: { id: r.body.reference } }))
      .leadId;
    await post('admin', `/leads/${leadId}/assign`, { userId: id[owner], reason: 'Test load' });
    return leadId;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'insights-a');
    for (const [k, role, scope, brand] of [
      ['admin', 'ORG_ADMIN', 'ORGANIZATION', undefined],
      ['leader', 'TEAM_LEADER', 'TEAM', 'B1'],
      ['mgr2', 'BRAND_MANAGER', 'BRAND', 'B2'],
      ['e1', 'SALES_EXECUTIVE', 'TEAM', 'B1'],
      ['e2', 'SALES_EXECUTIVE', 'TEAM', 'B1'],
      ['e3', 'SALES_EXECUTIVE', 'TEAM', 'B1'],
    ] as const) {
      id[k] = await createUser(ctx.owner, a, `${k}@insights.test`, [
        { role, scope, ...(brand ? { brand } : {}) },
      ]);
      t[k] = await bearer(ctx, `${k}@insights.test`);
    }
    ctx.clock.set(new Date('2026-11-23T05:00:00Z')); // Monday
    const src = await ctx.owner.leadSource.findFirstOrThrow({
      where: { brandId: a.brands.B1, channel: 'WEBSITE' },
    });
    key = (await post('admin', '/intake-keys', { sourceId: src.id, name: 'web' })).body.key;
    // e1 gets six leads, e2 and e3 one each; nobody calls, so first calls go overdue.
    for (let i = 0; i < 6; i++) await newLead(`Student ${i}`, `+91 98100 0010${i}`, 'e1');
    await newLead('Student Seven', '+91 98100 00107', 'e2');
    await newLead('Student Eight', '+91 98100 00108', 'e3');
    // A team admissions target for November, nothing achieved yet.
    await ctx.owner.target.create({
      data: {
        organizationId: a.orgId,
        scope: 'TEAM',
        brandId: a.brands.B1,
        teamId: a.teams.B1,
        metric: 'ADMISSIONS',
        periodStart: new Date('2026-11-01'),
        periodEnd: new Date('2026-11-30'),
        value: 40n,
        createdAt: new Date('2026-11-01T00:00:00Z'),
        updatedAt: new Date('2026-11-01T00:00:00Z'),
      },
    });
    ctx.clock.set(new Date('2026-11-25T06:00:00Z'));
  });
  afterAll(() => ctx.close());

  describe('insights', () => {
    it("a team leader gets their team's insights with evidence and actions", async () => {
      const r = await get('leader', '/insights');
      expect(r.status).toBe(200);
      expect(r.body.period).toEqual({ from: '2026-11-19', to: '2026-11-25' });
      expect(r.body.previous).toEqual({ from: '2026-11-12', to: '2026-11-18' });
      const overdue = r.body.insights.find((i: { kind: string }) => i.kind === 'EXEC_OVERDUE');
      expect(overdue).toMatchObject({
        severity: 'HIGH',
        subject: { type: 'executive', id: id.e1, name: 'e1' },
        evidence: { overdueTasks: 6, teamMedian: 1 },
      });
      expect(overdue.action).toMatch(/e1/);
      const target = r.body.insights.find((i: { kind: string }) => i.kind === 'TARGET_AT_RISK');
      expect(target).toMatchObject({
        severity: 'HIGH',
        subject: { name: 'Admissions target — Team B1' },
      });
      expect(r.body.headline.leadsCreated).toBe(8);
    });

    it('scope: another brand sees none of it; executives get 403; bad dates are rejected', async () => {
      const m = await get('mgr2', '/insights');
      expect(m.status).toBe(200);
      expect(m.body.insights).toEqual([]);
      expect(m.body.headline.leadsCreated).toBe(0);
      expect((await get('mgr2', `/insights?brandId=${a.brands.B1}`)).status).toBe(404);
      expect((await get('e1', '/insights')).status).toBe(403);
      expect((await get('leader', '/insights?from=2026-11-20')).status).toBe(400);
    });
  });

  describe('assistant', () => {
    it('is off by default; only an organization admin switches it on', async () => {
      const s = await get('leader', '/assistant');
      expect(s.body).toMatchObject({
        enabled: false,
        configured: true,
        sandbox: true,
        canAsk: true,
        canManage: false,
      });
      expect(
        (await post('leader', '/assistant/ask', { question: 'How is my team doing?' })).body.error
          .code,
      ).toBe('ASSISTANT_OFF');
      expect((await patch('leader', '/assistant/settings', { enabled: true })).status).toBe(403);
      const on = await patch('admin', '/assistant/settings', { enabled: true });
      expect(on.status).toBe(200);
      expect(
        await ctx.owner.auditLog.count({ where: { action: 'assistant_settings.updated' } }),
      ).toBe(1);
    });

    it('answers a leader (sandbox) and records the question; executives cannot ask', async () => {
      const r = await post('leader', '/assistant/ask', { question: 'Who in my team needs help?' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        status: 'ANSWERED',
        sandbox: true,
        toolsUsed: [{ name: 'get_insights' }],
      });
      expect(r.body.answer).toMatch(/^\[SANDBOX\]/);
      expect(r.body.answer).toMatch(/e1 has 6 overdue tasks/);
      const row = await ctx.owner.assistantQuestion.findUniqueOrThrow({ where: { id: r.body.id } });
      expect(row).toMatchObject({
        userId: id.leader,
        kind: 'QUESTION',
        status: 'ANSWERED',
        provider: 'sandbox',
      });
      expect(
        await ctx.owner.auditLog.count({
          where: { action: 'assistant.asked', entityId: r.body.id },
        }),
      ).toBe(1);
      expect((await post('e1', '/assistant/ask', { question: 'How am I doing?' })).status).toBe(
        403,
      );
      // Append-only.
      await expect(
        ctx.owner.$executeRawUnsafe(
          `UPDATE assistant_questions SET answer = 'x' WHERE id = '${r.body.id}'`,
        ),
      ).rejects.toThrow();
    });

    it("the model's tools run as the user: in scope, aggregates only, inputs checked", async () => {
      const tools = new AssistantTools(
        ctx.app.get(Db),
        ctx.app.get(ReportsService),
        ctx.app.get(InsightsService),
      );
      const leader = await principal('leader');
      const scope = (await tools.run(leader, 'list_scope', {})) as {
        today: string;
        brands: Array<{ id: string }>;
        teams: Array<{ id: string }>;
        level: string;
      };
      expect(scope).toMatchObject({ today: '2026-11-25', level: 'team' });
      expect(scope.brands.map((b) => b.id)).toEqual([a.brands.B1]);
      expect(scope.teams.map((x) => x.id)).toEqual([a.teams.B1]);
      const range = { from: '2026-11-01', to: '2026-11-25', teamId: null };
      const b = await tools.run(leader, 'get_breakdown', {
        ...range,
        by: 'executive',
        brandId: null,
      });
      const text = JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      expect(text).toContain('"label":"e1"');
      expect(text).not.toMatch(/Student|98100|phone|email/i); // no lead-level data
      await expect(
        tools.run(leader, 'get_summary', { ...range, brandId: a.brands.B2 }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        tools.run(leader, 'get_summary', { ...range, from: '2025-01-01', brandId: null }),
      ).rejects.toMatchObject({ code: 'INVALID_TOOL_INPUT' });
      await expect(tools.run(leader, 'run_sql', {})).rejects.toMatchObject({
        code: 'UNKNOWN_TOOL',
      });
      const targets = (await tools.run(leader, 'get_targets', { brandId: null })) as unknown[];
      expect(targets).toHaveLength(1);
      expect(
        (await tools.run(await principal('mgr2'), 'get_targets', { brandId: null })) as unknown[],
      ).toEqual([]);
    });
  });

  describe('weekly digest', () => {
    it('Monday 09:00: leaders and management get it once (with the AI brief); executives do not', async () => {
      ctx.clock.set(new Date('2026-11-30T02:00:00Z')); // Monday 07:30 IST: too early
      await ctx.app.get(DigestService).schedule();
      expect(await ctx.owner.job.count({ where: { type: 'insights.digest' } })).toBe(0);
      ctx.clock.set(new Date('2026-11-30T03:30:00Z')); // 09:00 IST
      ctx.mail.sent.length = 0;
      await ctx.app.get(DigestService).schedule();
      await runJobs();
      const notes = await ctx.owner.notification.findMany({ where: { type: 'INSIGHTS_DIGEST' } });
      expect(notes.map((n) => n.userId).sort()).toEqual([id.admin, id.leader, id.mgr2].sort());
      const leaderNote = notes.find((n) => n.userId === id.leader)!;
      expect(leaderNote.title).toMatch(/^Weekly insights: \d+ to look at \(\d+ high\)$/);
      expect(leaderNote.link).toBe('/insights');
      const mail = ctx.mail.sent.find((m) => m.to === 'leader@insights.test')!;
      expect(mail.text).toContain('for 2026-11-23 to 2026-11-29');
      expect(mail.text).toContain('[SANDBOX] Weekly brief');
      expect(mail.text).toContain('e1 has 6 overdue tasks');
      expect(ctx.mail.sent.some((m) => m.to.startsWith('e1@'))).toBe(false);
      expect(await ctx.owner.assistantQuestion.count({ where: { kind: 'BRIEF' } })).toBe(3);
      // Later ticks the same Monday send nothing again.
      ctx.clock.set(new Date('2026-11-30T06:00:00Z'));
      await ctx.app.get(DigestService).schedule();
      await runJobs();
      expect(await ctx.owner.notification.count({ where: { type: 'INSIGHTS_DIGEST' } })).toBe(3);
      expect(ctx.mail.sent.filter((m) => m.subject.startsWith('Weekly insights'))).toHaveLength(3);
    });
  });

  describe('limits and review', () => {
    it('the monthly organization limit stops questions with 429; admins review everyone', async () => {
      const used = await ctx.owner.assistantQuestion.count();
      await patch('admin', '/assistant/settings', { monthlyQuestionLimit: used + 1 });
      expect(
        (await post('leader', '/assistant/ask', { question: 'Admissions this week?' })).status,
      ).toBe(201);
      const r = await post('leader', '/assistant/ask', { question: 'And last week?' });
      expect(r.status).toBe(429);
      expect(r.body.error.code).toBe('ASSISTANT_LIMIT');
      // Briefs stop too once the limit is used (the digest goes without one).
      expect(await ctx.app.get(AssistantService).brief(await principal('leader'), {})).toBeNull();
      const mine = await get('leader', '/assistant/questions');
      expect(
        mine.body.every((q: { kind: string }) => q.kind === 'QUESTION' || q.kind === 'BRIEF'),
      ).toBe(true);
      expect((await get('leader', '/assistant/questions?all=true')).status).toBe(403);
      const all = await get('admin', '/assistant/questions?all=true');
      expect(all.body.some((q: { user: string }) => q.user === 'leader')).toBe(true);
    });
  });
});
