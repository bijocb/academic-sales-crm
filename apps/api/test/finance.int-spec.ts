import { buildGatewayRegistry, GatewayRegistry, SandboxGateway } from '../src/finance/gateway';
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

/** Phase 12 exit gate: payment status cannot be forged by the frontend; reconciliation works. */
describe('Payments and finance', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  let sandbox: SandboxGateway;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  let intakeKey = '';
  let course = '';
  let batch = '';
  const MON_11 = new Date('2026-11-30T05:30:00Z');

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const put = (who: string, url: string, body: object) =>
    ctx.http().put(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const deliver = (hook: { body: string; signature: string }) =>
    ctx
      .http()
      .post('/api/v1/webhooks/payments/sandbox')
      .set('content-type', 'application/json')
      .set('x-sandbox-signature', hook.signature)
      .send(hook.body);
  let n = 0;
  /** Admission (documents pending) for a lead with an accepted quotation of 1,00,000.00 INR. */
  const newAdmission = async (withBatch = true) => {
    n++;
    const res = await ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${intakeKey}`)
      .send({ name: `Fee Student ${n}`, phone: `+91 90000 ${String(70000 + n).slice(-5)}` });
    const e = await ctx.owner.enquiry.findUniqueOrThrow({ where: { id: res.body.reference } });
    await post('bm1', `/leads/${e.leadId}/assign`, { userId: id.e1, reason: 'Test' });
    const q = await post('e1', `/leads/${e.leadId}/quotations`, {
      courseId: course,
      ...(withBatch ? { batchId: batch } : {}),
    });
    await post('e1', `/quotations/${q.body.id}/accept`);
    const adm = await post('e1', `/leads/${e.leadId}/admission`);
    expect(adm.status).toBe(201);
    const fin = await get('e1', `/admissions/${adm.body.id}/finance`);
    expect(fin.status).toBe(200);
    return {
      leadId: e.leadId,
      admissionId: adm.body.id as string,
      planId: fin.body.plan.id as string,
    };
  };
  const payments = (admissionId: string) => ctx.owner.payment.findMany({ where: { admissionId } });
  const admission = (admissionId: string) =>
    ctx.owner.admission.findUniqueOrThrow({ where: { id: admissionId } });

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'fin-a');
    id.admin = await createUser(ctx.owner, a, 'admin@fin.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    id.bm1 = await createUser(ctx.owner, a, 'bm1@fin.test', [
      { role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B1' },
    ]);
    id.ao1 = await createUser(ctx.owner, a, 'ao1@fin.test', [
      { role: 'ADMISSION_OFFICER', scope: 'BRAND', brand: 'B1' },
    ]);
    id.acc1 = await createUser(ctx.owner, a, 'acc1@fin.test', [
      { role: 'ACCOUNTS_OFFICER', scope: 'BRAND', brand: 'B1' },
    ]);
    id.acc2 = await createUser(ctx.owner, a, 'acc2@fin.test', [
      { role: 'ACCOUNTS_OFFICER', scope: 'BRAND', brand: 'B1' },
    ]);
    id.e1 = await createUser(ctx.owner, a, 'e1@fin.test', [
      { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' },
    ]);
    for (const k of ['admin', 'bm1', 'ao1', 'acc1', 'acc2', 'e1'])
      t[k] = await bearer(ctx, `${k}@fin.test`);
    const src = await ctx.owner.leadSource.findFirstOrThrow({
      where: { brandId: a.brands.B1, channel: 'WEBSITE' },
    });
    ctx.clock.set(MON_11);
    intakeKey = (await post('admin', '/intake-keys', { sourceId: src.id, name: 'web' })).body.key;
    course = (
      await ctx.owner.course.create({
        data: {
          organizationId: a.orgId,
          brandId: a.brands.B1,
          code: 'FS',
          name: 'Full Stack',
          deliveryMode: 'ONLINE',
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
          code: 'FS-JAN',
          name: 'January',
          startDate: new Date('2027-01-11'),
          capacity: 50,
          status: 'OPEN',
        },
      })
    ).id;
    sandbox = ctx.app.get(GatewayRegistry).get('sandbox') as SandboxGateway;
  });
  afterAll(() => ctx.close());

  it('creates the fee plan from the accepted quotation with one instalment; production has no sandbox gateway', async () => {
    const { admissionId } = await newAdmission();
    const fin = await get('e1', `/admissions/${admissionId}/finance`);
    expect(fin.body.plan).toMatchObject({ currency: 'INR', baseAmountMinor: 10_000_000 });
    expect(fin.body.schedule).toHaveLength(1);
    expect(fin.body.schedule[0]).toMatchObject({
      amountMinor: 10_000_000,
      dueDate: '2026-12-07T00:00:00.000Z',
      paidMinor: 0,
    });
    expect(fin.body).toMatchObject({ outstanding: 10_000_000, gateway: 'sandbox' });
    expect(buildGatewayRegistry('production', 'x'.repeat(20)).primary).toBeNull();
  });

  it('a forged or unsigned webhook and a client "success" never mark anything paid', async () => {
    const { admissionId, planId } = await newAdmission();
    const at = await post('e1', `/fee-plans/${planId}/payment-links`, { amountMinor: 2_500_000 });
    expect(at.status).toBe(201);
    expect(at.body).toMatchObject({ status: 'PENDING', provider: 'sandbox' });
    const forged = JSON.stringify({
      id: 'evt-forged',
      type: 'payment.succeeded',
      orderId: at.body.providerOrderId,
      status: 'SUCCEEDED',
      amountMinor: '2500000',
      currency: 'INR',
      paymentRef: 'x',
    });
    expect((await deliver({ body: forged, signature: 'f'.repeat(64) })).status).toBe(401);
    expect(
      (await ctx.http().post('/api/v1/webhooks/payments/sandbox').send(JSON.parse(forged))).status,
    ).toBe(401);
    // The "customer returned from checkout" path asks the gateway itself: still pending.
    expect((await post('e1', `/payment-attempts/${at.body.id}/check`)).body.status).toBe('PENDING');
    expect(await payments(admissionId)).toHaveLength(0);
    // The forged event id cannot block the real event later.
    expect(await ctx.owner.paymentEvent.count({ where: { eventId: 'evt-forged' } })).toBe(0);
    expect(
      await ctx.owner.paymentEvent.count({
        where: { signatureValid: false, result: 'REJECTED_SIGNATURE' },
      }),
    ).toBeGreaterThanOrEqual(2);
    expect((await admission(admissionId)).status).toBe('DOCUMENTS_PENDING');
  });

  it('a signed webhook records one payment, issues a receipt and confirms the admission (D-006); duplicates are ignored', async () => {
    const { leadId, admissionId, planId } = await newAdmission();
    const at = await post('e1', `/fee-plans/${planId}/payment-links`, { amountMinor: 2_500_000 });
    const hook = sandbox.complete(at.body.providerOrderId, 'SUCCEEDED');
    const r = await deliver(hook);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: true, matched: true });
    expect((await deliver(hook)).body).toMatchObject({ duplicate: true });
    const ps = await payments(admissionId);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({
      amountMinor: 2_500_000n,
      method: 'GATEWAY',
      verification: 'GATEWAY_WEBHOOK',
      receiptNumber: 'B1-RCPT-2026-000001',
    });
    const adm = await admission(admissionId);
    expect(adm.status).toBe('CONFIRMED');
    expect(adm.confirmationSource).toBe('VERIFIED_PAYMENT');
    expect((await ctx.owner.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe(
      'CONVERTED',
    );
    const fin = await get('e1', `/admissions/${admissionId}/finance`);
    expect(fin.body).toMatchObject({ paid: 2_500_000, outstanding: 7_500_000 });
    expect(fin.body.schedule[0]).toMatchObject({ paidMinor: 2_500_000, dueMinor: 7_500_000 });
    const receipt = await get('e1', `/payments/${ps[0].id}/receipt`);
    expect(receipt.body).toMatchObject({
      receiptNumber: 'B1-RCPT-2026-000001',
      amountMinor: 2_500_000,
      admissionNumber: adm.admissionNumber,
    });
    await expect(
      ctx.owner.$executeRawUnsafe(`UPDATE payments SET amount_minor = 1 WHERE id = '${ps[0].id}'`),
    ).rejects.toThrow();
    await expect(
      ctx.owner.$executeRawUnsafe(`DELETE FROM payments WHERE id = '${ps[0].id}'`),
    ).rejects.toThrow();
  });

  it('an amount mismatch is flagged and not recorded', async () => {
    const { admissionId, planId } = await newAdmission();
    const at = await post('e1', `/fee-plans/${planId}/payment-links`, { amountMinor: 3_000_000 });
    expect(
      (await deliver(sandbox.complete(at.body.providerOrderId, 'SUCCEEDED', 300n))).status,
    ).toBe(200);
    expect(await payments(admissionId)).toHaveLength(0);
    const flagged = await ctx.owner.paymentAttempt.findUniqueOrThrow({ where: { id: at.body.id } });
    expect(flagged.status).toBe('PENDING');
    expect(flagged.mismatch).toMatch(/expected 3000000 INR/);
    expect(
      (await get('acc1', '/finance/reconciliation')).body.mismatched.map(
        (x: { id: string }) => x.id,
      ),
    ).toContain(at.body.id);
  });

  it('reconciliation pays a missed webhook exactly once, even if the webhook arrives later', async () => {
    const { admissionId, planId } = await newAdmission();
    const at = await post('e1', `/fee-plans/${planId}/payment-links`, { amountMinor: 1_000_000 });
    const lateHook = sandbox.complete(at.body.providerOrderId, 'SUCCEEDED'); // webhook lost in transit
    await ctx.app.get(WorkerService).tick();
    expect(await payments(admissionId)).toHaveLength(0); // too recent to reconcile
    ctx.clock.advance(11 * MIN);
    const tick = await ctx.app.get(WorkerService).tick();
    expect(tick.payments?.checked).toBeGreaterThanOrEqual(1);
    const ps = await payments(admissionId);
    expect(ps).toHaveLength(1);
    expect(ps[0].verification).toBe('GATEWAY_RECONCILIATION');
    expect((await admission(admissionId)).status).toBe('CONFIRMED');
    expect((await deliver(lateHook)).status).toBe(200);
    expect(await payments(admissionId)).toHaveLength(1);
    ctx.clock.set(MON_11);
  });

  it('manual payments: Accounts only, no overpayment, allocated to instalments oldest first', async () => {
    const { admissionId, planId } = await newAdmission();
    expect(
      (
        await put('e1', `/fee-plans/${planId}/schedule`, {
          mode: 'CUSTOM',
          instalments: [{ dueDate: '2026-12-01', amountMinor: 100 }],
        })
      ).body.error.code,
    ).toBe('SCHEDULE_MISMATCH');
    const sch = await put('e1', `/fee-plans/${planId}/schedule`, {
      mode: 'EQUAL',
      count: 3,
      firstDueDate: '2026-12-01',
      intervalDays: 30,
    });
    expect(sch.body.map((x: { amountMinor: number }) => x.amountMinor)).toEqual([
      3_333_333, 3_333_333, 3_333_334,
    ]);
    const pay = {
      amountMinor: 4_000_000,
      method: 'BANK_TRANSFER',
      reference: 'NEFT123',
      receivedAt: MON_11.toISOString(),
    };
    expect((await post('e1', `/fee-plans/${planId}/payments`, pay)).status).toBe(403);
    expect(
      (await post('acc1', `/fee-plans/${planId}/payments`, { ...pay, amountMinor: 20_000_000 }))
        .body.error.code,
    ).toBe('OVERPAYMENT');
    const r = await post('acc1', `/fee-plans/${planId}/payments`, pay);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      verification: 'MANUAL',
      verifiedById: id.acc1,
      method: 'BANK_TRANSFER',
    });
    const fin = await get('acc1', `/admissions/${admissionId}/finance`);
    expect(fin.body.schedule.map((x: { paidMinor: number }) => x.paidMinor)).toEqual([
      3_333_333, 666_667, 0,
    ]);
    expect(fin.body.outstanding).toBe(6_000_000);
    expect((await admission(admissionId)).status).toBe('CONFIRMED');
    // After the first payment only Accounts may re-plan.
    expect(
      (
        await put('e1', `/fee-plans/${planId}/schedule`, {
          mode: 'EQUAL',
          count: 2,
          firstDueDate: '2026-12-01',
        })
      ).status,
    ).toBe(403);
  });

  it('fee adjustments are restricted, append-only and absorbed by the last instalment', async () => {
    const { admissionId, planId } = await newAdmission();
    expect(
      (
        await post('e1', `/fee-plans/${planId}/adjustments`, {
          amountMinor: -100_000,
          reason: 'Concession',
        })
      ).status,
    ).toBe(403);
    const r = await post('acc1', `/fee-plans/${planId}/adjustments`, {
      amountMinor: -500_000,
      reason: 'Merit concession',
    });
    expect(r.status).toBe(201);
    const fin = await get('acc1', `/admissions/${admissionId}/finance`);
    expect(fin.body).toMatchObject({ netFee: 9_500_000, adjustments: -500_000 });
    expect(fin.body.schedule.at(-1).amountMinor).toBe(9_500_000);
    await expect(
      ctx.owner.$executeRawUnsafe(`DELETE FROM fee_adjustments WHERE id = '${r.body.id}'`),
    ).rejects.toThrow();
  });

  it('refunds: maker–checker approval; a partial refund keeps the admission, a full refund cancels it (A-007b)', async () => {
    const { leadId, admissionId, planId } = await newAdmission();
    const pay = await post('acc1', `/fee-plans/${planId}/payments`, {
      amountMinor: 2_000_000,
      method: 'UPI',
      reference: 'UPI-1',
      receivedAt: MON_11.toISOString(),
    });
    expect((await admission(admissionId)).status).toBe('CONFIRMED');
    expect(
      (
        await post('e1', `/payments/${pay.body.id}/refunds`, {
          amountMinor: 100,
          reason: 'Asked back',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post('acc1', `/payments/${pay.body.id}/refunds`, {
          amountMinor: 3_000_000,
          reason: 'Too much',
        })
      ).body.error.code,
    ).toBe('REFUND_TOO_LARGE');
    const part = await post('acc1', `/payments/${pay.body.id}/refunds`, {
      amountMinor: 500_000,
      reason: 'Hostel fee returned',
    });
    expect(part.body.status).toBe('REQUESTED');
    expect((await post('acc1', `/refunds/${part.body.id}/approve`)).status).toBe(403); // maker–checker
    expect(
      (
        await post('acc2', `/refunds/${part.body.id}/paid`, {
          method: 'UPI',
          reference: 'R1',
          paidOn: '2026-11-30',
        })
      ).body.error.code,
    ).toBe('REFUND_STATE');
    expect(
      (await post('acc2', `/refunds/${part.body.id}/approve`, { note: 'OK' })).body.status,
    ).toBe('APPROVED');
    expect(
      (
        await post('acc2', `/refunds/${part.body.id}/paid`, {
          method: 'UPI',
          reference: 'UPI-R1',
          paidOn: '2026-11-30',
        })
      ).body.status,
    ).toBe('PAID');
    expect((await admission(admissionId)).status).toBe('CONFIRMED');
    expect((await get('acc1', `/admissions/${admissionId}/finance`)).body).toMatchObject({
      netCollected: 1_500_000,
      refundedPaid: 500_000,
    });
    // The student asks for the rest of the advance back.
    const rest = await post('acc1', `/payments/${pay.body.id}/refunds`, {
      amountMinor: 1_500_000,
      reason: 'Student withdrew',
    });
    await post('acc2', `/refunds/${rest.body.id}/approve`);
    await post('acc2', `/refunds/${rest.body.id}/paid`, {
      method: 'BANK_TRANSFER',
      reference: 'NEFT-R2',
      paidOn: '2026-11-30',
    });
    const adm = await admission(admissionId);
    expect(adm).toMatchObject({ status: 'CANCELLED_REFUNDED', holdsSeat: false });
    expect((await ctx.owner.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe(
      'CLOSED_LOST',
    );
    expect(await ctx.owner.payment.count({ where: { admissionId } })).toBe(1); // the original payment is untouched
    const list = await get('acc2', '/finance/refunds?status=PAID');
    expect(list.body.map((x: { id: string }) => x.id)).toEqual(
      expect.arrayContaining([part.body.id, rest.body.id]),
    );
    await expect(
      ctx.owner.$executeRawUnsafe(`DELETE FROM refund_events WHERE refund_id = '${rest.body.id}'`),
    ).rejects.toThrow();
  });

  it('a payment that cannot confirm (no batch) is kept, officers are told, and they can confirm once fixed', async () => {
    const { admissionId, planId } = await newAdmission(false);
    expect((await post('ao1', `/admissions/${admissionId}/confirm`)).body.error.code).toBe(
      'NO_VERIFIED_PAYMENT',
    );
    await post('acc1', `/fee-plans/${planId}/payments`, {
      amountMinor: 500_000,
      method: 'CASH',
      receivedAt: MON_11.toISOString(),
    });
    expect((await admission(admissionId)).status).toBe('DOCUMENTS_PENDING');
    const adm = await admission(admissionId);
    expect(
      await ctx.owner.leadEvent.count({
        where: { leadId: adm.leadId, type: 'ADMISSION_CONFIRMATION_BLOCKED' },
      }),
    ).toBe(1);
    expect(
      await ctx.owner.notification.count({
        where: { userId: id.ao1, type: 'ADMISSION_CONFIRMATION_BLOCKED' },
      }),
    ).toBeGreaterThan(0);
    await ctx
      .http()
      .patch(`/api/v1/admissions/${admissionId}/batch`)
      .set('Authorization', t.ao1)
      .send({ batchId: batch });
    expect((await post('e1', `/admissions/${admissionId}/confirm`)).status).toBe(403);
    const ok = await post('ao1', `/admissions/${admissionId}/confirm`);
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('CONFIRMED');
  });

  it('finance settings need settings.manage', async () => {
    const body = {
      receiptNumberFormat: 'R/{YY}/{SEQ:4}',
      minConfirmAmountMinor: 100_000,
      defaultDueDays: 3,
      refundMakerChecker: true,
    };
    expect((await put('acc1', `/finance-settings?brandId=${a.brands.B1}`, body)).status).toBe(403);
    expect((await put('bm1', `/finance-settings?brandId=${a.brands.B1}`, body)).body).toMatchObject(
      { receiptNumberFormat: 'R/{YY}/{SEQ:4}', minConfirmAmountMinor: 100_000 },
    );
    // Below the new minimum the admission is not confirmed yet.
    const { admissionId, planId } = await newAdmission();
    const r = await post('acc1', `/fee-plans/${planId}/payments`, {
      amountMinor: 50_000,
      method: 'CASH',
      receivedAt: MON_11.toISOString(),
    });
    expect(r.body.receiptNumber).toMatch(/^R\/26\/\d{4}$/);
    expect((await admission(admissionId)).status).not.toBe('CONFIRMED');
  });
});
