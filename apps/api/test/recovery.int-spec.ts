import { WorkerService } from '../src/jobs/worker.service';
import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

const DAY = 24 * 60 * 60_000;

/** Phase 10 exit gate: recovery and closure scenarios. */
describe('Lost lead recovery', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  const reason: Record<string, string> = {};
  let intakeKey = '';
  const MON_11 = new Date('2026-11-30T05:30:00Z'); // Monday 11:00 IST

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const put = (who: string, url: string, body: object) =>
    ctx.http().put(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const tick = () => ctx.app.get(WorkerService).tick();
  /** The test clock jumps weeks ahead; sessions are re-issued at the current clock. */
  const login = async () => {
    for (const k of ['admin', 'bm1', 'e1', 'e2']) t[k] = await bearer(ctx, `${k}@rec.test`);
  };
  const at = async (d: Date) => {
    ctx.clock.set(d);
    return tick();
  };
  const only = (emails: string[]) =>
    ctx.owner.$transaction([
      ctx.owner.user.updateMany({
        where: { email: { endsWith: '@rec.test' } },
        data: { isAvailable: false },
      }),
      ctx.owner.user.updateMany({ where: { email: { in: emails } }, data: { isAvailable: true } }),
    ]);
  let n = 0;
  const intake = (phone: string) =>
    ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${intakeKey}`)
      .send({ name: `Lost Student ${n}`, phone });
  /** A lead auto-allocated to e1. */
  const newLead = async () => {
    n++;
    await only(['e1@rec.test']);
    const res = await intake(`+91 92000 ${String(50000 + n).slice(-5)}`);
    expect(res.status).toBe(201);
    const e = await ctx.owner.enquiry.findUniqueOrThrow({
      where: { id: res.body.reference },
      include: { lead: true },
    });
    expect(e.lead.ownerId).toBe(id.e1);
    return e.lead;
  };
  const lead = (leadId: string) => ctx.owner.lead.findUniqueOrThrow({ where: { id: leadId } });
  const kase = (leadId: string) =>
    ctx.owner.recoveryCase.findFirstOrThrow({ where: { leadId }, orderBy: { createdAt: 'desc' } });
  const loseForRecovery = (leadId: string, who = 'e1') =>
    post(who, `/leads/${leadId}/lost`, {
      lossReasonId: reason.FEE_TOO_HIGH,
      notes: 'Wants a cheaper option',
      plan: 'RECOVER',
    });
  /** Lose, wait out the 7-day cooldown and let the job start recovery. Returns the case. */
  const inRecovery = async (owners: string[] = ['e1@rec.test', 'e2@rec.test']) => {
    const l = await newLead();
    expect((await loseForRecovery(l.id)).status).toBe(201);
    await only(owners);
    await at(new Date(ctx.clock.now().getTime() + 7 * DAY));
    await login();
    return { lead: l, case: await kase(l.id) };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'rec-a', { autoAllocate: true });
    id.admin = await createUser(ctx.owner, a, 'admin@rec.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    id.bm1 = await createUser(ctx.owner, a, 'bm1@rec.test', [
      { role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B1' },
    ]);
    for (const e of ['e1', 'e2'])
      id[e] = await createUser(ctx.owner, a, `${e}@rec.test`, [
        { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' },
      ]);
    for (const k of ['admin', 'bm1', 'e1', 'e2']) t[k] = await bearer(ctx, `${k}@rec.test`);
    const src = await ctx.owner.leadSource.findFirstOrThrow({
      where: { brandId: a.brands.B1, channel: 'WEBSITE' },
    });
    ctx.clock.set(MON_11);
    intakeKey = (await post('admin', '/intake-keys', { sourceId: src.id, name: 'web' })).body.key;
    for (const r of await ctx.owner.lossReason.findMany({ where: { brandId: a.brands.B1 } }))
      reason[r.code] = r.id;
  });
  afterAll(() => ctx.close());

  it('marking lost needs a reason and notes; it stops the SLA, cancels tasks and schedules recovery after the cooldown', async () => {
    ctx.clock.set(MON_11);
    await login();
    const l = await newLead();
    expect(
      (
        await post('e1', `/leads/${l.id}/lost`, {
          lossReasonId: reason.FEE_TOO_HIGH,
          plan: 'RECOVER',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('e1', `/leads/${l.id}/lost`, {
          lossReasonId: reason.INVALID_ENQUIRY,
          notes: 'Fake number',
          plan: 'RECOVER',
        })
      ).body.error.code,
    ).toBe('REASON_NOT_RECOVERABLE');
    expect(
      (
        await post('e1', `/leads/${l.id}/lost`, {
          lossReasonId: reason.FEE_TOO_HIGH,
          notes: 'Too costly',
          plan: 'CLOSE',
        })
      ).status,
    ).toBe(403); // closing a recoverable lead without recovery needs a manager
    const r = await loseForRecovery(l.id);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('LOST');
    expect((await lead(l.id)).status).toBe('LOST');
    expect((await ctx.owner.slaInstance.findFirstOrThrow({ where: { leadId: l.id } })).state).toBe(
      'CANCELLED',
    );
    expect(await ctx.owner.task.count({ where: { leadId: l.id, status: 'OPEN' } })).toBe(0);
    const c = await kase(l.id);
    expect(c).toMatchObject({
      status: 'SCHEDULED',
      attempts: 0,
      maxAttempts: 3,
      previousOwnerId: id.e1,
      lossNotes: 'Wants a cheaper option',
    });
    expect(c.startsAt).toEqual(new Date(MON_11.getTime() + 7 * DAY));
    const h = await ctx.owner.leadStatusHistory.findMany({ where: { leadId: l.id } });
    expect(h.map((x) => [x.fromStatus, x.toStatus, x.reasonCode])).toEqual([
      ['OPEN', 'LOST', 'FEE_TOO_HIGH'],
    ]);
    expect(
      (
        await post('e1', `/leads/${l.id}/lost`, {
          lossReasonId: reason.FEE_TOO_HIGH,
          notes: 'again',
          plan: 'RECOVER',
        })
      ).body.error.code,
    ).toBe('LEAD_NOT_OPEN');
  });

  it('after the cooldown a different executive gets the lead with a recovery task; no SLA clock restarts', async () => {
    ctx.clock.set(MON_11);
    await login();
    const { lead: l, case: c } = await inRecovery();
    expect(c).toMatchObject({ status: 'ACTIVE', ownerId: id.e2 });
    expect(await lead(l.id)).toMatchObject({ status: 'IN_RECOVERY', ownerId: id.e2 });
    const assignment = await ctx.owner.leadAssignment.findFirstOrThrow({
      where: { leadId: l.id, type: 'RECOVERY' },
    });
    expect(assignment).toMatchObject({ fromUserId: id.e1, toUserId: id.e2 });
    const task = await ctx.owner.task.findFirstOrThrow({ where: { leadId: l.id, status: 'OPEN' } });
    expect(task).toMatchObject({ title: 'Recovery call 1', ownerId: id.e2, type: 'CALL_BACK' });
    expect(
      await ctx.owner.slaInstance.count({
        where: { leadId: l.id, state: { in: ['PENDING', 'AT_RISK', 'BREACHED'] } },
      }),
    ).toBe(0);
    const mine = await get('e2', '/recovery');
    expect(mine.body.map((x: { id: string }) => x.id)).toContain(c.id);
  });

  it('attempts are recorded up to the maximum, then the lead is closed as lost', async () => {
    ctx.clock.set(new Date('2026-12-14T05:30:00Z')); // Monday
    await login();
    const { lead: l, case: c } = await inRecovery();
    expect(
      (await post('e1', `/recovery/${c.id}/attempts`, { channel: 'CALL', outcome: 'NO_RESPONSE' }))
        .status,
    ).toBe(404); // the previous owner no longer sees the lead
    const a1 = await post('e2', `/recovery/${c.id}/attempts`, {
      channel: 'CALL',
      outcome: 'NO_RESPONSE',
      notes: 'Rang out',
    });
    expect(a1.status).toBe(201);
    expect(a1.body).toMatchObject({ attemptNo: 1, result: 'CONTINUE' });
    const next = await ctx.owner.task.findFirstOrThrow({ where: { leadId: l.id, status: 'OPEN' } });
    expect(next.title).toBe('Recovery call 2');
    expect(next.dueAt).toEqual(new Date(ctx.clock.now().getTime() + 3 * DAY));
    const a2 = await post('e2', `/recovery/${c.id}/attempts`, {
      channel: 'WHATSAPP',
      outcome: 'CALL_BACK_LATER',
      nextAttemptAt: new Date(ctx.clock.now().getTime() + 2 * DAY).toISOString(),
    });
    expect(a2.body.attemptNo).toBe(2);
    const a3 = await post('e2', `/recovery/${c.id}/attempts`, {
      channel: 'CALL',
      outcome: 'NOT_INTERESTED',
      notes: 'Joined elsewhere',
    });
    expect(a3.body).toMatchObject({ attemptNo: 3, result: 'CLOSED' });
    expect(await kase(l.id)).toMatchObject({
      status: 'CLOSED',
      attempts: 3,
      closeReason: 'No recovery after 3 attempts',
    });
    expect((await lead(l.id)).status).toBe('CLOSED_LOST');
    const attempts = await ctx.owner.recoveryAttempt.findMany({
      where: { caseId: c.id },
      orderBy: { attemptNo: 'asc' },
    });
    expect(attempts.map((x) => [x.attemptNo, x.channel, x.outcome])).toEqual([
      [1, 'CALL', 'NO_RESPONSE'],
      [2, 'WHATSAPP', 'CALL_BACK_LATER'],
      [3, 'CALL', 'NOT_INTERESTED'],
    ]);
    expect(await ctx.owner.activity.count({ where: { leadId: l.id, type: 'CALL' } })).toBe(2);
    await expect(
      ctx.owner.$executeRawUnsafe(
        `UPDATE recovery_attempts SET outcome = 'INTERESTED' WHERE case_id = '${c.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      ctx.owner.$executeRawUnsafe(`DELETE FROM lead_status_history WHERE lead_id = '${l.id}'`),
    ).rejects.toThrow();
    expect(
      (await post('e2', `/recovery/${c.id}/attempts`, { channel: 'CALL', outcome: 'INTERESTED' }))
        .body.error.code,
    ).toBe('CASE_NOT_ACTIVE');
  });

  it('an interested lead reopens with a next action and keeps its lost history', async () => {
    ctx.clock.set(new Date('2026-12-28T05:30:00Z')); // Monday
    await login();
    const { lead: l, case: c } = await inRecovery();
    const course = await ctx.owner.course.create({
      data: {
        organizationId: a.orgId,
        brandId: a.brands.B1,
        code: 'ALT',
        name: 'Short course',
        deliveryMode: 'ONLINE',
        currency: 'INR',
        listFeeMinor: 3_000_000n,
      },
    });
    expect(
      (await post('e2', `/recovery/${c.id}/attempts`, { channel: 'CALL', outcome: 'INTERESTED' }))
        .body.error.code,
    ).toBe('NEXT_ACTION_REQUIRED');
    const r = await post('e2', `/recovery/${c.id}/attempts`, {
      channel: 'CALL',
      outcome: 'INTERESTED',
      notes: 'Interested in the shorter course',
      offeredCourseId: course.id,
      nextTask: {
        type: 'COUNSELLING',
        dueAt: new Date(ctx.clock.now().getTime() + DAY).toISOString(),
      },
    });
    expect(r.body.result).toBe('RECOVERED');
    expect(await lead(l.id)).toMatchObject({ status: 'OPEN', ownerId: id.e2 });
    expect((await kase(l.id)).status).toBe('RECOVERED');
    const h = await ctx.owner.leadStatusHistory.findMany({
      where: { leadId: l.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(h.map((x) => `${x.fromStatus}>${x.toStatus}`)).toEqual([
      'OPEN>LOST',
      'LOST>IN_RECOVERY',
      'IN_RECOVERY>OPEN',
    ]);
    expect(
      await ctx.owner.task.count({ where: { leadId: l.id, status: 'OPEN', type: 'COUNSELLING' } }),
    ).toBe(1);
    const view = await get('e2', `/leads/${l.id}/recovery`);
    expect(view.body.cases[0]).toMatchObject({
      status: 'RECOVERED',
      lossReason: 'Fee too high',
      ownerName: 'e2',
    });
    expect(view.body.cases[0].attemptsLog[0].offeredCourseId).toBe(course.id);
    // The reopened lead can be quoted the alternative course as usual.
    expect((await post('e2', `/leads/${l.id}/quotations`, { courseId: course.id })).status).toBe(
      201,
    );
  });

  it('opt-out: no recovery without contact permission; an opt-out ends a waiting or active case', async () => {
    ctx.clock.set(new Date('2027-01-11T05:30:00Z')); // Monday
    await login();
    const dnc = await newLead();
    await post('e1', `/leads/${dnc.id}/contact-preference`, {
      doNotContact: true,
      reason: 'Asked us to stop calling',
    });
    expect((await loseForRecovery(dnc.id)).body.error.code).toBe('OPTED_OUT');

    const waiting = await newLead();
    await loseForRecovery(waiting.id);
    await post('e1', `/leads/${waiting.id}/contact-preference`, {
      doNotContact: true,
      reason: 'Replied STOP by SMS',
    });
    expect(await kase(waiting.id)).toMatchObject({
      status: 'CLOSED',
      closeReason: 'The person opted out of contact',
    });
    expect((await lead(waiting.id)).status).toBe('CLOSED_LOST');

    const { lead: active, case: c } = await inRecovery();
    const r = await post('e2', `/recovery/${c.id}/attempts`, {
      channel: 'CALL',
      outcome: 'OPTED_OUT',
      notes: 'Do not call again',
    });
    expect(r.body.result).toBe('CLOSED');
    expect(
      (await ctx.owner.person.findUniqueOrThrow({ where: { id: active.personId } })).doNotContact,
    ).toBe(true);
    expect((await lead(active.id)).status).toBe('CLOSED_LOST');
    expect(
      (
        await post('e2', `/leads/${active.id}/messages`, {
          channel: 'EMAIL',
          subject: 'Hi',
          body: 'Hello',
        })
      ).body.error.code,
    ).toBe('OPTED_OUT');
  });

  it('closure: non-recoverable reasons close directly; managers can close or start early; executives cannot', async () => {
    ctx.clock.set(new Date('2027-01-25T05:30:00Z')); // Monday
    await login();
    const fake = await newLead();
    const r = await post('e1', `/leads/${fake.id}/lost`, {
      lossReasonId: reason.INVALID_ENQUIRY,
      notes: 'Test submission',
      plan: 'CLOSE',
    });
    expect(r.body.status).toBe('CLOSED_LOST');
    expect(await ctx.owner.recoveryCase.count({ where: { leadId: fake.id } })).toBe(0);

    const direct = await newLead();
    expect(
      (
        await post('bm1', `/leads/${direct.id}/lost`, {
          lossReasonId: reason.FEE_TOO_HIGH,
          notes: 'Manager decision',
          plan: 'CLOSE',
        })
      ).body.status,
    ).toBe('CLOSED_LOST');

    const early = await newLead();
    await loseForRecovery(early.id);
    const c = await kase(early.id);
    expect((await post('e1', `/recovery/${c.id}/start`)).status).toBe(403);
    await only(['e1@rec.test', 'e2@rec.test']);
    const s = await post('bm1', `/recovery/${c.id}/start`);
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ status: 'ACTIVE', ownerId: id.e2 });
    expect((await post('e2', `/recovery/${c.id}/close`, { reason: 'Not worth it' })).status).toBe(
      403,
    );
    expect(
      (await post('bm1', `/recovery/${c.id}/close`, { reason: 'Moved abroad' })).body.status,
    ).toBe('CLOSED');
    expect((await lead(early.id)).status).toBe('CLOSED_LOST');
    expect((await get('e1', '/recovery?view=all')).status).toBe(403);
  });

  it('outside working hours the case waits for the next working time', async () => {
    ctx.clock.set(new Date('2027-01-23T10:00:00Z')); // Saturday 15:30 IST, working
    await login();
    const l = await newLead();
    ctx.clock.set(new Date('2027-01-23T13:30:00Z')); // Saturday 19:00 IST, after hours
    await post('e1', `/leads/${l.id}/lost`, {
      lossReasonId: reason.LATER_INTAKE,
      notes: 'Wants the July intake',
      plan: 'RECOVER',
    });
    await only(['e1@rec.test', 'e2@rec.test']);
    await at(new Date('2027-01-30T13:30:00Z')); // cooldown ends Saturday 19:00 IST
    const c = await kase(l.id);
    expect(c.status).toBe('SCHEDULED');
    const job = await ctx.owner.job.findUniqueOrThrow({ where: { key: `recovery:${c.id}:start` } });
    expect(job.runAt).toEqual(new Date('2027-02-01T04:00:00Z')); // Monday 09:30 IST (Sunday is off)
    await at(new Date('2027-02-01T04:00:00Z'));
    expect(await kase(l.id)).toMatchObject({ status: 'ACTIVE', ownerId: id.e2 });
  });

  it('a person who enquires again during the cooldown gets a new lead; the waiting case is cancelled', async () => {
    ctx.clock.set(new Date('2027-02-08T05:30:00Z')); // Monday
    await login();
    const l = await newLead();
    await loseForRecovery(l.id);
    const person = await ctx.owner.person.findUniqueOrThrow({ where: { id: l.personId } });
    ctx.clock.advance(DAY);
    await only(['e1@rec.test']);
    const res = await intake(person.phoneE164!);
    expect(res.status).toBe(201);
    const e = await ctx.owner.enquiry.findUniqueOrThrow({
      where: { id: res.body.reference },
      include: { lead: true },
    });
    expect(e.lead.id).not.toBe(l.id);
    expect(e.lead.previousLeadId).toBe(l.id);
    expect(await kase(l.id)).toMatchObject({ status: 'CANCELLED' });
    expect((await lead(l.id)).status).toBe('CLOSED_LOST');
  });

  it('without auto-close the case waits for a manager after the last attempt; settings need settings.manage', async () => {
    ctx.clock.set(new Date('2027-02-15T05:30:00Z')); // Monday
    await login();
    const policy = {
      enabled: true,
      cooldownDays: 0,
      maxAttempts: 1,
      attemptIntervalDays: 2,
      ownerMode: 'SAME_OWNER',
      autoCloseAfterMax: false,
    };
    expect((await put('e1', `/recovery/policy?brandId=${a.brands.B1}`, policy)).status).toBe(403);
    expect((await put('bm1', `/recovery/policy?brandId=${a.brands.B1}`, policy)).status).toBe(200);
    const l = await newLead();
    await loseForRecovery(l.id);
    await tick(); // cooldown 0 → starts at once, same owner
    const c = await kase(l.id);
    expect(c).toMatchObject({ status: 'ACTIVE', ownerId: id.e1 });
    const r = await post('e1', `/recovery/${c.id}/attempts`, {
      channel: 'CALL',
      outcome: 'NO_RESPONSE',
    });
    expect(r.body).toMatchObject({ result: 'AWAITING_MANAGER', nextAttemptAt: null });
    const queue = await get('bm1', '/recovery?view=all');
    expect(queue.body.find((x: { id: string }) => x.id === c.id).awaitingManager).toBe(true);
    const created = await post('bm1', '/loss-reasons', {
      brandId: a.brands.B1,
      code: 'VISA_ISSUE',
      label: 'Visa not approved',
    });
    expect(created.status).toBe(201);
    expect(
      (await post('e1', '/loss-reasons', { brandId: a.brands.B1, code: 'X_Y', label: 'xx' }))
        .status,
    ).toBe(403);
    expect(
      (await get('e1', `/loss-reasons?brandId=${a.brands.B1}`)).body.map(
        (x: { code: string }) => x.code,
      ),
    ).toContain('VISA_ISSUE');
  });
});
