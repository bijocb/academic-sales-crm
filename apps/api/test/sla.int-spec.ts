import { AllocationService } from '../src/allocation/allocation.service';
import { Db } from '../src/db/db.service';
import { JobsService } from '../src/jobs/jobs.service';
import { WorkerService } from '../src/jobs/worker.service';
import { TaskCoreService } from '../src/work/task-core.service';
import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';
import { TEST_ENV } from './env';

const MIN = 60_000;

/** Phase 7 exit gate: time-bound task/SLA behaviour under a controllable clock. */
describe('Tasks and SLA engine', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  let intakeKey = '';
  // Monday 30 Nov 2026 11:00 IST (B1 works Mon–Sat 09:30–18:30 IST by default).
  const MON_11 = new Date('2026-11-30T05:30:00Z');

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const tick = () => ctx.app.get(WorkerService).tick();
  const at = async (d: Date) => {
    ctx.clock.set(d);
    return tick();
  };
  const plus = (d: Date, minutes: number) => new Date(d.getTime() + minutes * MIN);
  const available = (emails: string[]) =>
    ctx.owner.$transaction([
      ctx.owner.user.updateMany({
        where: { email: { endsWith: '@sla.test' } },
        data: { isAvailable: false },
      }),
      ctx.owner.user.updateMany({ where: { email: { in: emails } }, data: { isAvailable: true } }),
    ]);
  let n = 0;
  const newLead = async () => {
    n++;
    const res = await ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${intakeKey}`)
      .send({ name: `Learner ${n}`, phone: `+91 96000 ${String(20000 + n).slice(-5)}` });
    expect(res.status).toBe(201);
    const e = await ctx.owner.enquiry.findUniqueOrThrow({ where: { id: res.body.reference } });
    return ctx.owner.lead.findUniqueOrThrow({ where: { id: e.leadId } });
  };
  const sla = (leadId: string) =>
    ctx.owner.slaInstance.findFirstOrThrow({ where: { leadId }, orderBy: { startedAt: 'desc' } });
  const notes = (userId: string, type: string, leadId?: string) =>
    ctx.owner.notification.findMany({
      where: { userId, type, ...(leadId ? { link: `/leads/${leadId}` } : {}) },
    });
  const firstTask = (leadId: string) =>
    ctx.owner.task.findFirstOrThrow({ where: { leadId, isInitial: true } });

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'sla-a', { autoAllocate: true });
    id.admin = await createUser(ctx.owner, a, 'admin@sla.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    id.bm1 = await createUser(ctx.owner, a, 'bm1@sla.test', [
      { role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B1' },
    ]);
    id.tl1 = await createUser(ctx.owner, a, 'tl1@sla.test', [
      { role: 'TEAM_LEADER', scope: 'TEAM', brand: 'B1' },
    ]);
    for (const e of ['e1', 'e2', 'e3'])
      id[e] = await createUser(ctx.owner, a, `${e}@sla.test`, [
        { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' },
      ]);
    await ctx.owner.team.update({ where: { id: a.teams.B1 }, data: { leaderId: id.tl1 } });
    for (const k of ['admin', 'bm1', 'tl1', 'e1', 'e2', 'e3'])
      t[k] = await bearer(ctx, `${k}@sla.test`);
    const src = await ctx.owner.leadSource.findFirstOrThrow({
      where: { brandId: a.brands.B1, channel: 'WEBSITE' },
    });
    ctx.clock.set(MON_11);
    intakeKey = (await post('admin', '/intake-keys', { sourceId: src.id, name: 'web' })).body.key;
  });
  afterAll(() => ctx.close());

  it('every assigned lead gets exactly one first-call task and an SLA clock, even when allocation retries', async () => {
    ctx.clock.set(MON_11);
    await available(['e1@sla.test']);
    const lead = await newLead();
    expect(lead.ownerId).toBe(id.e1);
    // Retry through the engine and through the API: nothing is duplicated.
    const engine = ctx.app.get(AllocationService);
    expect((await engine.allocate(a.orgId, lead.id, { trigger: 'MANUAL_RETRY' })).outcome).toBe(
      'ALREADY_ASSIGNED',
    );
    await post('bm1', `/leads/${lead.id}/allocate`);
    const tasks = await ctx.owner.task.findMany({ where: { leadId: lead.id } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      type: 'FIRST_CALL',
      ownerId: id.e1,
      isInitial: true,
      status: 'OPEN',
    });
    const s = await sla(lead.id);
    expect(s).toMatchObject({
      state: 'PENDING',
      ownerId: id.e1,
      targetMinutes: 15,
      basis: 'WORKING',
    });
    expect(s.dueAt).toEqual(plus(MON_11, 15));
    expect(tasks[0].dueAt).toEqual(s.dueAt);
    const jobs = await ctx.owner.job.findMany({ where: { key: { startsWith: `sla:${s.id}:` } } });
    expect(jobs.map((j) => j.runAt.getTime()).sort()).toEqual(
      [5, 15, 15, 30, 60, 90].map((m) => plus(MON_11, m).getTime()),
    );
    // The executive sees it in "My tasks".
    const mine = await get('e1', '/tasks');
    expect(mine.body.map((x: { leadId: string }) => x.leadId)).toContain(lead.id);
  });

  it('runs the 5/15/30/60/90 ladder on working time: remind, alert team leader, reassign twice, escalate', async () => {
    const T0 = plus(MON_11, 120); // 13:00 IST
    ctx.clock.set(T0);
    await available(['e1@sla.test']);
    const lead = await newLead();
    expect(lead.ownerId).toBe(id.e1);
    await available(['e1@sla.test', 'e2@sla.test', 'e3@sla.test']);
    const before = (await notes(id.e1, 'SLA_REMINDER', lead.id)).length;

    await at(plus(T0, 4));
    expect((await notes(id.e1, 'SLA_REMINDER', lead.id)).length).toBe(before);
    await at(plus(T0, 5));
    expect((await notes(id.e1, 'SLA_REMINDER', lead.id)).length).toBe(before + 1);
    expect((await sla(lead.id)).state).toBe('AT_RISK');
    await tick(); // idempotent: no duplicate reminder
    expect((await notes(id.e1, 'SLA_REMINDER', lead.id)).length).toBe(before + 1);

    await at(plus(T0, 15));
    expect((await notes(id.tl1, 'SLA_ALERT')).some((x) => x.link === `/leads/${lead.id}`)).toBe(
      true,
    );
    const breached = await sla(lead.id);
    expect(breached.state).toBe('BREACHED');
    expect(breached.breachedAt).toEqual(plus(T0, 15));

    await at(plus(T0, 30));
    const second = (await ctx.owner.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId!;
    expect([id.e2, id.e3]).toContain(second);
    expect((await firstTask(lead.id)).ownerId).toBe(second); // open task followed the lead
    expect((await sla(lead.id)).ownerId).toBe(second);

    await at(plus(T0, 60));
    const third = (await ctx.owner.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId!;
    expect([id.e2, id.e3].filter((x) => x !== second)).toEqual([third]); // no ping-pong
    const history = await ctx.owner.leadAssignment.findMany({
      where: { leadId: lead.id },
      orderBy: { attemptNo: 'asc' },
    });
    expect(history.map((h) => [h.attemptNo, h.type, h.fromUserId, h.toUserId])).toEqual([
      [1, 'AUTO', null, id.e1],
      [2, 'REASSIGN_AUTO', id.e1, second],
      [3, 'REASSIGN_AUTO', second, third],
    ]);

    await at(plus(T0, 90));
    const escalated = await sla(lead.id);
    expect(escalated.escalatedAt).toEqual(plus(T0, 90));
    expect((await notes(id.bm1, 'SLA_ESCALATED')).length).toBeGreaterThan(0);
    const overview = await get('bm1', `/sla/overview?brandId=${a.brands.B1}`);
    expect(overview.status).toBe(200);
    expect(overview.body.priorityQueue.map((r: { leadId: string }) => r.leadId)).toContain(lead.id);
    // Every trigger is recorded.
    const events = await ctx.owner.slaEvent.findMany({ where: { slaInstanceId: escalated.id } });
    expect(events.filter((e) => e.type === 'CHECKPOINT')).toHaveLength(5);
  });

  it('rolls over end of day and holidays; a calendar-basis checkpoint fires on the clock; both clocks are stored', async () => {
    const MON_1825 = new Date('2026-11-30T12:55:00Z'); // 18:25 IST, 5 working minutes left today
    await ctx.owner.holiday.create({
      data: {
        organizationId: a.orgId,
        brandId: a.brands.B1,
        date: new Date('2026-12-01'),
        name: 'Test holiday',
      },
    });
    const policy = await ctx.owner.slaPolicy.findUniqueOrThrow({ where: { brandId: a.brands.B1 } });
    await ctx.owner.slaCheckpoint.updateMany({
      where: { policyId: policy.id, position: 2 },
      data: { basis: 'CALENDAR' },
    });
    ctx.clock.set(MON_1825);
    await available(['e1@sla.test']);
    const lead = await newLead();
    const s = await sla(lead.id);
    const WED_0940 = new Date('2026-12-02T04:10:00Z'); // Tue is a holiday → Wed 09:30 + 10 min
    expect(s.dueAt).toEqual(WED_0940);
    const cp2 = await ctx.owner.job.findUniqueOrThrow({ where: { key: `sla:${s.id}:g0:cp2` } });
    expect(cp2.runAt).toEqual(plus(MON_1825, 15)); // calendar: 18:40 IST the same evening

    await at(plus(MON_1825, 15));
    expect(
      (await ctx.owner.slaEvent.findMany({ where: { slaInstanceId: s.id, type: 'ALERT_SENT' } }))
        .length,
    ).toBe(1);
    expect((await sla(lead.id)).state).toBe('AT_RISK');
    await at(new Date('2026-12-01T08:00:00Z')); // holiday: nothing breaches
    expect((await sla(lead.id)).state).toBe('AT_RISK');

    // First call on Wednesday 09:35 IST: 5 working minutes Monday + 5 on Wednesday.
    ctx.clock.set(new Date('2026-12-02T04:05:00Z'));
    const task = await firstTask(lead.id);
    const r = await post('e1', `/tasks/${task.id}/complete`, {
      outcome: 'CONNECTED',
      nextTask: { type: 'COUNSELLING', dueAt: '2026-12-03T06:00:00Z' },
    });
    expect(r.status).toBe(201);
    const done = await sla(lead.id);
    expect(done).toMatchObject({ state: 'RESOLVED', resolution: 'CONNECTED', workingMinutes: 10 });
    expect(done.calendarMinutes).toBe(39 * 60 + 10);
    expect(done.breachedAt).toBeNull();
    await ctx.owner.slaCheckpoint.updateMany({
      where: { policyId: policy.id, position: 2 },
      data: { basis: 'WORKING' },
    });
  });

  it('completing a call task resolves the SLA and stops the ladder; outcomes and the next action are enforced', async () => {
    const T0 = new Date('2026-12-02T05:30:00Z'); // Wed 11:00 IST
    ctx.clock.set(T0);
    await available(['e2@sla.test']);
    const lead = await newLead();
    expect(lead.ownerId).toBe(id.e2);
    const task = await firstTask(lead.id);
    ctx.clock.set(plus(T0, 7));
    expect((await post('e1', `/tasks/${task.id}/complete`, { outcome: 'NO_ANSWER' })).status).toBe(
      404,
    );
    const wrong = await post('e2', `/tasks/${task.id}/complete`, { outcome: 'MESSAGE_SENT' });
    expect(wrong.body.error.code).toBe('INVALID_OUTCOME');
    const noNext = await post('e2', `/tasks/${task.id}/complete`, { outcome: 'NO_ANSWER' });
    expect(noNext.body.error.code).toBe('NEXT_ACTION_REQUIRED');
    const ok = await post('e2', `/tasks/${task.id}/complete`, {
      outcome: 'NO_ANSWER',
      notes: 'Rang out',
      nextTask: { type: 'CALL_BACK', dueAt: plus(T0, 120).toISOString() },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.slaResolved).toBe(true);
    const s = await sla(lead.id);
    expect(s).toMatchObject({
      state: 'RESOLVED',
      resolution: 'NO_ANSWER',
      calendarMinutes: 7,
      workingMinutes: 7,
    });
    expect(
      await ctx.owner.job.count({
        where: { key: { startsWith: `sla:${s.id}:` }, status: 'PENDING' },
      }),
    ).toBe(0);
    await available(['e1@sla.test', 'e2@sla.test', 'e3@sla.test']);
    await at(plus(T0, 30));
    expect((await ctx.owner.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId).toBe(
      id.e2,
    );
    // Task due reminder for the call back, once.
    await at(plus(T0, 120));
    await tick();
    expect(
      (await notes(id.e2, 'TASK_DUE')).filter((x) => x.link === `/leads/${lead.id}`),
    ).toHaveLength(1);
    // Cancelling the last open task also needs a next action.
    const cb = await ctx.owner.task.findFirstOrThrow({
      where: { leadId: lead.id, status: 'OPEN' },
    });
    expect(
      (await post('e2', `/tasks/${cb.id}/cancel`, { reason: 'Duplicate' })).body.error.code,
    ).toBe('NEXT_ACTION_REQUIRED');
    const resch = await post('e2', `/tasks/${cb.id}/reschedule`, {
      dueAt: plus(T0, 240).toISOString(),
      reason: 'Asked to call later',
    });
    expect(resch.body.rescheduleCount).toBe(1);
  });

  it('no eligible executive at a reassignment checkpoint escalates and keeps the owner', async () => {
    const T0 = new Date('2026-12-03T05:30:00Z'); // Thu 11:00 IST
    ctx.clock.set(T0);
    await available(['e3@sla.test']);
    const lead = await newLead();
    expect(lead.ownerId).toBe(id.e3);
    await available([]);
    for (const m of [5, 15, 30]) await at(plus(T0, m));
    const s = await sla(lead.id);
    expect(s.escalatedAt).toEqual(plus(T0, 30));
    expect((await ctx.owner.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId).toBe(
      id.e3,
    );
    const failed = await ctx.owner.slaEvent.findFirst({
      where: { slaInstanceId: s.id, type: 'REASSIGN_FAILED' },
    });
    expect(failed).not.toBeNull();
  });

  it('stops at the maximum number of automatic reassignments', async () => {
    const policy = await ctx.owner.slaPolicy.update({
      where: { brandId: a.brands.B1 },
      data: { maxReassignAttempts: 1 },
    });
    const T0 = new Date('2026-12-03T07:30:00Z'); // Thu 13:00 IST
    ctx.clock.set(T0);
    await available(['e1@sla.test']);
    const lead = await newLead();
    await available(['e1@sla.test', 'e2@sla.test', 'e3@sla.test']);
    for (const m of [5, 15, 30, 60]) await at(plus(T0, m));
    const history = await ctx.owner.leadAssignment.findMany({ where: { leadId: lead.id } });
    expect(history.filter((h) => h.type === 'REASSIGN_AUTO')).toHaveLength(1);
    const s = await sla(lead.id);
    expect(s.escalatedAt).toEqual(plus(T0, 60));
    await ctx.owner.slaPolicy.update({
      where: { id: policy.id },
      data: { maxReassignAttempts: 3 },
    });
  });

  it('a hold pauses the clock and resume reschedules the remaining ladder', async () => {
    const T0 = new Date('2026-12-04T05:30:00Z'); // Fri 11:00 IST
    ctx.clock.set(T0);
    await available(['e1@sla.test']);
    const lead = await newLead();
    ctx.clock.set(plus(T0, 3));
    expect(
      (await post('e1', `/leads/${lead.id}/hold`, { reason: 'Student travelling' })).status,
    ).toBe(201);
    expect((await sla(lead.id)).state).toBe('PAUSED');
    const reminders = (await notes(id.e1, 'SLA_REMINDER', lead.id)).length;
    await at(plus(T0, 120));
    expect((await notes(id.e1, 'SLA_REMINDER', lead.id)).length).toBe(reminders);
    expect((await post('e1', `/leads/${lead.id}/resume`)).status).toBe(201);
    const s = await sla(lead.id);
    expect(s).toMatchObject({ state: 'PENDING', consumedWorkingMinutes: 3, generation: 1 });
    expect(s.dueAt).toEqual(plus(T0, 120 + 12));
    await at(plus(T0, 121));
    expect((await notes(id.e1, 'SLA_REMINDER', lead.id)).length).toBe(reminders);
    await at(plus(T0, 122));
    expect((await notes(id.e1, 'SLA_REMINDER', lead.id)).length).toBe(reminders + 1);
  });

  it('a manual reassignment restarts the clock for the new owner and moves open tasks', async () => {
    const T0 = new Date('2026-12-05T05:30:00Z'); // Sat 11:00 IST
    ctx.clock.set(T0);
    await available(['e1@sla.test']);
    const lead = await newLead();
    const old = await sla(lead.id);
    await available(['e1@sla.test', 'e2@sla.test']);
    ctx.clock.set(plus(T0, 10));
    expect(
      (await post('bm1', `/leads/${lead.id}/assign`, { userId: id.e2, reason: 'Speaks Tamil' }))
        .status,
    ).toBe(200);
    expect((await ctx.owner.slaInstance.findUniqueOrThrow({ where: { id: old.id } })).state).toBe(
      'CANCELLED',
    );
    const fresh = await sla(lead.id);
    expect(fresh).toMatchObject({ state: 'PENDING', ownerId: id.e2 });
    expect(fresh.startedAt).toEqual(plus(T0, 10));
    expect((await firstTask(lead.id)).ownerId).toBe(id.e2);
    expect(await ctx.owner.task.count({ where: { leadId: lead.id } })).toBe(1);
  });

  it('closing a lead (merge) cancels its SLA and open tasks', async () => {
    ctx.clock.set(new Date('2026-12-05T06:30:00Z'));
    await available(['e3@sla.test']);
    const lead = await newLead();
    await ctx.app
      .get(Db)
      .tenant(a.orgId, (tx) =>
        ctx.app
          .get(TaskCoreService)
          .closeLead(tx, lead.id, 'Merged into L-1', id.bm1, ctx.clock.now()),
      );
    expect((await sla(lead.id)).state).toBe('CANCELLED');
    expect((await firstTask(lead.id)).status).toBe('CANCELLED');
  });

  it('task lists are scoped: own tasks for executives, team view for leaders', async () => {
    expect((await get('e1', '/tasks?view=team')).status).toBe(403);
    const team = await get('tl1', '/tasks?view=team');
    expect(team.status).toBe(200);
    const owners = new Set(team.body.map((x: { ownerId: string }) => x.ownerId));
    expect([...owners].every((o) => [id.e1, id.e2, id.e3].includes(o as string))).toBe(true);
    const overdue = await get('e1', '/tasks?due=overdue');
    expect(overdue.body.every((x: { overdue: boolean }) => x.overdue)).toBe(true);
  });

  it('failing jobs retry with backoff, then dead-letter; operators can requeue them', async () => {
    const jobs = ctx.app.get(JobsService);
    let calls = 0;
    jobs.register('test.fail', async () => {
      calls++;
      throw new Error('provider down');
    });
    ctx.clock.set(new Date('2026-12-07T05:30:00Z'));
    await ctx.app.get(Db).tenant(a.orgId, (tx) =>
      jobs.enqueue(tx, {
        organizationId: a.orgId,
        type: 'test.fail',
        key: 'test:fail:1',
        payload: {},
        runAt: ctx.clock.now(),
        maxAttempts: 2,
      }),
    );
    await tick();
    let j = await ctx.owner.job.findUniqueOrThrow({ where: { key: 'test:fail:1' } });
    expect(j).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'provider down' });
    await tick(); // backoff not elapsed
    expect(calls).toBe(1);
    ctx.clock.advance(31_000);
    await tick();
    j = await ctx.owner.job.findUniqueOrThrow({ where: { key: 'test:fail:1' } });
    expect(j).toMatchObject({ status: 'DEAD', attempts: 2 });
    const list = await get('admin', '/ops/jobs?status=DEAD');
    expect(list.body.items.map((x: { key: string }) => x.key)).toContain('test:fail:1');
    expect((await get('e1', '/ops/jobs')).status).toBe(403);
    expect((await post('admin', `/ops/jobs/${j.id}/retry`)).body.requeued).toBe(1);
    expect((await ctx.owner.job.findUniqueOrThrow({ where: { id: j.id } })).status).toBe('PENDING');
  });

  it('the scheduler endpoint requires the cron secret', async () => {
    expect((await ctx.http().get('/api/v1/internal/tick')).status).toBe(401);
    expect(
      (await ctx.http().get('/api/v1/internal/tick').set('Authorization', 'Bearer wrong')).status,
    ).toBe(401);
    const ok = await ctx
      .http()
      .get('/api/v1/internal/tick')
      .set('Authorization', `Bearer ${TEST_ENV.CRON_SECRET}`);
    expect(ok.status).toBe(200);
    expect(ok.body.jobs).toBeDefined();
  });
});
