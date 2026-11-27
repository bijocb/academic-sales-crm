import { Db } from '../src/db/db.service';
import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

/** Phase 6 exit gate: deterministic allocation and no-eligible-user handling. */
describe('Lead allocation', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  const key: Record<string, string> = {};
  // Monday 30 Nov 2026, 11:00 IST — inside the India brand's default working hours.
  const MONDAY_11_IST = new Date('2026-11-30T05:30:00Z');
  const SUNDAY_11_IST = new Date('2026-11-29T05:30:00Z');

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const put = (who: string, url: string, body: object) =>
    ctx.http().put(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  let n = 0;
  const newLead = async (k = 'b1', extra: object = {}) => {
    n++;
    const res = await ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${key[k]}`)
      .send({ name: `Student ${n}`, phone: `+91 97000 ${String(10000 + n).slice(-5)}`, ...extra });
    expect(res.status).toBe(201);
    const e = await ctx.owner.enquiry.findUniqueOrThrow({
      where: { id: res.body.reference },
      include: { lead: true },
    });
    return e.lead;
  };
  const owner = async (leadId: string) =>
    (await ctx.owner.lead.findUniqueOrThrow({ where: { id: leadId } })).ownerId;
  const setUser = (email: string, data: object) =>
    ctx.owner.user.update({ where: { email }, data });

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'alloc-a', { autoAllocate: true });
    id.admin = await createUser(ctx.owner, a, 'admin@alloc.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    id.bm1 = await createUser(ctx.owner, a, 'bm1@alloc.test', [
      { role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B1' },
    ]);
    id.tl1 = await createUser(ctx.owner, a, 'tl1@alloc.test', [
      { role: 'TEAM_LEADER', scope: 'TEAM', brand: 'B1' },
    ]);
    for (const e of ['e1', 'e2', 'e3'])
      id[e] = await createUser(ctx.owner, a, `${e}@alloc.test`, [
        { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' },
      ]);
    id.eB2 = await createUser(ctx.owner, a, 'eb2@alloc.test', [
      { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B2' },
    ]);
    for (const k of ['admin', 'bm1', 'tl1', 'e1', 'e2', 'e3', 'eB2'])
      t[k] = await bearer(ctx, `${k.toLowerCase()}@alloc.test`);
    for (const [k, brand] of [
      ['b1', a.brands.B1],
      ['b2', a.brands.B2],
    ] as const) {
      const src = await ctx.owner.leadSource.findFirstOrThrow({
        where: { brandId: brand, channel: 'WEBSITE' },
      });
      key[k] = (await post('admin', '/intake-keys', { sourceId: src.id, name: k })).body.key;
    }
    // Start with e3 switched off so the first scenarios involve exactly two executives.
    await setUser('e3@alloc.test', { isAvailable: false });
    ctx.clock.set(MONDAY_11_IST);
  });
  afterAll(() => ctx.close());

  it('new leads are spread evenly and deterministically; managers and admins never receive leads', async () => {
    const owners = [];
    for (let i = 0; i < 4; i++) {
      owners.push(await owner((await newLead()).id));
      ctx.clock.advance(60_000);
    }
    const [first, second] = [id.e1, id.e2].sort(); // equal load, never assigned → lowest id first
    expect(owners).toEqual([first, second, first, second]);
    const runs = await ctx.owner.allocationRun.findMany({
      where: { brandId: a.brands.B1 },
      orderBy: { createdAt: 'asc' },
    });
    expect(runs.map((r) => r.outcome)).toEqual(['ASSIGNED', 'ASSIGNED', 'ASSIGNED', 'ASSIGNED']);
    const considered = (runs[0].candidates as Array<{ userId: string }>)
      .map((c) => c.userId)
      .sort();
    expect(considered).toEqual([id.e1, id.e2, id.e3].sort()); // admin, bm1, tl1 are not in the pool
  });

  it('a brand only allocates to its own executives', async () => {
    const lead = await newLead('b2');
    expect(await owner(lead.id)).toBe(id.eB2);
  });

  it('capacity: an executive at their limit is skipped, with the reason recorded', async () => {
    const e1Load = await ctx.owner.lead.count({ where: { ownerId: id.e1, status: 'OPEN' } });
    await setUser('e1@alloc.test', { maxActiveLeads: e1Load });
    const l1 = await newLead();
    const l2 = await newLead();
    expect([await owner(l1.id), await owner(l2.id)]).toEqual([id.e2, id.e2]);
    const run = await ctx.owner.allocationRun.findFirstOrThrow({ where: { leadId: l2.id } });
    expect(
      (run.candidates as Array<{ userId: string; excluded: string[] }>).find(
        (c) => c.userId === id.e1,
      )!.excluded,
    ).toEqual(['AT_CAPACITY']);
    await setUser('e1@alloc.test', { maxActiveLeads: null });
  });

  it('availability toggle and leave remove an executive from the pool', async () => {
    expect((await put('e3', '/me/availability', { isAvailable: true })).body.isAvailable).toBe(
      true,
    );
    expect((await put('e2', '/me/availability', { isAvailable: false })).body.isAvailable).toBe(
      false,
    );
    expect(
      (
        await post('bm1', `/users/${id.e1}/leaves`, {
          startDate: '2026-11-30',
          endDate: '2026-12-01',
          reason: 'Family function',
        })
      ).status,
    ).toBe(201);
    const lead = await newLead();
    expect(await owner(lead.id)).toBe(id.e3);
    const run = await ctx.owner.allocationRun.findFirstOrThrow({ where: { leadId: lead.id } });
    const why = Object.fromEntries(
      (run.candidates as Array<{ userId: string; excluded: string[] }>).map((c) => [
        c.userId,
        c.excluded,
      ]),
    );
    expect(why[id.e1]).toEqual(['ON_LEAVE']);
    expect(why[id.e2]).toEqual(['UNAVAILABLE']);
    const leave = (await get('e1', `/users/${id.e1}/leaves`)).body[0];
    expect(
      (await ctx.http().delete(`/api/v1/leaves/${leave.id}`).set('Authorization', t.e1)).status,
    ).toBe(204);
    await put('e2', '/me/availability', { isAvailable: true });
  });

  it('language: only executives who speak the lead’s language (or list none) are eligible', async () => {
    await setUser('e1@alloc.test', { languages: ['ml', 'en'] });
    await setUser('e2@alloc.test', { languages: ['hi'] });
    await setUser('e3@alloc.test', { languages: ['ar'] });
    const lead = await newLead('b1', { language: 'ml' });
    expect(await owner(lead.id)).toBe(id.e1);
    for (const e of ['e1', 'e2', 'e3']) await setUser(`${e}@alloc.test`, { languages: [] });
  });

  it('rules: the first matching rule decides the pool, and every change bumps the rule version', async () => {
    const course = await ctx.owner.course.create({
      data: {
        organizationId: a.orgId,
        brandId: a.brands.B1,
        code: 'DS',
        name: 'Data Science',
        deliveryMode: 'ONLINE',
        currency: 'INR',
      },
    });
    const v0 = (await get('bm1', `/allocation/settings?brandId=${a.brands.B1}`)).body.ruleVersion;
    const rule = await post('bm1', '/allocation/rules', {
      brandId: a.brands.B1,
      name: 'Data Science specialist',
      courseIds: [course.id],
      userIds: [id.e2],
    });
    expect(rule.status).toBe(201);
    expect((await get('bm1', `/allocation/settings?brandId=${a.brands.B1}`)).body.ruleVersion).toBe(
      v0 + 1,
    );
    const ds = await newLead('b1', { courseCode: 'DS' });
    expect(await owner(ds.id)).toBe(id.e2);
    const run = await ctx.owner.allocationRun.findFirstOrThrow({ where: { leadId: ds.id } });
    expect(run).toMatchObject({ ruleId: rule.body.id, ruleVersion: v0 + 1 });
    const badPool = await post('bm1', '/allocation/rules', {
      brandId: a.brands.B1,
      name: 'Empty',
      courseIds: [],
    });
    expect(badPool.status).toBe(400);
    expect(
      (await post('e1', '/allocation/rules', { brandId: a.brands.B1, name: 'x', userIds: [id.e1] }))
        .status,
    ).toBe(403);
  });

  it('nobody eligible: the lead waits in the queue, managers are told once, and it is allocated later', async () => {
    for (const e of ['e1', 'e2', 'e3']) await put(e, '/me/availability', { isAvailable: false });
    const lead = await newLead();
    expect(await owner(lead.id)).toBeNull();
    const run = await ctx.owner.allocationRun.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(run.outcome).toBe('NO_ELIGIBLE_USER');
    const queue = await get('bm1', `/allocation/queue?brandId=${a.brands.B1}`);
    expect(queue.body.map((q: { id: string }) => q.id)).toContain(lead.id);
    await post('bm1', `/leads/${lead.id}/allocate`); // still nobody: no duplicate notification
    const notes = await ctx.owner.notification.findMany({
      where: { userId: id.bm1, type: 'LEAD_UNASSIGNED' },
    });
    expect(notes).toHaveLength(1);
    expect(
      await ctx.owner.notification.count({ where: { userId: id.admin, type: 'LEAD_UNASSIGNED' } }),
    ).toBe(1);
    expect(
      await ctx.owner.notification.count({ where: { userId: id.tl1, type: 'LEAD_UNASSIGNED' } }),
    ).toBe(0);

    await put('e3', '/me/availability', { isAvailable: true });
    const drained = await post('bm1', `/allocation/queue/allocate?brandId=${a.brands.B1}`);
    expect(drained.body).toMatchObject({ assigned: 1, stillQueued: 0 });
    expect(await owner(lead.id)).toBe(id.e3);
  });

  it('outside working hours leads are queued and allocated when the brand opens', async () => {
    ctx.clock.set(SUNDAY_11_IST);
    const lead = await newLead();
    expect(await owner(lead.id)).toBeNull();
    expect(
      (await ctx.owner.allocationRun.findFirstOrThrow({ where: { leadId: lead.id } })).outcome,
    ).toBe('OUTSIDE_WORKING_HOURS');
    expect(
      (await post('bm1', `/allocation/queue/allocate?brandId=${a.brands.B1}`)).body.stillQueued,
    ).toBe(1);
    ctx.clock.set(new Date(MONDAY_11_IST.getTime() + 3600_000));
    expect(
      (await post('bm1', `/allocation/queue/allocate?brandId=${a.brands.B1}`)).body.assigned,
    ).toBe(1);
    expect(await owner(lead.id)).not.toBeNull();
  });

  it('allocation is idempotent: an owned lead is never re-allocated by the engine', async () => {
    const lead = await ctx.owner.lead.findFirstOrThrow({
      where: { brandId: a.brands.B1, ownerId: { not: null } },
    });
    const before = await ctx.owner.leadAssignment.count({ where: { leadId: lead.id } });
    const res = await post('bm1', `/leads/${lead.id}/allocate`);
    expect(res.body.outcome).toBe('ALREADY_ASSIGNED');
    expect(await ctx.owner.leadAssignment.count({ where: { leadId: lead.id } })).toBe(before);
  });

  describe('manual assignment', () => {
    let leadId: string;
    beforeAll(async () => {
      await put('e1', '/me/availability', { isAvailable: true });
      await put('e2', '/me/availability', { isAvailable: true });
      leadId = (
        await ctx.owner.lead.findFirstOrThrow({ where: { ownerId: id.e3, brandId: a.brands.B1 } })
      ).id;
    });

    it('a manager reassigns with a reason; history keeps both owners; both are notified', async () => {
      expect(
        (await post('bm1', `/leads/${leadId}/assign`, { userId: id.e1, reason: 'x' })).status,
      ).toBe(400);
      const res = await post('bm1', `/leads/${leadId}/assign`, {
        userId: id.e1,
        reason: 'Speaks the student’s language',
      });
      expect(res.status).toBe(200);
      const history = await get('bm1', `/leads/${leadId}/assignments`);
      expect(
        history.body.map((h: { toUserId: string; type: string }) => [h.toUserId, h.type]),
      ).toEqual([
        [id.e1, 'MANUAL'],
        [id.e3, 'AUTO'],
      ]);
      expect(history.body[0]).toMatchObject({ fromUserId: id.e3, attemptNo: 2, byName: 'bm1' });
      expect(
        await ctx.owner.notification.count({
          where: { userId: id.e3, type: 'LEAD_REASSIGNED_AWAY' },
        }),
      ).toBe(1);
      const mine = await get('e1', '/notifications?unread=true');
      expect(
        mine.body.items.some(
          (x: { type: string; link: string }) =>
            x.type === 'LEAD_ASSIGNED' && x.link === `/leads/${leadId}`,
        ),
      ).toBe(true);
      expect((await post('e1', '/notifications/read')).body.updated).toBeGreaterThan(0);
      expect((await get('e1', '/notifications?unread=true')).body.unread).toBe(0);
    });

    it('only lead recipients in the brand can be chosen; executives cannot assign', async () => {
      expect(
        (
          await post('bm1', `/leads/${leadId}/assign`, {
            userId: id.tl1,
            reason: 'Team leader takes it',
          })
        ).body.error.code,
      ).toBe('NOT_ELIGIBLE');
      expect(
        (await post('bm1', `/leads/${leadId}/assign`, { userId: id.eB2, reason: 'Other brand' }))
          .body.error.code,
      ).toBe('NOT_ELIGIBLE');
      expect(
        (await post('e1', `/leads/${leadId}/assign`, { userId: id.e2, reason: 'Swap please' }))
          .status,
      ).toBe(403);
    });

    it('a team leader reassigns within the team and sees the team’s leads', async () => {
      const res = await post('tl1', `/leads/${leadId}/assign`, {
        userId: id.e2,
        reason: 'Balancing the team load',
      });
      expect(res.status).toBe(200);
      const teamLeads = await get('tl1', '/leads?pageSize=200');
      expect(teamLeads.body.items.length).toBeGreaterThan(0);
      expect(
        teamLeads.body.items.every((l: { brandId: string }) => l.brandId === a.brands.B1),
      ).toBe(true);
    });

    it('executives see the leads they own', async () => {
      const mine = await get('e2', '/leads?pageSize=200');
      expect(mine.body.items.map((l: { id: string }) => l.id)).toContain(leadId);
    });

    it('ownership history cannot be rewritten', async () => {
      await expect(
        ctx.app
          .get(Db)
          .tenant(a.orgId, (tx) => tx.leadAssignment.updateMany({ data: { reason: 'x' } })),
      ).rejects.toThrow();
      await expect(
        ctx.app.get(Db).tenant(a.orgId, (tx) => tx.allocationRun.deleteMany({})),
      ).rejects.toThrow();
    });
  });

  it('allocation screens are brand-scoped', async () => {
    expect((await get('bm1', `/allocation/queue?brandId=${a.brands.B2}`)).status).toBe(404);
    expect((await get('e1', `/allocation/queue?brandId=${a.brands.B1}`)).status).toBe(404);
    const execs = await get('bm1', `/allocation/executives?brandId=${a.brands.B1}`);
    expect(execs.body.map((e: { userId: string }) => e.userId).sort()).toEqual(
      [id.e1, id.e2, id.e3].sort(),
    );
  });
});
