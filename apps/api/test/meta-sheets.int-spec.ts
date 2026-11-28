import { createHmac } from 'node:crypto';
import { JobsService } from '../src/jobs/jobs.service';
import { buildMetaClient, MetaClient, SandboxMetaClient } from '../src/leads/meta';
import { SANDBOX_META_APP_SECRET } from '../src/leads/meta.service';
import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

/** Facebook / Instagram Lead Ads (A-047) and Google Sheets intake (A-048). */
describe('Meta Lead Ads and Google Sheets intake', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  let meta: SandboxMetaClient;
  const t: Record<string, string> = {};
  let metaSource = '';
  let connectionId = '';
  const PAGE = '1029384756';
  const NOW = new Date('2026-11-30T05:30:00Z');

  const post = (who: string, url: string, body: object) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const patch = (who: string, url: string, body: object) =>
    ctx.http().patch(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const hook = (payload: object, secret = SANDBOX_META_APP_SECRET) => {
    const raw = JSON.stringify(payload);
    return ctx
      .http()
      .post('/api/v1/webhooks/meta')
      .set('content-type', 'application/json')
      .set(
        'x-hub-signature-256',
        `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      )
      .send(raw);
  };
  const leadgen = (leadgenId: string, pageId = PAGE) => ({
    object: 'page',
    entry: [
      {
        id: pageId,
        changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: pageId } }],
      },
    ],
  });
  const runJobs = () => ctx.app.get(JobsService).runDue({ workerId: 'test' });

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'meta-a');
    for (const [k, role, scope] of [
      ['admin', 'ORG_ADMIN', 'ORGANIZATION'],
      ['bm1', 'BRAND_MANAGER', 'BRAND'],
    ] as const) {
      await createUser(ctx.owner, a, `${k}@meta.test`, [
        { role, scope, ...(scope === 'BRAND' ? { brand: 'B1' } : {}) },
      ]);
      t[k] = await bearer(ctx, `${k}@meta.test`);
    }
    ctx.clock.set(NOW);
    meta = ctx.app.get(MetaClient) as SandboxMetaClient;
    metaSource = (
      await ctx.owner.leadSource.findFirstOrThrow({
        where: { brandId: a.brands.B1, channel: 'META_ADS' },
      })
    ).id;
    await ctx.owner.campaign.create({
      data: {
        organizationId: a.orgId,
        brandId: a.brands.B1,
        sourceId: metaSource,
        name: 'Nov Lead Ads',
        externalId: '238500000001',
      },
    });
  });
  afterAll(() => ctx.close());

  describe('Meta Lead Ads', () => {
    it('only integration managers connect a page; the token is checked, encrypted and never returned', async () => {
      const body = {
        brandId: a.brands.B1,
        sourceId: metaSource,
        pageId: PAGE,
        pageName: 'Academy India',
        accessToken: 'sandbox-page-token',
      };
      expect((await post('bm1', '/meta-connections', body)).status).toBe(403);
      const bad = await post('admin', '/meta-connections', {
        ...body,
        accessToken: 'x'.repeat(30),
      });
      expect(bad.body.error.code).toBe('META_SUBSCRIBE_FAILED');
      const r = await post('admin', '/meta-connections', body);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        pageId: PAGE,
        status: 'ACTIVE',
        subscribed: true,
        tokenSet: true,
      });
      expect(JSON.stringify(r.body)).not.toContain('sandbox-page-token');
      expect(r.body.tokenSealed).toBeUndefined();
      connectionId = r.body.id;
      expect(meta.subscribed.has(PAGE)).toBe(true);
      const row = await ctx.owner.metaConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(row.tokenSealed).toMatch(/^v1\./);
      expect(row.tokenSealed).not.toContain('sandbox-page-token');
      expect((await post('admin', '/meta-connections', body)).body.error.code).toBe(
        'PAGE_ALREADY_CONNECTED',
      );
      const list = await get('admin', `/meta-connections?brandId=${a.brands.B1}`);
      expect(JSON.stringify(list.body)).not.toContain('sandbox-page-token');
      expect(
        await ctx.owner.auditLog.count({
          where: { entityId: connectionId, action: 'meta_connection.created' },
        }),
      ).toBe(1);
    });

    it('answers the subscription check only with the verify token', async () => {
      const ok = await ctx
        .http()
        .get(
          '/api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=sandbox-verify&hub.challenge=12345',
        );
      expect(ok.status).toBe(200);
      expect(ok.text).toBe('12345');
      expect(
        (
          await ctx
            .http()
            .get('/api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')
        ).status,
      ).toBe(401);
    });

    it('rejects unsigned or wrongly signed webhooks', async () => {
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/webhooks/meta')
            .set('content-type', 'application/json')
            .send(leadgen('1'))
        ).status,
      ).toBe(401);
      expect((await hook(leadgen('1'), 'not-the-app-secret')).status).toBe(401);
    });

    it('a signed notification queues one job; the job fetches the lead and creates it with source and campaign', async () => {
      meta.leads.set('900000001', {
        id: '900000001',
        created_time: '2026-11-30T05:20:00+0000',
        form_id: '777',
        ad_id: '555',
        campaign_id: '238500000001',
        platform: 'ig',
        field_data: [
          { name: 'full_name', values: ['Riya Menon'] },
          { name: 'phone_number', values: ['+919812300001'] },
          { name: 'email', values: ['riya@example.com'] },
          { name: 'which_course_are_you_interested_in?', values: ['Data Science'] },
        ],
      });
      const r = await hook(leadgen('900000001'));
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ received: 1, queued: 1 });
      expect((await hook(leadgen('900000001'))).body.queued).toBe(1); // Meta retries: still one job
      expect(await ctx.owner.job.count({ where: { key: 'meta.lead:900000001' } })).toBe(1);
      await runJobs();
      const e = await ctx.owner.enquiry.findFirstOrThrow({
        where: { brandId: a.brands.B1, channel: 'META_ADS' },
        include: { campaign: true, lead: { include: { person: true } } },
      });
      expect(e.sourceId).toBe(metaSource);
      expect(e.campaign?.name).toBe('Nov Lead Ads'); // matched by the Meta campaign id
      expect(e.lead.person).toMatchObject({ fullName: 'Riya Menon', phoneE164: '+919812300001' });
      expect(e.receivedAt.toISOString()).toBe('2026-11-30T05:20:00.000Z');
      expect(
        (await ctx.owner.metaConnection.findUniqueOrThrow({ where: { id: connectionId } }))
          .lastLeadAt,
      ).not.toBeNull();
    });

    it('unknown or paused pages are ignored', async () => {
      expect((await hook(leadgen('900000002', '5555555555'))).body).toEqual({
        received: 1,
        queued: 0,
      });
      await patch('admin', `/meta-connections/${connectionId}`, { status: 'PAUSED' });
      expect((await hook(leadgen('900000003'))).body.queued).toBe(0);
      await patch('admin', `/meta-connections/${connectionId}`, { status: 'ACTIVE' });
    });

    it('Graph errors are retried, recorded on the connection, and dead-lettered when they persist', async () => {
      meta.leads.set('900000004', {
        id: '900000004',
        field_data: [
          { name: 'full_name', values: ['Arun Das'] },
          { name: 'phone_number', values: ['+919812300004'] },
        ],
      });
      meta.failures = 1;
      await hook(leadgen('900000004'));
      await runJobs();
      expect(
        (await ctx.owner.metaConnection.findUniqueOrThrow({ where: { id: connectionId } }))
          .lastError,
      ).toMatch(/temporary error/);
      const job = await ctx.owner.job.findUniqueOrThrow({ where: { key: 'meta.lead:900000004' } });
      expect(job.status).toBe('PENDING'); // retried later with backoff
      ctx.clock.set(new Date(NOW.getTime() + 60 * 60_000));
      await runJobs();
      expect(
        (await ctx.owner.job.findUniqueOrThrow({ where: { key: 'meta.lead:900000004' } })).status,
      ).toBe('DONE');
      expect(await ctx.owner.person.count({ where: { phoneE164: '+919812300004' } })).toBe(1);
      // A lead Meta no longer returns fails every attempt and ends dead-lettered (visible in /internal/status).
      await hook(leadgen('900000099'));
      for (let i = 0; i < 6; i++) {
        ctx.clock.set(new Date(ctx.clock.now().getTime() + 24 * 60 * 60_000));
        await runJobs();
      }
      expect(
        (await ctx.owner.job.findUniqueOrThrow({ where: { key: 'meta.lead:900000099' } })).status,
      ).toBe('DEAD');
    });

    it('production never uses the sandbox, and without an app secret the webhook is off', async () => {
      expect(buildMetaClient('production', 'v23.0', undefined)).toBeNull();
      expect(buildMetaClient('production', 'v23.0', 'secret')?.name).toBe('graph');
      expect(buildMetaClient('development', 'v23.0', undefined)?.name).toBe('sandbox');
    });
  });

  describe('Google Sheets', () => {
    let key = '';
    beforeAll(async () => {
      const src = await ctx.owner.leadSource.findFirstOrThrow({
        where: { brandId: a.brands.B1, channel: 'GOOGLE_SHEETS' },
      });
      key = (await post('admin', '/intake-keys', { sourceId: src.id, name: 'Admissions sheet' }))
        .body.key;
    });
    const row = (n: number, extra: object = {}) =>
      ctx
        .http()
        .post('/api/v1/intake/leads')
        .set('Authorization', `Bearer ${key}`)
        .send({
          externalId: `sheet-abc:0:${n}`,
          name: `Sheet Row ${n}`,
          phone: `+91 98000 0${1000 + n}`,
          ...extra,
        });

    it('every brand has a Google Sheets source; sheet rows arrive as Google Sheets leads', async () => {
      const r = await row(2, { course: 'Data Science', utm_campaign: 'nov-sheet' });
      expect(r.status).toBe(201);
      const e = await ctx.owner.enquiry.findUniqueOrThrow({ where: { id: r.body.reference } });
      expect(e.channel).toBe('GOOGLE_SHEETS');
    });

    it('re-sending the same row (script retry) creates nothing new', async () => {
      const again = await row(2, { course: 'Data Science', utm_campaign: 'nov-sheet' });
      expect(again.status).toBe(200);
      expect(again.body.outcome).toBe('DUPLICATE_REPLAY');
      expect(await ctx.owner.enquiry.count({ where: { channel: 'GOOGLE_SHEETS' } })).toBe(1);
    });

    it('a bad row is rejected with reasons the script writes back to the sheet', async () => {
      const r = await row(3, { phone: '12', email: undefined });
      expect(r.status).toBe(202);
      expect(r.body.errors.length).toBeGreaterThan(0);
    });
  });
});
