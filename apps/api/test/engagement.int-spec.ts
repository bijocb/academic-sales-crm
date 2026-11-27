import {
  buildProviderRegistry,
  ProviderRegistry,
  SandboxWhatsAppProvider,
} from '../src/engagement/providers';
import { WorkerService } from '../src/jobs/worker.service';
import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

const MIN = 60_000;

/** Phase 8 exit gate: activity history and provider failure handling. */
describe('Sales engagement', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  let wa: SandboxWhatsAppProvider;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  let intakeKey = '';
  const MON_11 = new Date('2026-11-30T05:30:00Z'); // Monday 11:00 IST

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const patch = (who: string, url: string, body: object) =>
    ctx.http().patch(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const tick = () => ctx.app.get(WorkerService).tick();
  const webhook = (body: object) => ctx.http().post('/api/v1/webhooks/sandbox/whatsapp').send(body);
  let n = 0;
  /** A lead owned by e1 (manual assignment: starts the SLA and the first-call task). */
  const newLead = async (extra: object = {}) => {
    n++;
    const res = await ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${intakeKey}`)
      .send({
        name: `Asha Learner ${n}`,
        phone: `+91 95000 ${String(30000 + n).slice(-5)}`,
        ...extra,
      });
    expect(res.status).toBe(201);
    const e = await ctx.owner.enquiry.findUniqueOrThrow({ where: { id: res.body.reference } });
    expect(
      (await post('bm1', `/leads/${e.leadId}/assign`, { userId: id.e1, reason: 'Test' })).status,
    ).toBe(200);
    return ctx.owner.lead.findUniqueOrThrow({ where: { id: e.leadId }, include: { person: true } });
  };
  const message = (leadId: string) =>
    ctx.owner.outboundMessage.findFirstOrThrow({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
    });
  let tplId = '';

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'eng-a');
    id.admin = await createUser(ctx.owner, a, 'admin@eng.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    id.bm1 = await createUser(ctx.owner, a, 'bm1@eng.test', [
      { role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B1' },
    ]);
    for (const e of ['e1', 'e2'])
      id[e] = await createUser(ctx.owner, a, `${e}@eng.test`, [
        { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' },
      ]);
    id.c1 = await createUser(ctx.owner, a, 'c1@eng.test', [
      { role: 'COUNSELLOR', scope: 'TEAM', brand: 'B1' },
    ]);
    for (const k of ['admin', 'bm1', 'e1', 'e2', 'c1']) t[k] = await bearer(ctx, `${k}@eng.test`);
    const src = await ctx.owner.leadSource.findFirstOrThrow({
      where: { brandId: a.brands.B1, channel: 'WEBSITE' },
    });
    ctx.clock.set(MON_11);
    intakeKey = (await post('admin', '/intake-keys', { sourceId: src.id, name: 'web' })).body.key;
    wa = ctx.app.get(ProviderRegistry).whatsapp as SandboxWhatsAppProvider;
  });
  afterAll(() => ctx.close());

  it('reports which channels are live; production never gets sandbox providers', async () => {
    const r = await get('e1', '/engagement/providers');
    expect(r.body).toMatchObject({
      sandbox: true,
      whatsapp: 'sandbox-whatsapp',
      callRecording: false,
    });
    expect(buildProviderRegistry('production')).toMatchObject({
      sandbox: false,
      whatsapp: null,
      telephony: null,
    });
  });

  it('a manual call log is kept in the history and resolves the first-response SLA', async () => {
    ctx.clock.set(MON_11);
    const lead = await newLead();
    ctx.clock.set(new Date(MON_11.getTime() + 6 * MIN));
    expect(
      (
        await post('e2', `/leads/${lead.id}/calls`, {
          startedAt: MON_11.toISOString(),
          outcome: 'NO_ANSWER',
        })
      ).status,
    ).toBe(404);
    const r = await post('e1', `/leads/${lead.id}/calls`, {
      startedAt: new Date(MON_11.getTime() + 4 * MIN).toISOString(),
      durationSec: 120,
      outcome: 'NO_ANSWER',
      notes: 'Rang out',
    });
    expect(r.status).toBe(201);
    expect(r.body.slaResolved).toBe(true);
    const sla = await ctx.owner.slaInstance.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(sla).toMatchObject({ state: 'RESOLVED', resolution: 'NO_ANSWER', workingMinutes: 6 });
    const timeline = await get('e1', `/leads/${lead.id}/timeline`);
    const call = timeline.body.find((x: { type: string }) => x.type === 'CALL');
    expect(call.title).toBe('Outbound call · no answer · 2 min');
    expect(call.actor).toBe('e1');
    // Append-only: the database itself refuses changes.
    await expect(
      ctx.owner.$executeRawUnsafe(
        `UPDATE activities SET outcome = 'CONNECTED' WHERE lead_id = '${lead.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      ctx.owner.$executeRawUnsafe(`DELETE FROM activities WHERE lead_id = '${lead.id}'`),
    ).rejects.toThrow();
  });

  it('completing a call task writes exactly one call activity', async () => {
    const lead = await newLead();
    const task = await ctx.owner.task.findFirstOrThrow({
      where: { leadId: lead.id, isInitial: true },
    });
    const r = await post('e1', `/tasks/${task.id}/complete`, {
      outcome: 'CONNECTED',
      nextTask: { type: 'COUNSELLING', dueAt: '2026-12-01T06:00:00Z' },
    });
    expect(r.status).toBe(201);
    const acts = await ctx.owner.activity.findMany({ where: { leadId: lead.id } });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({
      type: 'CALL',
      outcome: 'CONNECTED',
      taskId: task.id,
      actorUserId: id.e1,
    });
  });

  it('WhatsApp needs an approved template; placeholders are filled and checked', async () => {
    const lead = await newLead();
    const noTpl = await post('e1', `/leads/${lead.id}/messages`, {
      channel: 'WHATSAPP',
      body: 'Hello',
    });
    expect(noTpl.body.error.code).toBe('TEMPLATE_REQUIRED');
    expect(
      (
        await post('e1', '/message-templates', {
          brandId: a.brands.B1,
          channel: 'WHATSAPP',
          name: 'xx',
          body: 'x',
        })
      ).status,
    ).toBe(403);
    const created = await post('bm1', '/message-templates', {
      brandId: a.brands.B1,
      channel: 'WHATSAPP',
      name: 'welcome',
      body: 'Hi {{first_name}}, this is {{owner_name}} from {{brand}}.',
      providerTemplateName: 'welcome_v1',
    });
    expect(created.status).toBe(201);
    tplId = created.body.id;
    const draft = await post('e1', `/leads/${lead.id}/messages`, {
      channel: 'WHATSAPP',
      templateId: tplId,
    });
    expect(draft.body.error.code).toBe('TEMPLATE_NOT_APPROVED');
    const approved = await patch('bm1', `/message-templates/${tplId}`, { status: 'APPROVED' });
    expect(approved.body).toMatchObject({ status: 'APPROVED', approvedById: id.bm1 });
    const courseTpl = await post('bm1', '/message-templates', {
      brandId: a.brands.B1,
      channel: 'WHATSAPP',
      name: 'course',
      body: 'About {{course}}',
    });
    await patch('bm1', `/message-templates/${courseTpl.body.id}`, { status: 'APPROVED' });
    expect(
      (
        await post('e1', `/leads/${lead.id}/messages`, {
          channel: 'WHATSAPP',
          templateId: courseTpl.body.id,
        })
      ).body.error.code,
    ).toBe('TEMPLATE_INCOMPLETE');

    const sent = await post('e1', `/leads/${lead.id}/messages`, {
      channel: 'WHATSAPP',
      templateId: tplId,
    });
    expect(sent.status).toBe(201);
    expect(sent.body.message.status).toBe('QUEUED');
    await tick();
    const m = await message(lead.id);
    expect(m.status).toBe('SENT');
    expect(m.providerRef).toMatch(/^sbx-wa-/);
    expect(wa.sent.at(-1)).toMatchObject({
      to: lead.person.phoneE164,
      templateName: 'welcome_v1',
      body: `Hi Asha, this is e1 from Brand B1.`,
      clientRef: m.id,
    });
  });

  it('delivery receipts only move forward and are all kept', async () => {
    const lead = await ctx.owner.lead.findFirstOrThrow({
      where: {
        id: (await ctx.owner.outboundMessage.findFirstOrThrow({ where: { status: 'SENT' } }))
          .leadId,
      },
    });
    const m = await message(lead.id);
    expect(
      (await webhook({ type: 'status', providerRef: m.providerRef, status: 'READ' })).body.applied,
    ).toBe(true);
    expect(
      (await webhook({ type: 'status', providerRef: m.providerRef, status: 'DELIVERED' })).body
        .applied,
    ).toBe(false);
    expect(
      (await webhook({ type: 'status', providerRef: m.providerRef, status: 'FAILED' })).body
        .applied,
    ).toBe(false);
    expect(
      (await webhook({ type: 'status', providerRef: 'unknown', status: 'READ' })).body.matched,
    ).toBe(false);
    const after = await message(lead.id);
    expect(after.status).toBe('READ');
    expect(after.deliveredAt).not.toBeNull();
    const events = await ctx.owner.messageEvent.findMany({
      where: { messageId: m.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => [e.type, e.status])).toEqual([
      ['QUEUED', 'QUEUED'],
      ['SENT', 'SENT'],
      ['RECEIPT', 'READ'],
      ['RECEIPT_IGNORED', 'DELIVERED'],
      ['RECEIPT_IGNORED', 'FAILED'],
    ]);
    const timeline = await get('e1', `/leads/${lead.id}/timeline`);
    expect(timeline.body.find((x: { type: string }) => x.type === 'WHATSAPP').title).toBe(
      'Outbound WhatsApp · read',
    );
  });

  it('a temporary provider failure is retried with backoff and then sent', async () => {
    ctx.clock.set(new Date('2026-12-01T05:30:00Z'));
    const lead = await newLead();
    wa.failNext = 2;
    await post('e1', `/leads/${lead.id}/messages`, { channel: 'WHATSAPP', templateId: tplId });
    await tick();
    let m = await message(lead.id);
    expect(m).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
      lastError: 'Sandbox provider temporarily unavailable',
    });
    ctx.clock.advance(31_000);
    await tick();
    ctx.clock.advance(61_000);
    await tick();
    m = await message(lead.id);
    expect(m).toMatchObject({ status: 'SENT', attempts: 3, lastError: null });
    const job = await ctx.owner.job.findUniqueOrThrow({ where: { key: `msg:${m.id}` } });
    expect(job.status).toBe('DONE');
  });

  it('repeated failure marks the message FAILED, dead-letters the job and tells the sender', async () => {
    ctx.clock.set(new Date('2026-12-01T07:30:00Z'));
    const lead = await newLead();
    wa.failNext = 10;
    await post('e1', `/leads/${lead.id}/messages`, { channel: 'WHATSAPP', templateId: tplId });
    for (const wait of [0, 31_000, 61_000, 121_000]) {
      ctx.clock.advance(wait);
      await tick();
    }
    const m = await message(lead.id);
    expect(m).toMatchObject({ status: 'FAILED', attempts: 4 });
    expect((await ctx.owner.job.findUniqueOrThrow({ where: { key: `msg:${m.id}` } })).status).toBe(
      'DEAD',
    );
    const note = await ctx.owner.notification.findFirst({
      where: { userId: id.e1, type: 'MESSAGE_FAILED', link: `/leads/${lead.id}` },
    });
    expect(note).not.toBeNull();
    wa.failNext = 0;
    // The interaction itself stays in the history.
    expect(await ctx.owner.activity.count({ where: { leadId: lead.id, type: 'WHATSAPP' } })).toBe(
      1,
    );
  });

  it('a permanent failure (not a WhatsApp number) fails at once without retrying', async () => {
    const lead = await newLead({ phone: '+91 95000 10000' });
    await post('e1', `/leads/${lead.id}/messages`, { channel: 'WHATSAPP', templateId: tplId });
    await tick();
    const m = await message(lead.id);
    expect(m).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'Recipient is not a WhatsApp user',
    });
    expect((await ctx.owner.job.findUniqueOrThrow({ where: { key: `msg:${m.id}` } })).status).toBe(
      'DONE',
    );
  });

  it('opt-out: an inbound STOP blocks messages; a manual opt-in with a reason allows them again', async () => {
    const lead = await newLead();
    const r = await webhook({
      type: 'inbound',
      brandId: a.brands.B1,
      from: lead.person.phoneE164,
      text: 'STOP',
    });
    expect(r.body).toMatchObject({ matched: true, optedOut: true });
    expect(
      (await ctx.owner.person.findUniqueOrThrow({ where: { id: lead.personId } })).doNotContact,
    ).toBe(true);
    const blocked = await post('e1', `/leads/${lead.id}/messages`, {
      channel: 'WHATSAPP',
      templateId: tplId,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('OPTED_OUT');
    const inbound = await ctx.owner.activity.findFirstOrThrow({
      where: { leadId: lead.id, direction: 'INBOUND' },
    });
    expect(inbound.body).toBe('STOP');
    expect(await ctx.owner.leadEvent.count({ where: { leadId: lead.id, type: 'OPTED_OUT' } })).toBe(
      1,
    );
    expect(
      (
        await post('e1', `/leads/${lead.id}/contact-preference`, {
          doNotContact: false,
          reason: 'Asked to be contacted again on call',
        })
      ).status,
    ).toBe(201);
    expect(
      (await post('e1', `/leads/${lead.id}/messages`, { channel: 'WHATSAPP', templateId: tplId }))
        .status,
    ).toBe(201);
  });

  it('email: sent through the mail service, retried when it fails', async () => {
    const lead = await newLead({ email: 'asha.learner@example.com' });
    const r = await post('e1', `/leads/${lead.id}/messages`, {
      channel: 'EMAIL',
      subject: 'Your course enquiry',
      body: 'Hello {{first_name}}',
    });
    expect(r.status).toBe(201);
    const original = ctx.mail.send.bind(ctx.mail);
    ctx.mail.send = async () => {
      throw new Error('SMTP connection refused');
    };
    await tick();
    expect((await message(lead.id)).status).toBe('QUEUED');
    ctx.mail.send = original;
    ctx.clock.advance(31_000);
    await tick();
    expect((await message(lead.id)).status).toBe('SENT');
    expect(ctx.mail.sent.at(-1)).toMatchObject({
      to: 'asha.learner@example.com',
      subject: 'Your course enquiry',
      text: 'Hello Asha',
    });
    const noEmail = await newLead();
    expect(
      (
        await post('e1', `/leads/${noEmail.id}/messages`, {
          channel: 'EMAIL',
          subject: 'x',
          body: 'y',
        })
      ).body.error.code,
    ).toBe('NO_EMAIL');
  });

  it('click-to-call returns a provider reference (sandbox)', async () => {
    const lead = await newLead();
    const r = await post('e1', `/leads/${lead.id}/calls/dial`);
    expect(r.status).toBe(201);
    expect(r.body.providerRef).toMatch(/^sbx-call-/);
  });

  it('appointments: no double booking, reminder, completion with next action, no-show and cancel', async () => {
    const T0 = new Date('2026-12-02T05:30:00Z'); // Wed 11:00 IST
    ctx.clock.set(T0);
    const lead = await newLead();
    const startsAt = new Date(T0.getTime() + 180 * MIN).toISOString();
    const book = await post('e1', `/leads/${lead.id}/appointments`, {
      counsellorId: id.c1,
      startsAt,
      durationMinutes: 45,
      mode: 'VIDEO',
      location: 'https://meet.example.com/abc',
    });
    expect(book.status).toBe(201);
    const clash = await post('e1', `/leads/${lead.id}/appointments`, {
      counsellorId: id.c1,
      startsAt: new Date(T0.getTime() + 200 * MIN).toISOString(),
      mode: 'PHONE',
    });
    expect(clash.body.error.code).toBe('APPOINTMENT_CONFLICT');
    expect(
      (
        await post('e1', `/leads/${lead.id}/appointments`, {
          counsellorId: id.admin,
          startsAt,
          mode: 'PHONE',
        })
      ).status,
    ).toBe(201); // org-wide user is fine
    const job = await ctx.owner.job.findUniqueOrThrow({
      where: { key: `appt:${book.body.id}:remind:${startsAt}` },
    });
    expect(job.runAt).toEqual(new Date(T0.getTime() + 120 * MIN));

    ctx.clock.set(new Date(T0.getTime() + 120 * MIN));
    await tick();
    // Counsellor: one reminder; lead owner: one per appointment on the lead (two were booked).
    for (const [u, count] of [
      [id.c1, 1],
      [id.e1, 2],
    ] as const)
      expect(
        await ctx.owner.notification.count({
          where: { userId: u, type: 'APPOINTMENT_REMINDER', link: `/leads/${lead.id}` },
        }),
      ).toBe(count);
    await tick(); // idempotent
    expect(
      await ctx.owner.notification.count({
        where: { userId: id.c1, type: 'APPOINTMENT_REMINDER' },
      }),
    ).toBe(1);
    const early = await post('c1', `/appointments/${book.body.id}/complete`, {
      attended: true,
      summary: 'Discussed',
    });
    expect(early.body.error.code).toBe('APPOINTMENT_NOT_STARTED');
    expect(
      (await post('e2', `/appointments/${book.body.id}/cancel`, { reason: 'nope' })).status,
    ).toBe(404);

    ctx.clock.set(new Date(T0.getTime() + 230 * MIN));
    const done = await post('c1', `/appointments/${book.body.id}/complete`, {
      attended: true,
      summary: 'Interested in the weekend batch',
      nextTask: { type: 'PAYMENT_FOLLOW_UP', dueAt: '2026-12-03T06:00:00Z' },
    });
    expect(done.status).toBe(201);
    expect(done.body.appointment.status).toBe('COMPLETED');
    expect(done.body.nextTask.ownerId).toBe(id.e1);
    const mine = await get('c1', '/appointments');
    expect(mine.body.map((x: { id: string }) => x.id)).toContain(book.body.id);

    const second = await post('e1', `/leads/${lead.id}/appointments`, {
      counsellorId: id.c1,
      startsAt: new Date(T0.getTime() + 24 * 60 * MIN).toISOString(),
      mode: 'IN_PERSON',
    });
    const moved = await post('e1', `/appointments/${second.body.id}/reschedule`, {
      startsAt: new Date(T0.getTime() + 25 * 60 * MIN).toISOString(),
      reason: 'Student asked',
    });
    expect(moved.status).toBe(201);
    expect(
      (await post('e1', `/appointments/${second.body.id}/cancel`, { reason: 'Student travelling' }))
        .body.status,
    ).toBe('CANCELLED');
    const types = (await ctx.owner.leadEvent.findMany({ where: { leadId: lead.id } })).map(
      (e) => e.type,
    );
    expect(types).toEqual(
      expect.arrayContaining([
        'APPOINTMENT_SCHEDULED',
        'APPOINTMENT_COMPLETED',
        'APPOINTMENT_RESCHEDULED',
        'APPOINTMENT_CANCELLED',
      ]),
    );
  });
});
