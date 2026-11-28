import { JobsService } from '../src/jobs/jobs.service';
import { PushProvider, SandboxPushProvider } from '../src/push/push';
import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  PASSWORD,
  TestContext,
} from './helpers';

/** Mobile app support (A-050): sign-in with a stored refresh token, push notifications, WhatsApp from the phone. */
describe('Mobile app support', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  let push: SandboxPushProvider;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  let key = '';
  let leadId = '';
  const TOKEN = 'ExponentPushToken[abcDEF1234567890xyz]';
  const GONE = 'ExponentPushToken[Gone000000000000000]';

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const runJobs = () => ctx.app.get(JobsService).runDue({ workerId: 'test' });
  const newLead = async (name: string, phone: string) => {
    const r = await ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${key}`)
      .send({ name, phone });
    return (await ctx.owner.enquiry.findUniqueOrThrow({ where: { id: r.body.reference } })).leadId;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'mobile-a');
    for (const [k, role, scope] of [
      ['admin', 'ORG_ADMIN', 'ORGANIZATION'],
      ['e1', 'SALES_EXECUTIVE', 'TEAM'],
      ['e2', 'SALES_EXECUTIVE', 'TEAM'],
    ] as const) {
      id[k] = await createUser(ctx.owner, a, `${k}@mobile.test`, [
        { role, scope, ...(scope === 'TEAM' ? { brand: 'B1' } : {}) },
      ]);
      t[k] = await bearer(ctx, `${k}@mobile.test`);
    }
    ctx.clock.set(new Date('2026-11-30T05:30:00Z'));
    push = ctx.app.get(PushProvider) as SandboxPushProvider;
    const src = await ctx.owner.leadSource.findFirstOrThrow({
      where: { brandId: a.brands.B1, channel: 'WEBSITE' },
    });
    key = (await post('admin', '/intake-keys', { sourceId: src.id, name: 'web' })).body.key;
    const tpl = await post('admin', '/message-templates', {
      brandId: a.brands.B1,
      channel: 'WHATSAPP',
      category: 'FOLLOW_UP',
      name: 'Follow-up',
      body: 'Hi {{first_name}}, any questions? – {{owner_name}}, {{brand}}',
    });
    await ctx
      .http()
      .patch(`/api/v1/message-templates/${tpl.body.id}`)
      .set('Authorization', t.admin)
      .send({ status: 'APPROVED' });
  });
  afterAll(() => ctx.close());

  describe('sign-in', () => {
    const login = (client: string) =>
      ctx
        .http()
        .post('/api/v1/auth/login')
        .set('x-crm-client', client)
        .send({ email: 'e1@mobile.test', password: PASSWORD });

    it('the mobile client gets its refresh token in the body (no cookies); the web keeps cookies only', async () => {
      const m = await login('mobile');
      expect(m.status).toBe(200);
      expect(m.body.refreshToken).toEqual(expect.any(String));
      expect(m.headers['set-cookie']).toBeUndefined();
      const w = await login('web');
      expect(w.body.refreshToken).toBeUndefined();
      expect(String(w.headers['set-cookie'])).toMatch(/crm_rt=/);
    });

    it('refresh with the stored token rotates it; the old one stops working', async () => {
      const m = await login('mobile');
      const r = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .set('x-crm-client', 'mobile')
        .send({ refreshToken: m.body.refreshToken });
      expect(r.status).toBe(200);
      expect(r.body.refreshToken).not.toBe(m.body.refreshToken);
      const me = await ctx
        .http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${r.body.accessToken}`);
      expect(me.body.user.email).toBe('e1@mobile.test');
      const again = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .set('x-crm-client', 'mobile')
        .send({ refreshToken: m.body.refreshToken });
      expect(again.status).toBe(401);
      // A body token is ignored for browsers (cookie only).
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/auth/refresh')
            .set('x-crm-client', 'web')
            .send({ refreshToken: r.body.refreshToken })
        ).status,
      ).toBe(401);
    });
  });

  describe('push notifications', () => {
    it('registers a phone; a new notification is pushed to it once', async () => {
      expect(
        (await post('e1', '/me/push-devices', { token: 'nope', platform: 'android' })).status,
      ).toBe(400);
      const r = await post('e1', '/me/push-devices', {
        token: TOKEN,
        platform: 'android',
        appVersion: '1.0.0',
      });
      expect(r.status).toBe(201);
      await post('e1', '/me/push-devices', { token: GONE, platform: 'ios' });
      leadId = await newLead('Riya Menon', '+91 98123 45678');
      await post('admin', `/leads/${leadId}/assign`, { userId: id.e1, reason: 'Speaks Malayalam' });
      const jobs = await ctx.owner.job.findMany({ where: { type: 'push.send' } });
      expect(jobs.length).toBeGreaterThan(0);
      await runJobs();
      const mine = push.sent.filter((m) => m.to === TOKEN);
      expect(mine.length).toBe(jobs.length);
      expect(mine[0]).toMatchObject({
        title: expect.any(String),
        data: expect.objectContaining({ type: expect.any(String) }),
      });
      // The uninstalled phone is switched off; the next notification is not sent to it.
      expect(
        (await ctx.owner.pushDevice.findUniqueOrThrow({ where: { token: GONE } })).disabledAt,
      ).not.toBeNull();
      await runJobs();
      expect(push.sent.filter((m) => m.to === TOKEN).length).toBe(jobs.length);
    });

    it('a user without a phone gets no push job; signing out removes the phone', async () => {
      const before = await ctx.owner.job.count({ where: { type: 'push.send' } });
      const other = await newLead('Arun Das', '+91 98123 45999');
      await post('admin', `/leads/${other}/assign`, { userId: id.e2, reason: 'Balance load' });
      expect(await ctx.owner.job.count({ where: { type: 'push.send' } })).toBe(before);
      expect((await post('e1', '/me/push-devices/remove', { token: TOKEN })).body.removed).toBe(1);
      expect(
        (await ctx.owner.pushDevice.findUniqueOrThrow({ where: { token: TOKEN } })).disabledAt,
      ).not.toBeNull();
    });
  });

  describe('WhatsApp from the phone', () => {
    it('renders the situation template with a wa.me link and records it in the timeline when sent', async () => {
      const p = await get('e1', `/leads/${leadId}/messages/personal-whatsapp?category=FOLLOW_UP`);
      expect(p.status).toBe(200);
      expect(p.body).toMatchObject({
        ready: true,
        recipient: '+919812345678',
        body: 'Hi Riya, any questions? – e1, Brand B1',
      });
      expect(p.body.url).toBe(
        `https://wa.me/919812345678?text=${encodeURIComponent('Hi Riya, any questions? – e1, Brand B1')}`,
      );
      // No WhatsApp Business provider is needed: the message goes from the executive's own WhatsApp.
      expect(
        (await get('e1', `/leads/${leadId}/messages/personal-whatsapp?category=FEE_DETAILS`)).body,
      ).toMatchObject({
        ready: false,
        code: 'NO_TEMPLATE',
      });
      const r = await post('e1', `/leads/${leadId}/messages/personal-whatsapp`, {
        category: 'FOLLOW_UP',
      });
      expect(r.status).toBe(201);
      const a1 = await ctx.owner.activity.findUniqueOrThrow({ where: { id: r.body.activityId } });
      expect(a1).toMatchObject({
        type: 'WHATSAPP',
        direction: 'OUTBOUND',
        provider: 'personal-whatsapp',
      });
      expect(await ctx.owner.outboundMessage.count({ where: { leadId } })).toBe(0); // nothing sent by the CRM
    });

    it('respects lead access and contact preferences', async () => {
      expect(
        (await get('e2', `/leads/${leadId}/messages/personal-whatsapp?category=FOLLOW_UP`)).status,
      ).toBe(404);
      await post('e1', `/leads/${leadId}/contact-preference`, {
        doNotContact: true,
        reason: 'Asked to stop',
      });
      expect(
        (await get('e1', `/leads/${leadId}/messages/personal-whatsapp?category=FOLLOW_UP`)).body
          .code,
      ).toBe('OPTED_OUT');
      expect(
        (await post('e1', `/leads/${leadId}/messages/personal-whatsapp`, { category: 'FOLLOW_UP' }))
          .status,
      ).toBe(409);
    });
  });
});
