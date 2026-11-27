import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

/** Phase 9 exit gate: invalid stage transitions are blocked; valid transitions are audited. */
describe('Pipeline and counselling', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  const t: Record<string, string> = {};
  const id: Record<string, string> = {};
  let intakeKey = '';
  let course = '';
  let course2 = '';
  let batch = '';
  const MON_11 = new Date('2026-11-30T05:30:00Z');

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const put = (who: string, url: string, body: object) =>
    ctx.http().put(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const del = (who: string, url: string) =>
    ctx.http().delete(`/api/v1${url}`).set('Authorization', t[who]);
  const move = (who: string, leadId: string, toStage: string, reason?: string) =>
    post(who, `/leads/${leadId}/stage-transitions`, { toStage, reason });
  let n = 0;
  const newLead = async (owner = 'e1') => {
    n++;
    const res = await ctx
      .http()
      .post('/api/v1/intake/leads')
      .set('Authorization', `Bearer ${intakeKey}`)
      .send({ name: `Pipe Student ${n}`, phone: `+91 93000 ${String(40000 + n).slice(-5)}` });
    expect(res.status).toBe(201);
    const e = await ctx.owner.enquiry.findUniqueOrThrow({ where: { id: res.body.reference } });
    expect(
      (await post('bm1', `/leads/${e.leadId}/assign`, { userId: id[owner], reason: 'Test' }))
        .status,
    ).toBe(200);
    return e.leadId;
  };
  const stage = async (leadId: string) =>
    (await ctx.owner.lead.findUniqueOrThrow({ where: { id: leadId } })).stage;
  const logCall = (leadId: string, outcome = 'CONNECTED') =>
    post('e1', `/leads/${leadId}/calls`, { startedAt: ctx.clock.now().toISOString(), outcome });
  const qualify = (leadId: string) =>
    put('e1', `/leads/${leadId}/qualification`, {
      highestQualification: 'B.Com',
      eligibilityNotes: 'Eligible — graduate',
      requirement: 'Wants a job in data analytics',
      interestLevel: 'HOT',
      preferredCourseIds: [course],
      intake: '2027-01',
    });

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'pipe-a');
    id.admin = await createUser(ctx.owner, a, 'admin@pipe.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    id.bm1 = await createUser(ctx.owner, a, 'bm1@pipe.test', [
      { role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B1' },
    ]);
    id.tl1 = await createUser(ctx.owner, a, 'tl1@pipe.test', [
      { role: 'TEAM_LEADER', scope: 'TEAM', brand: 'B1' },
    ]);
    for (const e of ['e1', 'e2'])
      id[e] = await createUser(ctx.owner, a, `${e}@pipe.test`, [
        { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' },
      ]);
    id.c1 = await createUser(ctx.owner, a, 'c1@pipe.test', [
      { role: 'COUNSELLOR', scope: 'TEAM', brand: 'B1' },
    ]);
    for (const k of ['admin', 'bm1', 'tl1', 'e1', 'e2', 'c1'])
      t[k] = await bearer(ctx, `${k}@pipe.test`);
    const src = await ctx.owner.leadSource.findFirstOrThrow({
      where: { brandId: a.brands.B1, channel: 'WEBSITE' },
    });
    ctx.clock.set(MON_11);
    intakeKey = (await post('admin', '/intake-keys', { sourceId: src.id, name: 'web' })).body.key;
    const mk = (code: string, fee: bigint | null) =>
      ctx.owner.course.create({
        data: {
          organizationId: a.orgId,
          brandId: a.brands.B1,
          code,
          name: `Course ${code}`,
          deliveryMode: 'HYBRID',
          listFeeMinor: fee,
          currency: 'INR',
        },
      });
    course = (await mk('DA', 12_000_000n)).id; // ₹1,20,000.00
    course2 = (await mk('FS', 9_000_000n)).id;
    batch = (
      await ctx.owner.batch.create({
        data: {
          organizationId: a.orgId,
          brandId: a.brands.B1,
          courseId: course,
          code: 'DA-JAN',
          name: 'January weekend',
          startDate: new Date('2027-01-09'),
          capacity: 30,
          status: 'OPEN',
        },
      })
    ).id;
  });
  afterAll(() => ctx.close());

  it('blocks moves whose required data is missing and lists what is missing', async () => {
    const lead = await newLead();
    const r = await move('e1', lead, 'CONTACTED');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('STAGE_REQUIREMENTS_MISSING');
    expect(r.body.error.details.missing).toEqual([
      { stage: 'CONTACTED', field: 'contactOutcome', label: 'Contact attempt and outcome' },
    ]);
    // Skipping ahead needs the data of every stage on the way.
    await logCall(lead, 'NO_ANSWER');
    const skip = await move('e1', lead, 'INTERESTED');
    expect(skip.body.error.details.missing.map((m: { field: string }) => m.field)).toEqual([
      'qualification',
      'eligibility',
      'requirement',
      'interestLevel',
      'coursePreference',
    ]);
    expect(await stage(lead)).toBe('NEW_ENQUIRY');
    expect(await ctx.owner.leadStageHistory.count({ where: { leadId: lead } })).toBe(0);
  });

  it('valid forward moves are recorded in append-only history, the audit log and the timeline', async () => {
    const lead = await newLead();
    await logCall(lead);
    const info = await get('e1', `/leads/${lead}/stage`);
    expect(info.body.fields.contactOutcome).toEqual({ ok: true, detail: 'Connected' });
    expect(info.body.stages.find((s: { key: string }) => s.key === 'CONTACTED').canEnter).toBe(
      true,
    );
    expect((await move('e1', lead, 'CONTACTED')).status).toBe(201);
    expect((await qualify(lead)).status).toBe(200);
    // Skipping QUALIFIED is allowed because its data is present.
    const r = await move('e1', lead, 'INTERESTED');
    expect(r.status).toBe(201);
    expect(r.body.stage).toBe('INTERESTED');
    const history = await ctx.owner.leadStageHistory.findMany({
      where: { leadId: lead },
      orderBy: { occurredAt: 'asc' },
    });
    expect(history.map((h) => [h.fromStage, h.toStage, h.direction, h.actorUserId])).toEqual([
      ['NEW_ENQUIRY', 'CONTACTED', 'FORWARD', id.e1],
      ['CONTACTED', 'INTERESTED', 'FORWARD', id.e1],
    ]);
    expect((history[1].snapshot as Record<string, boolean>).interestLevel).toBe(true);
    expect(
      await ctx.owner.auditLog.count({ where: { entityId: lead, action: 'lead.stage_changed' } }),
    ).toBe(2);
    const timeline = await get('e1', `/leads/${lead}/timeline`);
    expect(
      timeline.body.some(
        (x: { type: string; body: string }) =>
          x.type === 'STAGE_CHANGED' && x.body === 'Contacted → Interested',
      ),
    ).toBe(true);
    await expect(
      ctx.owner.$executeRawUnsafe(
        `UPDATE lead_stage_history SET to_stage = 'X' WHERE lead_id = '${lead}'`,
      ),
    ).rejects.toThrow();
    await expect(
      ctx.owner.$executeRawUnsafe(`DELETE FROM lead_stage_history WHERE lead_id = '${lead}'`),
    ).rejects.toThrow();
  });

  it('moving back needs a reason and a team leader or manager', async () => {
    const lead = await newLead();
    await logCall(lead);
    await move('e1', lead, 'CONTACTED');
    expect((await move('e1', lead, 'NEW_ENQUIRY', 'Wrong number')).status).toBe(403);
    expect((await move('tl1', lead, 'NEW_ENQUIRY')).body.error.code).toBe('REASON_REQUIRED');
    const ok = await move('tl1', lead, 'NEW_ENQUIRY', 'Logged on the wrong lead');
    expect(ok.status).toBe(201);
    const h = await ctx.owner.leadStageHistory.findFirstOrThrow({
      where: { leadId: lead, direction: 'BACKWARD' },
    });
    expect(h).toMatchObject({ actorUserId: id.tl1, reason: 'Logged on the wrong lead' });
  });

  it('Admission Confirmed is system-only; leads that are not open cannot move; out-of-scope leads are 404', async () => {
    const lead = await newLead();
    expect((await move('bm1', lead, 'ADMISSION_CONFIRMED')).body.error.code).toBe('SYSTEM_STAGE');
    await post('e1', `/leads/${lead}/hold`, { reason: 'Travelling' });
    await logCall(lead);
    expect((await move('e1', lead, 'CONTACTED')).body.error.code).toBe('LEAD_NOT_OPEN');
    expect((await move('e2', lead, 'CONTACTED')).status).toBe(404);
    expect((await get('e2', `/leads/${lead}/stage`)).status).toBe(404);
  });

  it('qualification changes are logged field by field and audited', async () => {
    const lead = await newLead();
    await qualify(lead);
    const again = await put('e1', `/leads/${lead}/qualification`, {
      interestLevel: 'WARM',
      objections: 'Fee is high',
    });
    expect(again.body).toMatchObject({
      interestLevel: 'WARM',
      objections: 'Fee is high',
      highestQualification: 'B.Com',
    });
    const events = await ctx.owner.leadEvent.findMany({
      where: { leadId: lead, type: 'QUALIFICATION_UPDATED' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events).toHaveLength(2);
    expect(events[1].body).toBe('Updated interest level, objections');
    expect((events[1].data as { changes: Record<string, unknown> }).changes.interestLevel).toEqual({
      from: 'HOT',
      to: 'WARM',
    });
    // No change → no event.
    await put('e1', `/leads/${lead}/qualification`, { interestLevel: 'WARM' });
    expect(
      await ctx.owner.leadEvent.count({ where: { leadId: lead, type: 'QUALIFICATION_UPDATED' } }),
    ).toBe(2);
    expect(
      (await put('e1', `/leads/${lead}/qualification`, { preferredCourseIds: [a.brands.B2] })).body
        .error.code,
    ).toBe('INVALID_COURSE');
  });

  it('a recorded counselling session satisfies the counselling stage and lets the counsellor see the lead', async () => {
    const lead = await newLead();
    await logCall(lead);
    await qualify(lead);
    expect((await get('c1', `/leads/${lead}`)).status).toBe(404);
    const rec = await post('e1', `/leads/${lead}/counselling`, {
      counsellorId: id.c1,
      heldAt: new Date(MON_11.getTime() - 3600_000).toISOString(),
      mode: 'IN_PERSON',
      summary: 'Walk-in: discussed weekend batch and fee options',
    });
    expect(rec.status).toBe(201);
    expect(rec.body.appointment.status).toBe('COMPLETED');
    expect((await get('c1', `/leads/${lead}`)).status).toBe(200);
    const r = await move('c1', lead, 'COUNSELLING_COMPLETED');
    expect(r.status).toBe(201);
    expect(r.body.fields.counsellingRemarks.ok).toBe(true);
  });

  it('quotations: list fee minus discount, discount rules, alternatives, acceptance and immutable terms', async () => {
    const lead = await newLead();
    expect(
      (await post('e1', `/leads/${lead}/quotations`, { courseId: course, discountMinor: 500_000 }))
        .body.error.code,
    ).toBe('DISCOUNT_REASON_REQUIRED');
    expect(
      (
        await post('e1', `/leads/${lead}/quotations`, {
          courseId: course,
          discountMinor: 2_000_000,
          discountReason: 'Scholarship',
        })
      ).status,
    ).toBe(403); // 16.7% > 10% needs a manager
    const q1 = await post('e1', `/leads/${lead}/quotations`, {
      courseId: course,
      batchId: batch,
      discountMinor: 600_000,
      discountReason: 'Early bird',
    });
    expect(q1.status).toBe(201);
    expect(q1.body).toMatchObject({
      number: 'Q-000001',
      listFeeMinor: 12_000_000,
      discountMinor: 600_000,
      totalMinor: 11_400_000,
      currency: 'INR',
      status: 'OPEN',
      validUntil: '2026-12-14T00:00:00.000Z',
    });
    const q2 = await post('bm1', `/leads/${lead}/quotations`, {
      courseId: course2,
      discountMinor: 2_000_000,
      discountReason: 'Alumni referral',
    });
    expect(q2.status).toBe(201);
    expect(
      (await post('e1', `/leads/${lead}/quotations`, { courseId: course2, batchId: batch })).body
        .error.code,
    ).toBe('INVALID_BATCH');
    expect((await post('e1', `/quotations/${q2.body.id}/reject`, {})).status).toBe(400);
    const acc = await post('e1', `/quotations/${q1.body.id}/accept`, {});
    expect(acc.body.status).toBe('ACCEPTED');
    const all = await get('e1', `/leads/${lead}/quotations`);
    expect(all.body.map((x: { number: string; status: string }) => [x.number, x.status])).toEqual([
      ['Q-000002', 'SUPERSEDED'],
      ['Q-000001', 'ACCEPTED'],
    ]);
    expect((await ctx.owner.lead.findUniqueOrThrow({ where: { id: lead } })).courseId).toBe(course);
    await expect(
      ctx.owner.quotation.update({ where: { id: q1.body.id }, data: { totalMinor: 1n } }),
    ).rejects.toThrow();
    // An accepted quotation satisfies course selection and payment-pending data.
    const info = await get('e1', `/leads/${lead}/stage`);
    for (const f of ['course', 'batch', 'feeQuote', 'amountDue', 'paymentStatus'])
      expect(info.body.fields[f].ok).toBe(true);
    expect(info.body.fields.amountDue.detail).toBe('11400000');
  });

  it('expired quotations cannot be accepted', async () => {
    const lead = await newLead();
    const q = await post('e1', `/leads/${lead}/quotations`, { courseId: course, validDays: 1 });
    ctx.clock.set(new Date('2026-12-02T05:30:00Z'));
    expect((await post('e1', `/quotations/${q.body.id}/accept`, {})).body.error.code).toBe(
      'QUOTATION_EXPIRED',
    );
    expect((await ctx.owner.quotation.findUniqueOrThrow({ where: { id: q.body.id } })).status).toBe(
      'EXPIRED',
    );
    ctx.clock.set(MON_11);
  });

  it('a lead goes all the way to Payment Pending once every stage has its data', async () => {
    const lead = await newLead();
    await logCall(lead);
    await qualify(lead);
    await post('e1', `/leads/${lead}/counselling`, {
      counsellorId: id.c1,
      heldAt: new Date(MON_11.getTime() - 600_000).toISOString(),
      mode: 'PHONE',
      summary: 'Confirmed January batch',
    });
    const q = await post('e1', `/leads/${lead}/quotations`, { courseId: course, batchId: batch });
    expect(
      (await move('e1', lead, 'PAYMENT_PENDING')).body.error.details.missing.map(
        (m: { field: string }) => m.field,
      ),
    ).toEqual(['amountDue', 'paymentStatus']);
    await post('e1', `/quotations/${q.body.id}/accept`, {});
    expect((await move('e1', lead, 'PAYMENT_PENDING')).status).toBe(201);
  });

  it('bulk move reports each lead; the board groups open leads by stage within scope', async () => {
    const ready = await newLead();
    await logCall(ready);
    const notReady = await newLead();
    const other = await newLead('e2');
    const r = await post('e1', '/leads/bulk-transition', {
      leadIds: [ready, notReady, other],
      toStage: 'CONTACTED',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ moved: 1, refused: 2 });
    expect(r.body.results.map((x: { ok: boolean; code?: string }) => x.code ?? 'OK')).toEqual([
      'OK',
      'STAGE_REQUIREMENTS_MISSING',
      'NOT_FOUND',
    ]);
    const board = await get('e1', `/pipeline?brandId=${a.brands.B1}&mine=true`);
    expect(board.status).toBe(200);
    const col = (k: string) => board.body.columns.find((c: { key: string }) => c.key === k);
    expect(board.body.columns).toHaveLength(8);
    expect(col('CONTACTED').leads.map((l: { id: string }) => l.id)).toContain(ready);
    expect(col('NEW_ENQUIRY').leads.map((l: { id: string }) => l.id)).toContain(notReady);
    expect(
      board.body.columns.flatMap((c: { leads: Array<{ id: string }> }) => c.leads.map((l) => l.id)),
    ).not.toContain(other);
    const card = col('CONTACTED').leads.find((l: { id: string }) => l.id === ready);
    expect(card).toMatchObject({ ownerName: 'e1', daysInStage: 0 });
    const list = await get('bm1', `/leads?stage=CONTACTED&ownerId=${id.e1}`);
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(ready);
  });

  it('saved views are private to their owner', async () => {
    const v = await post('e1', '/saved-views', {
      page: 'pipeline',
      name: 'My hot leads',
      filters: { mine: 'true' },
    });
    expect(v.status).toBe(201);
    expect(
      (await post('e1', '/saved-views', { page: 'pipeline', name: 'My hot leads', filters: {} }))
        .status,
    ).toBe(409);
    expect((await get('e2', '/saved-views')).body).toEqual([]);
    expect((await del('e2', `/saved-views/${v.body.id}`)).status).toBe(404);
    expect((await del('e1', `/saved-views/${v.body.id}`)).status).toBe(204);
  });
});
