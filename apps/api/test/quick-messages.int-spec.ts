import { JobsService } from '../src/jobs/jobs.service';
import {
  ProviderRegistry,
  SandboxSmsProvider,
  SandboxWhatsAppProvider,
} from '../src/engagement/providers';
import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

/** Quick messages: one click sends a situation's approved templates on WhatsApp, e-mail and SMS (A-049). */
describe('Quick messages', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  let key = '';
  let course = '';
  let batch = '';
  let leadId = '';
  let wa: SandboxWhatsAppProvider;
  let sms: SandboxSmsProvider;
  const NOW = new Date('2026-11-30T05:30:00Z');

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const patch = (who: string, url: string, body: object) =>
    ctx.http().patch(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const template = async (
    channel: string,
    category: string,
    body: string,
    subject?: string,
    name = category,
  ) => {
    const r = await post('admin', '/message-templates', {
      brandId: a.brands.B1,
      channel,
      category,
      name: `${name} ${channel}`,
      body,
      ...(subject ? { subject } : {}),
    });
    expect(r.status).toBe(201);
    expect(
      (await patch('admin', `/message-templates/${r.body.id}`, { status: 'APPROVED' })).status,
    ).toBe(200);
    return r.body.id as string;
  };
  const preview = async (category: string, who = 'e1') => {
    const r = await get(who, `/leads/${leadId}/messages/quick?category=${category}`);
    return r;
  };
  const ch = (b: { channels: Array<{ channel: string }> }, c: string) =>
    b.channels.find((x) => x.channel === c) as Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'quick-a');
    for (const [k, role, scope] of [
      ['admin', 'ORG_ADMIN', 'ORGANIZATION'],
      ['acc', 'ACCOUNTS_OFFICER', 'ORGANIZATION'],
      ['e1', 'SALES_EXECUTIVE', 'TEAM'],
      ['e2', 'SALES_EXECUTIVE', 'TEAM'],
    ] as const) {
      id[k] = await createUser(ctx.owner, a, `${k}@quick.test`, [
        { role, scope, ...(scope === 'TEAM' ? { brand: 'B1' } : {}) },
      ]);
      t[k] = await bearer(ctx, `${k}@quick.test`);
    }
    ctx.clock.set(NOW);
    const reg = ctx.app.get(ProviderRegistry);
    wa = reg.whatsapp as SandboxWhatsAppProvider;
    sms = reg.sms as SandboxSmsProvider;
    expect(
      (
        await patch('admin', `/brands/${a.brands.B1}`, {
          contactPhone: '+91 484 400 1000',
          contactEmail: 'admissions@academy.test',
          website: 'https://academy.test',
          address: 'MG Road, Kochi',
        })
      ).status,
    ).toBe(200);
    course = (
      await ctx.owner.course.create({
        data: {
          organizationId: a.orgId,
          brandId: a.brands.B1,
          code: 'DS',
          name: 'Data Science',
          deliveryMode: 'ONLINE',
          durationValue: 6,
          durationUnit: 'MONTHS',
          currency: 'INR',
          listFeeMinor: 10_000_000n,
        },
      })
    ).id;
    batch = (
      await ctx.owner.batch.create({
        data: {
          organizationId: a.orgId,
          brandId: a.brands.B1,
          courseId: course,
          code: 'DS-JAN',
          name: 'January',
          startDate: new Date('2027-01-11'),
          capacity: 30,
          status: 'OPEN',
        },
      })
    ).id;
    const src = await ctx.owner.leadSource.findFirstOrThrow({
      where: { brandId: a.brands.B1, channel: 'WEBSITE' },
    });
    key = (await post('admin', '/intake-keys', { sourceId: src.id, name: 'web' })).body.key;
    const r = await ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${key}`)
      .send({
        name: 'Riya Menon',
        phone: '+91 98123 45678',
        email: 'riya@example.com',
        courseId: course,
      });
    leadId = (await ctx.owner.enquiry.findUniqueOrThrow({ where: { id: r.body.reference } }))
      .leadId;
    await post('admin', `/leads/${leadId}/assign`, { userId: id.e1, reason: 'Test' });

    await template(
      'WHATSAPP',
      'COURSE_DETAILS',
      'Hi {{first_name}}, {{course}} ({{course_mode}}, {{course_duration}}) costs {{course_fee}}. Next batch: {{next_batch}}. Call {{brand_phone}}.',
    );
    await template(
      'EMAIL',
      'COURSE_DETAILS',
      'Dear {{full_name}},\n{{course}} fee {{course_fee}}, next batch {{next_batch}}.\n{{brand}} · {{brand_website}}',
      '{{course}} at {{brand}}',
    );
    await template(
      'SMS',
      'COURSE_DETAILS',
      '{{brand}}: {{course}} fee {{course_fee}}, starts {{next_batch}}.',
    );
    await template(
      'EMAIL',
      'COLLEGE_DETAILS',
      'Visit us at {{brand_address}} or {{brand_website}}. Phone {{brand_phone}}, e-mail {{brand_email}}.',
      'About {{brand}}',
    );
    await template(
      'WHATSAPP',
      'FEE_DETAILS',
      'Fee {{fee_total}}, paid {{fee_paid}}, outstanding {{fee_outstanding}}. Next {{next_due_amount}} by {{next_due_date}}.',
    );
  }, 60_000);
  afterAll(() => ctx.close());

  it('previews each channel with the lead, course, batch and college details filled in', async () => {
    const r = await preview('COURSE_DETAILS');
    expect(r.status).toBe(200);
    const w = ch(r.body, 'WHATSAPP');
    expect(w).toMatchObject({ ready: true, recipient: '+919812345678' });
    expect(w.body).toBe(
      'Hi Riya, Data Science (Online, 6 months) costs ₹1,00,000.00. Next batch: 11 Jan 2027. Call +91 484 400 1000.',
    );
    expect(ch(r.body, 'EMAIL')).toMatchObject({
      ready: true,
      recipient: 'riya@example.com',
      subject: 'Data Science at Brand B1',
    });
    expect(ch(r.body, 'SMS')).toMatchObject({ ready: true });
  });

  it('explains why a channel cannot send: no template, or details not known yet', async () => {
    const college = (await preview('COLLEGE_DETAILS')).body;
    expect(ch(college, 'EMAIL')).toMatchObject({ ready: true });
    expect(ch(college, 'WHATSAPP')).toMatchObject({ ready: false, code: 'NO_TEMPLATE' });
    const fees = (await preview('FEE_DETAILS')).body;
    expect(ch(fees, 'WHATSAPP')).toMatchObject({ ready: false, code: 'TEMPLATE_INCOMPLETE' });
    expect(ch(fees, 'WHATSAPP').reason).toMatch(/fee total/);
  });

  it('one click queues one message per ready channel and delivers WhatsApp, e-mail and SMS', async () => {
    const r = await post('e1', `/leads/${leadId}/messages/quick`, {
      category: 'COURSE_DETAILS',
      channels: ['WHATSAPP', 'EMAIL', 'SMS'],
    });
    expect(r.status).toBe(201);
    expect(
      r.body.results.map((x: { channel: string; sent: boolean }) => [x.channel, x.sent]),
    ).toEqual([
      ['WHATSAPP', true],
      ['EMAIL', true],
      ['SMS', true],
    ]);
    await ctx.app.get(JobsService).runDue({ workerId: 'test' });
    expect(wa.sent.at(-1)?.body).toMatch(/costs ₹1,00,000.00/);
    expect(sms.sent.at(-1)).toMatchObject({ to: '+919812345678' });
    expect(ctx.mail.sent.at(-1)).toMatchObject({
      to: 'riya@example.com',
      subject: 'Data Science at Brand B1',
    });
    const msgs = await ctx.owner.outboundMessage.findMany({ where: { leadId } });
    expect(msgs.map((m) => m.status).sort()).toEqual(['SENT', 'SENT', 'SENT']);
    expect(await ctx.owner.activity.count({ where: { leadId, direction: 'OUTBOUND' } })).toBe(3);
  });

  it('sends what it can and reports the rest; nothing sendable is an error', async () => {
    const r = await post('e1', `/leads/${leadId}/messages/quick`, {
      category: 'COLLEGE_DETAILS',
      channels: ['WHATSAPP', 'EMAIL'],
    });
    expect(r.status).toBe(201);
    expect(r.body.results).toEqual([
      expect.objectContaining({
        channel: 'WHATSAPP',
        sent: false,
        reason: expect.stringMatching(/No approved template/),
      }),
      expect.objectContaining({ channel: 'EMAIL', sent: true }),
    ]);
    const none = await post('e1', `/leads/${leadId}/messages/quick`, {
      category: 'FEE_DETAILS',
      channels: ['WHATSAPP'],
    });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('NOTHING_SENT');
  });

  it('fee details use the student fee plan: total, paid, outstanding and next instalment', async () => {
    const q = await post('e1', `/leads/${leadId}/quotations`, { courseId: course, batchId: batch });
    await post('e1', `/quotations/${q.body.id}/accept`);
    const adm = await post('e1', `/leads/${leadId}/admission`);
    const fin = await get('e1', `/admissions/${adm.body.id}/finance`);
    await ctx
      .http()
      .put(`/api/v1/fee-plans/${fin.body.plan.id}/schedule`)
      .set('Authorization', t.acc)
      .send({ mode: 'EQUAL', count: 2, firstDueDate: '2026-12-07', intervalDays: 30 });
    expect(
      (
        await post('acc', `/fee-plans/${fin.body.plan.id}/payments`, {
          amountMinor: 2_000_000,
          method: 'UPI',
          reference: 'UPI-1',
          receivedAt: NOW.toISOString(),
        })
      ).status,
    ).toBe(201);
    const w = ch((await preview('FEE_DETAILS')).body, 'WHATSAPP');
    // The payment confirmed the admission: the lead is now a student and still receives fee messages.
    expect((await ctx.owner.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe(
      'CONVERTED',
    );
    expect(w).toMatchObject({ ready: true });
    expect(w.body).toBe(
      'Fee ₹1,00,000.00, paid ₹20,000.00, outstanding ₹80,000.00. Next ₹30,000.00 by 7 Dec 2026.',
    );
  });

  it('signs with the sender when the lead has no owner yet', async () => {
    await template(
      'WHATSAPP',
      'FOLLOW_UP',
      'Hi {{first_name}}, any questions? – {{owner_name}}, {{brand}}',
    );
    const r = await ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${key}`)
      .send({ name: 'Arun Das', phone: '+91 98123 45999' });
    const unassigned = (
      await ctx.owner.enquiry.findUniqueOrThrow({ where: { id: r.body.reference } })
    ).leadId;
    const p = await get('admin', `/leads/${unassigned}/messages/quick?category=FOLLOW_UP`);
    expect(ch(p.body, 'WHATSAPP')).toMatchObject({
      ready: true,
      body: 'Hi Arun, any questions? – admin, Brand B1',
    });
  });

  it('respects contact preferences and lead access', async () => {
    expect((await preview('COURSE_DETAILS', 'e2')).status).toBe(404);
    expect(
      (
        await post('e2', `/leads/${leadId}/messages/quick`, {
          category: 'COURSE_DETAILS',
          channels: ['EMAIL'],
        })
      ).status,
    ).toBe(404);
    await post('e1', `/leads/${leadId}/contact-preference`, {
      doNotContact: true,
      reason: 'Asked to stop',
    });
    expect(ch((await preview('COURSE_DETAILS')).body, 'EMAIL')).toMatchObject({
      ready: false,
      code: 'OPTED_OUT',
    });
    const r = await post('e1', `/leads/${leadId}/messages/quick`, {
      category: 'COURSE_DETAILS',
      channels: ['EMAIL'],
    });
    expect(r.body.error.code).toBe('NOTHING_SENT');
  });
});
