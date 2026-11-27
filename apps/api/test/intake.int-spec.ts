import { Db } from '../src/db/db.service';
import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

/** Phase 4 exit gate: idempotency, validation, import. */
describe('Lead capture', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  let b: OrgFixture;
  const t: Record<string, string> = {};
  let keyB1: string;
  let keyB1Id: string;
  let keyB2: string;
  let googleKey: string;
  let googleKeyId: string;

  const post = (who: string, url: string, body: object) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const intake = (key: string | undefined, body: object) => {
    const r = ctx.http().post('/api/v1/intake/leads');
    return (key ? r.set('Authorization', `Bearer ${key}`) : r).send(body);
  };
  const source = async (brand: string, channel: string) =>
    (
      await ctx.owner.leadSource.findFirstOrThrow({
        where: { brandId: brand, channel: channel as never },
      })
    ).id;

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'lead-a');
    b = await createOrgFixture(ctx.owner, 'lead-b');
    await createUser(ctx.owner, a, 'admin@lead.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    await createUser(ctx.owner, a, 'bm1@lead.test', [
      { role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B1' },
    ]);
    await createUser(ctx.owner, a, 'exec1@lead.test', [
      { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' },
    ]);
    await createUser(ctx.owner, a, 'mkt1@lead.test', [
      { role: 'MARKETING_MANAGER', scope: 'BRAND', brand: 'B1' },
    ]);
    await createUser(ctx.owner, b, 'admin@leadb.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    for (const [k, e] of Object.entries({
      admin: 'admin@lead.test',
      bm1: 'bm1@lead.test',
      exec1: 'exec1@lead.test',
      mkt1: 'mkt1@lead.test',
      adminB: 'admin@leadb.test',
    })) {
      t[k] = await bearer(ctx, e);
    }
    const k1 = await post('admin', '/intake-keys', {
      sourceId: await source(a.brands.B1, 'WEBSITE'),
      name: 'Main website',
    });
    expect(k1.status).toBe(201);
    keyB1 = k1.body.key;
    keyB1Id = k1.body.id;
    keyB2 = (
      await post('admin', '/intake-keys', {
        sourceId: await source(a.brands.B2, 'WEBSITE'),
        name: 'Dubai site',
      })
    ).body.key;
    const g = await post('admin', '/intake-keys', {
      sourceId: await source(a.brands.B1, 'GOOGLE_ADS'),
      name: 'Google lead forms',
    });
    googleKey = g.body.key;
    googleKeyId = g.body.id;
  });
  afterAll(() => ctx.close());

  const rahul = {
    name: 'Rahul Kumar',
    phone: '98765 43210',
    email: 'Rahul.K@Example.com',
    course: 'Data Science',
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'ds-nov',
  };

  describe('intake API', () => {
    let leadId: string;

    it('creates a person, lead and attributed enquiry', async () => {
      const res = await intake(keyB1, rahul);
      expect(res.status).toBe(201);
      expect(res.body.outcome).toBe('CREATED_LEAD');
      const lead = await ctx.owner.lead.findFirstOrThrow({
        where: { brandId: a.brands.B1 },
        include: { person: true, enquiries: true },
      });
      leadId = lead.id;
      expect(lead.leadNumber).toBe('L-000001');
      expect(lead.person.phoneE164).toBe('+919876543210');
      expect(lead.person.email).toBe('rahul.k@example.com');
      expect(lead.enquiries[0]).toMatchObject({
        channel: 'WEBSITE',
        utmCampaign: 'ds-nov',
        submittedPhone: '98765 43210',
        classification: 'NEW_LEAD',
      });
      expect(
        await ctx.owner.outboxEvent.count({
          where: { aggregateId: lead.id, type: 'lead.created' },
        }),
      ).toBe(1);
    });

    it('replaying the same submission creates nothing new', async () => {
      const res = await intake(keyB1, rahul);
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('DUPLICATE_REPLAY');
      expect(await ctx.owner.lead.count({ where: { brandId: a.brands.B1 } })).toBe(1);
      expect(await ctx.owner.enquiry.count({ where: { leadId } })).toBe(1);
    });

    it('concurrent identical submissions still produce exactly one enquiry', async () => {
      const body = { name: 'Asha', phone: '+91 91234 56789', externalId: 'form-777' };
      const results = await Promise.all(Array.from({ length: 5 }, () => intake(keyB1, body)));
      expect(results.filter((r) => r.body.outcome === 'CREATED_LEAD')).toHaveLength(1);
      expect(
        results.every((r) => ['CREATED_LEAD', 'DUPLICATE_REPLAY'].includes(r.body.outcome)),
      ).toBe(true);
      expect(await ctx.owner.enquiry.count({ where: { externalId: 'form-777' } })).toBe(1);
    });

    it('the same person enquiring again adds an enquiry to the active lead', async () => {
      const res = await intake(keyB1, {
        name: 'Rahul K',
        phone: '+919876543210',
        course: 'Digital Marketing',
      });
      expect(res.body.outcome).toBe('ADDED_ENQUIRY');
      const lead = await ctx.owner.lead.findUniqueOrThrow({ where: { id: leadId } });
      expect(lead.enquiryCount).toBe(2);
      const e = await ctx.owner.enquiry.findMany({
        where: { leadId },
        orderBy: { createdAt: 'asc' },
      });
      expect(e.map((x) => x.classification)).toEqual(['NEW_LEAD', 'EXISTING_LEAD']);
      expect(e[0].utmCampaign).toBe('ds-nov'); // original attribution untouched
    });

    it('the same person in another brand gets a separate lead but one person record', async () => {
      const res = await intake(keyB2, { name: 'Rahul', phone: '+919876543210' });
      expect(res.body.outcome).toBe('CREATED_LEAD');
      const leads = await ctx.owner.lead.findMany({
        where: { person: { phoneE164: '+919876543210' } },
      });
      expect(new Set(leads.map((l) => l.brandId))).toEqual(new Set([a.brands.B1, a.brands.B2]));
      expect(new Set(leads.map((l) => l.personId)).size).toBe(1);
    });

    it('a closed lead followed by a new enquiry creates a returning lead', async () => {
      const person = await ctx.owner.person.create({
        data: { organizationId: a.orgId, fullName: 'Meera', phoneE164: '+919000000001' },
      });
      const old = await ctx.owner.lead.create({
        data: {
          organizationId: a.orgId,
          brandId: a.brands.B1,
          personId: person.id,
          leadNumber: 'L-OLD-1',
          status: 'CLOSED_LOST',
          firstEnquiryAt: new Date('2026-01-01'),
          lastEnquiryAt: new Date('2026-01-01'),
        },
      });
      const res = await intake(keyB1, { name: 'Meera', phone: '9000000001' });
      expect(res.body.outcome).toBe('CREATED_LEAD');
      const fresh = await ctx.owner.lead.findFirstOrThrow({
        where: { personId: person.id, status: 'OPEN' },
        include: { enquiries: true },
      });
      expect(fresh.previousLeadId).toBe(old.id);
      expect(fresh.enquiries[0].classification).toBe('RETURNING_LEAD');
    });

    it('invalid submissions go to the exception queue once, with readable errors', async () => {
      const bad = { name: 'No Phone', phone: '12345' };
      const r1 = await intake(keyB1, bad);
      expect(r1.status).toBe(202);
      expect(r1.body.outcome).toBe('INVALID');
      expect(r1.body.errors[0]).toMatchObject({ field: 'phone' });
      const r2 = await intake(keyB1, bad);
      expect(r2.body.reference).toBe(r1.body.reference);
      expect(
        await ctx.owner.intakeException.count({ where: { brandId: a.brands.B1, status: 'OPEN' } }),
      ).toBe(1);
      expect((await intake(keyB1, { phone: '9876501234' })).body.errors[0].field).toBe('name');
    });

    it('rejects missing, wrong and revoked keys', async () => {
      expect((await intake(undefined, rahul)).status).toBe(401);
      expect((await intake('crmk_not-a-real-key', rahul)).status).toBe(401);
      const k = await post('admin', '/intake-keys', {
        sourceId: await source(a.brands.B1, 'EVENT'),
        name: 'Temp',
      });
      expect((await intake(k.body.key, { name: 'Temp', phone: '9800000001' })).status).toBe(201);
      expect(
        (await ctx.http().delete(`/api/v1/intake-keys/${k.body.id}`).set('Authorization', t.admin))
          .status,
      ).toBe(204);
      expect((await intake(k.body.key, { name: 'Temp2', phone: '9800000002' })).status).toBe(401);
    });

    it('enquiries cannot be modified, even by mistake in application code', async () => {
      const db = ctx.app.get(Db);
      await expect(
        db.tenant(a.orgId, (tx) => tx.enquiry.updateMany({ data: { utmCampaign: 'rewritten' } })),
      ).rejects.toThrow();
    });
  });

  describe('Google Ads lead-form webhook', () => {
    const payload = (overrides: object = {}) => ({
      lead_id: 'gads-lead-1',
      google_key: googleKey,
      form_id: 123,
      campaign_id: 987,
      is_test: true,
      user_column_data: [
        { column_id: 'FULL_NAME', string_value: 'Fatima Al Zaabi' },
        { column_id: 'PHONE_NUMBER', string_value: '+971 50 123 4567' },
        { column_id: 'EMAIL', string_value: 'fatima@example.ae' },
        { column_name: 'Preferred intake', string_value: 'January' },
      ],
      ...overrides,
    });

    it('accepts Google payloads without the CSRF header and maps columns', async () => {
      const res = await ctx
        .http()
        .post(`/api/v1/webhooks/google-ads/${googleKeyId}`)
        .send(payload());
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('CREATED_LEAD');
      const e = await ctx.owner.enquiry.findFirstOrThrow({
        where: { externalId: 'gads-lead-1' },
        include: { person: true },
      });
      expect(e.channel).toBe('GOOGLE_ADS');
      expect(e.isPaid).toBe(true);
      expect(e.person.phoneE164).toBe('+971501234567');
      expect(e.message).toContain('Preferred intake: January');
    });

    it('treats Google retries of the same lead as replays and rejects wrong keys', async () => {
      expect(
        (await ctx.http().post(`/api/v1/webhooks/google-ads/${googleKeyId}`).send(payload())).body
          .outcome,
      ).toBe('DUPLICATE_REPLAY');
      expect(
        (
          await ctx
            .http()
            .post(`/api/v1/webhooks/google-ads/${googleKeyId}`)
            .send(payload({ google_key: 'wrong' }))
        ).status,
      ).toBe(401);
      expect(
        (await ctx.http().post(`/api/v1/webhooks/google-ads/${keyB1Id}`).send(payload())).status,
      ).toBe(401);
    });
  });

  describe('manual entry, visibility and masking', () => {
    it('a sales executive can log a walk-in lead and sees only leads they entered', async () => {
      const res = await post('exec1', '/leads', {
        brandId: a.brands.B1,
        name: 'Walk In',
        phone: '9811122233',
        channel: 'CALL',
      });
      expect(res.status).toBe(201);
      const mine = await get('exec1', '/leads');
      expect(
        mine.body.items.map((l: { person: { fullName: string } }) => l.person.fullName),
      ).toEqual(['Walk In']);
      const other = await ctx.owner.lead.findFirstOrThrow({
        where: { person: { phoneE164: '+919876543210' }, brandId: a.brands.B1 },
      });
      expect((await get('exec1', `/leads/${other.id}`)).status).toBe(404);
    });

    it('manual entry returns validation errors instead of queueing them', async () => {
      const res = await post('exec1', '/leads', {
        brandId: a.brands.B1,
        name: 'Bad',
        phone: 'abc',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe('phone');
    });

    it('users without pii.view_full see masked phone numbers and emails', async () => {
      const list = await get('mkt1', '/leads?q=Rahul');
      const lead = list.body.items.find((l: { brandId: string }) => l.brandId === a.brands.B1);
      expect(lead.person.phone).toBe('+91••••••••10');
      expect(lead.person.piiMasked).toBe(true);
      const full = await get('bm1', `/leads/${lead.id}`);
      expect(full.body.person.phone).toBe('+919876543210');
      expect(full.body.enquiries).toHaveLength(2);
    });

    it('brand and organization isolation applies to leads', async () => {
      const b2Lead = await ctx.owner.lead.findFirstOrThrow({ where: { brandId: a.brands.B2 } });
      expect((await get('bm1', `/leads/${b2Lead.id}`)).status).toBe(404);
      expect(
        (await get('bm1', '/leads')).body.items.every(
          (l: { brandId: string }) => l.brandId === a.brands.B1,
        ),
      ).toBe(true);
      expect((await get('adminB', `/leads/${b2Lead.id}`)).status).toBe(404);
      expect((await get('adminB', '/leads')).body.total).toBe(0);
    });
  });

  describe('exception queue', () => {
    it('brand manager fixes a rejected lead and it enters the pipeline', async () => {
      const open = await get('bm1', '/intake-exceptions');
      expect(open.body.items).toHaveLength(2); // bad phone + missing name
      const ex = open.body.items.find(
        (x: { errors: Array<{ field: string }> }) => x.errors[0].field === 'phone',
      );
      const bad = await post('bm1', `/intake-exceptions/${ex.id}/resolve`, {
        lead: { name: 'No Phone', phone: '777' },
      });
      expect(bad.status).toBe(400);
      const ok = await post('bm1', `/intake-exceptions/${ex.id}/resolve`, {
        lead: { name: 'No Phone', phone: '9812345678' },
        note: 'Called the number on the form',
      });
      expect(ok.status).toBe(200);
      expect(ok.body.outcome).toBe('CREATED_LEAD');
      expect(
        (await ctx.owner.intakeException.findUniqueOrThrow({ where: { id: ex.id } })).status,
      ).toBe('RESOLVED');
      expect(
        (await post('bm1', `/intake-exceptions/${ex.id}/discard`, { reason: 'again' })).status,
      ).toBe(400);
    });

    it('another organization cannot touch the queue; executives lack permission', async () => {
      await intake(keyB1, { name: 'Spam', phone: '1' });
      const ex = await ctx.owner.intakeException.findFirstOrThrow({ where: { status: 'OPEN' } });
      expect(
        (await post('adminB', `/intake-exceptions/${ex.id}/discard`, { reason: 'nope' })).status,
      ).toBe(404);
      expect((await get('exec1', '/intake-exceptions')).status).toBe(403);
      expect(
        (await post('bm1', `/intake-exceptions/${ex.id}/discard`, { reason: 'Spam submission' }))
          .status,
      ).toBe(200);
    });
  });

  describe('CSV / Excel import', () => {
    const rows = [
      { rowNumber: 1, data: { name: 'Import One', phone: '9700000001', courseCode: 'NOPE' } },
      { rowNumber: 2, data: { name: 'Rahul Kumar', phone: '+91 98765 43210' } }, // existing active lead
      { rowNumber: 3, data: { name: 'Broken', phone: 'xx' } },
      {
        rowNumber: 4,
        data: { name: 'Bad date', phone: '9700000004', receivedAt: 'yesterday-ish' },
      },
    ];

    it('dry run reports valid, invalid and existing rows without writing anything', async () => {
      const before = await ctx.owner.lead.count();
      const res = await post('bm1', '/lead-imports/validate', { brandId: a.brands.B1, rows });
      expect(res.status).toBe(200);
      expect(res.body.summary).toEqual({ valid: 2, invalid: 2, existing: 1 });
      expect(res.body.results[0].warnings[0].field).toBe('course');
      expect(await ctx.owner.lead.count()).toBe(before);
    });

    it('imports with ADD_ENQUIRY; retrying a chunk does not double count; bad rows land in the queue', async () => {
      const imp = await post('bm1', '/lead-imports', {
        brandId: a.brands.B1,
        fileName: 'leads.csv',
        duplicatePolicy: 'ADD_ENQUIRY',
        totalRows: 4,
      });
      expect(imp.status).toBe(201);
      const first = await post('bm1', `/lead-imports/${imp.body.id}/rows`, { rows });
      expect(first.body.counts).toEqual({
        createdLeads: 1,
        addedEnquiries: 1,
        skipped: 0,
        invalid: 2,
      });
      const retry = await post('bm1', `/lead-imports/${imp.body.id}/rows`, { rows });
      expect(retry.body.results.slice(0, 2).map((r: { outcome: string }) => r.outcome)).toEqual([
        'DUPLICATE_REPLAY',
        'DUPLICATE_REPLAY',
      ]);
      const done = await post('bm1', `/lead-imports/${imp.body.id}/complete`, {});
      expect(done.body).toMatchObject({
        status: 'COMPLETED',
        createdLeads: 1,
        addedEnquiries: 1,
        invalid: 2,
      });
      expect(await ctx.owner.intakeException.count({ where: { importId: imp.body.id } })).toBe(2);
      expect((await post('bm1', `/lead-imports/${imp.body.id}/rows`, { rows })).status).toBe(400);
    });

    it('SKIP_EXISTING leaves existing leads untouched', async () => {
      const imp = await post('bm1', '/lead-imports', {
        brandId: a.brands.B1,
        fileName: 'again.csv',
        duplicatePolicy: 'SKIP_EXISTING',
        totalRows: 1,
      });
      const res = await post('bm1', `/lead-imports/${imp.body.id}/rows`, {
        rows: [{ rowNumber: 1, data: { name: 'Rahul', phone: '9876543210' } }],
      });
      expect(res.body.counts.skipped).toBe(1);
    });

    it('cannot import into another brand', async () => {
      expect(
        (
          await post('bm1', '/lead-imports', {
            brandId: a.brands.B2,
            fileName: 'x.csv',
            duplicatePolicy: 'ADD_ENQUIRY',
            totalRows: 1,
          })
        ).status,
      ).toBe(404);
    });
  });

  it('lead numbers are sequential per organization', async () => {
    const numbers = (
      await ctx.owner.lead.findMany({
        where: { organizationId: a.orgId, leadNumber: { startsWith: 'L-0' } },
        select: { leadNumber: true },
      })
    )
      .map((l) => Number(l.leadNumber.slice(2)))
      .sort((x, y) => x - y);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});
