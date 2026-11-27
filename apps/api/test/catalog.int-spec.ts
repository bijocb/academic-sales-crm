import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

/** Phase 3 exit gate: catalogue and operational rules are configurable, brand-scoped and audited. */
describe('Catalogue and brand settings', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  let b: OrgFixture;
  const t: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'cat-a');
    b = await createOrgFixture(ctx.owner, 'cat-b');
    await createUser(ctx.owner, a, 'admin@cat.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    await createUser(ctx.owner, a, 'bm1@cat.test', [
      { role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B1' },
    ]);
    await createUser(ctx.owner, a, 'exec1@cat.test', [
      { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' },
    ]);
    await createUser(ctx.owner, b, 'admin@catb.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    for (const [k, e] of Object.entries({
      admin: 'admin@cat.test',
      bm1: 'bm1@cat.test',
      exec1: 'exec1@cat.test',
      adminB: 'admin@catb.test',
    })) {
      t[k] = await bearer(ctx, e);
    }
  });
  afterAll(() => ctx.close());

  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const send = (m: 'post' | 'patch' | 'put' | 'delete', who: string, url: string, body?: object) =>
    ctx.http()[m](`/api/v1${url}`).set('Authorization', t[who]).send(body);

  describe('courses and batches', () => {
    let courseId: string;

    it('brand manager creates a category, course and batch in their brand; fee uses brand currency', async () => {
      const cat = await send('post', 'bm1', '/course-categories', {
        brandId: a.brands.B1,
        name: 'Data',
        code: 'DATA',
      });
      expect(cat.status).toBe(201);
      const course = await send('post', 'bm1', '/courses', {
        brandId: a.brands.B1,
        categoryId: cat.body.id,
        code: 'DS-101',
        name: 'Data Science',
        deliveryMode: 'HYBRID',
        durationValue: 6,
        durationUnit: 'MONTHS',
        listFeeMinor: 8_500_000,
      });
      expect(course.status).toBe(201);
      expect(course.body.currency).toBe('INR');
      expect(course.body.listFeeMinor).toBe(8_500_000);
      courseId = course.body.id;
      const batch = await send('post', 'bm1', '/batches', {
        courseId,
        branchId: a.branches.B1,
        code: 'JAN27',
        name: 'January 2027',
        startDate: '2027-01-11',
        endDate: '2027-07-10',
        capacity: 30,
      });
      expect(batch.status).toBe(201);
      expect(batch.body.status).toBe('PLANNED');
      const audit = await ctx.owner.auditLog.findFirst({
        where: { action: 'course.created', entityId: courseId },
      });
      expect(audit?.brandId).toBe(a.brands.B1);
    });

    it('validates batch dates, capacity, duration pairs and duplicate codes', async () => {
      const badDates = await send('post', 'bm1', '/batches', {
        courseId,
        code: 'X1',
        name: 'x',
        startDate: '2027-02-01',
        endDate: '2027-01-01',
        capacity: 10,
      });
      expect(badDates.status).toBe(400);
      const badCap = await send('post', 'bm1', '/batches', {
        courseId,
        code: 'X2',
        name: 'x',
        startDate: '2027-02-01',
        capacity: -1,
      });
      expect(badCap.status).toBe(400);
      const halfDuration = await send('post', 'bm1', '/courses', {
        brandId: a.brands.B1,
        code: 'HALF',
        name: 'x',
        deliveryMode: 'ONLINE',
        durationValue: 3,
      });
      expect(halfDuration.status).toBe(400);
      const dup = await send('post', 'bm1', '/courses', {
        brandId: a.brands.B1,
        code: 'DS-101',
        name: 'dup',
        deliveryMode: 'ONLINE',
      });
      expect(dup.status).toBe(409);
      const tooShort = await send(
        'patch',
        'bm1',
        `/batches/${(await get('bm1', `/batches?courseId=${courseId}`)).body[0].id}`,
        { endDate: '2026-01-01' },
      );
      expect(tooShort.status).toBe(400);
    });

    it('rejects branches and categories from another brand', async () => {
      const wrongBranch = await send('post', 'admin', '/batches', {
        courseId,
        branchId: a.branches.B2,
        code: 'X3',
        name: 'x',
        startDate: '2027-02-01',
        capacity: 5,
      });
      expect(wrongBranch.status).toBe(400);
      const otherCat = await send('post', 'admin', '/course-categories', {
        brandId: a.brands.B2,
        name: 'Other',
        code: 'OTH',
      });
      const wrongCat = await send('post', 'admin', '/courses', {
        brandId: a.brands.B1,
        categoryId: otherCat.body.id,
        code: 'WC',
        name: 'x',
        deliveryMode: 'ONLINE',
      });
      expect(wrongCat.status).toBe(400);
    });

    it('brand manager cannot see or change another brand’s catalogue', async () => {
      const other = await send('post', 'admin', '/courses', {
        brandId: a.brands.B2,
        code: 'AE-1',
        name: 'Dubai course',
        deliveryMode: 'OFFLINE',
      });
      expect(other.status).toBe(201);
      expect(other.body.currency).toBe('AED');
      expect((await get('bm1', `/courses/${other.body.id}`)).status).toBe(404);
      expect((await send('patch', 'bm1', `/courses/${other.body.id}`, { name: 'x' })).status).toBe(
        404,
      );
      expect(
        (
          await send('post', 'bm1', '/courses', {
            brandId: a.brands.B2,
            code: 'NOPE',
            name: 'x',
            deliveryMode: 'ONLINE',
          })
        ).status,
      ).toBe(404);
      const list = await get('bm1', '/courses');
      expect(
        list.body
          .map((c: { brandId: string }) => c.brandId)
          .every((id: string) => id === a.brands.B1),
      ).toBe(true);
    });

    it('sales executive can read the catalogue but not change it', async () => {
      expect((await get('exec1', '/courses')).status).toBe(200);
      expect(
        (
          await send('post', 'exec1', '/courses', {
            brandId: a.brands.B1,
            code: 'EX',
            name: 'x',
            deliveryMode: 'ONLINE',
          })
        ).status,
      ).toBe(403);
    });

    it('another organization cannot see the course at all', async () => {
      expect((await get('adminB', `/courses/${courseId}`)).status).toBe(404);
      const list = await get('adminB', '/courses');
      expect(list.body.find((c: { id: string }) => c.id === courseId)).toBeUndefined();
    });
  });

  describe('brand settings', () => {
    it('every brand starts with country defaults: India Mon–Sat, UAE Mon–Fri', async () => {
      const inHours = await get('admin', `/brands/${a.brands.B1}/working-hours`);
      expect(inHours.body.timezone).toBe('Asia/Kolkata');
      expect(new Set(inHours.body.shifts.map((s: { weekday: number }) => s.weekday))).toEqual(
        new Set([1, 2, 3, 4, 5, 6]),
      );
      const aeHours = await get('admin', `/brands/${a.brands.B2}/working-hours`);
      expect(new Set(aeHours.body.shifts.map((s: { weekday: number }) => s.weekday))).toEqual(
        new Set([1, 2, 3, 4, 5]),
      );
      const sla = await get('admin', `/brands/${a.brands.B1}/sla-policy`);
      expect(sla.body.checkpoints.map((c: { afterMinutes: number }) => c.afterMinutes)).toEqual([
        5, 15, 30, 60, 90,
      ]);
      const stages = await get('admin', `/brands/${a.brands.B1}/pipeline-stages`);
      expect(stages.body.map((s: { key: string }) => s.key)).toEqual([
        'NEW_ENQUIRY',
        'CONTACTED',
        'QUALIFIED',
        'INTERESTED',
        'COUNSELLING_COMPLETED',
        'COURSE_SELECTED',
        'PAYMENT_PENDING',
        'ADMISSION_CONFIRMED',
      ]);
    });

    it('a newly created brand gets defaults automatically', async () => {
      const res = await send('post', 'admin', '/brands', {
        name: 'Abu Dhabi',
        code: 'AUH',
        country: 'AE',
      });
      expect(res.status).toBe(201);
      const hours = await get('admin', `/brands/${res.body.id}/working-hours`);
      expect(hours.body.timezone).toBe('Asia/Dubai');
      expect(hours.body.shifts).toHaveLength(5);
    });

    it('working hours: validated, replaced as a whole and audited', async () => {
      const overlap = await send('put', 'bm1', `/brands/${a.brands.B1}/working-hours`, {
        shifts: [
          { weekday: 1, startMinute: 540, endMinute: 780 },
          { weekday: 1, startMinute: 700, endMinute: 1080 },
        ],
      });
      expect(overlap.status).toBe(400);
      const ok = await send('put', 'bm1', `/brands/${a.brands.B1}/working-hours`, {
        shifts: [1, 2, 3, 4, 5].flatMap((d) => [
          { weekday: d, startMinute: 540, endMinute: 780 },
          { weekday: d, startMinute: 840, endMinute: 1080 },
        ]),
      });
      expect(ok.status).toBe(200);
      expect((await get('bm1', `/brands/${a.brands.B1}/working-hours`)).body.shifts).toHaveLength(
        10,
      );
      expect(
        await ctx.owner.auditLog.count({
          where: { action: 'settings.working_hours_updated', brandId: a.brands.B1 },
        }),
      ).toBe(1);
    });

    it('preview shows calendar vs working due time, honouring holidays', async () => {
      await send('put', 'bm1', `/brands/${a.brands.B1}/working-hours`, {
        shifts: [1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, startMinute: 570, endMinute: 1110 })),
      });
      // Friday 27 Nov 2026, 22:00 IST
      const p1 = await get(
        'bm1',
        `/brands/${a.brands.B1}/calendar/preview?start=${encodeURIComponent('2026-11-27T22:00:00+05:30')}&minutes=15`,
      );
      expect(p1.status).toBe(200);
      expect(p1.body.arrivesInWorkingTime).toBe(false);
      expect(p1.body.calendarDue).toBe('2026-11-27T16:45:00.000Z');
      expect(p1.body.workingDue).toBe('2026-11-28T04:15:00.000Z'); // Saturday 09:45 IST

      expect(
        (
          await send('post', 'bm1', `/brands/${a.brands.B1}/holidays`, {
            date: '2026-11-28',
            name: 'Founders Day',
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await send('post', 'bm1', `/brands/${a.brands.B1}/holidays`, {
            date: '2026-11-28',
            name: 'dup',
          })
        ).status,
      ).toBe(409);
      const p2 = await get(
        'bm1',
        `/brands/${a.brands.B1}/calendar/preview?start=${encodeURIComponent('2026-11-27T22:00:00+05:30')}&minutes=15`,
      );
      expect(p2.body.workingDue).toBe('2026-11-30T04:15:00.000Z'); // Monday 09:45 IST
    });

    it('SLA policy: validated and replaceable', async () => {
      const unordered = await send('put', 'bm1', `/brands/${a.brands.B1}/sla-policy`, {
        firstResponseMinutes: 15,
        firstResponseBasis: 'WORKING',
        maxReassignAttempts: 3,
        reassignCooldownMinutes: 60,
        checkpoints: [
          { action: 'REMIND_OWNER', afterMinutes: 10, basis: 'WORKING' },
          { action: 'REASSIGN', afterMinutes: 5, basis: 'WORKING' },
        ],
      });
      expect(unordered.status).toBe(400);
      const tooManyReassigns = await send('put', 'bm1', `/brands/${a.brands.B1}/sla-policy`, {
        firstResponseMinutes: 15,
        firstResponseBasis: 'WORKING',
        maxReassignAttempts: 1,
        reassignCooldownMinutes: 60,
        checkpoints: [
          { action: 'REASSIGN', afterMinutes: 10, basis: 'WORKING' },
          { action: 'REASSIGN', afterMinutes: 20, basis: 'WORKING' },
        ],
      });
      expect(tooManyReassigns.status).toBe(400);
      const ok = await send('put', 'bm1', `/brands/${a.brands.B1}/sla-policy`, {
        firstResponseMinutes: 10,
        firstResponseBasis: 'CALENDAR',
        maxReassignAttempts: 2,
        reassignCooldownMinutes: 120,
        checkpoints: [
          { action: 'REMIND_OWNER', afterMinutes: 3, basis: 'CALENDAR' },
          { action: 'REASSIGN', afterMinutes: 20, basis: 'WORKING' },
          { action: 'ESCALATE_MANAGER', afterMinutes: 45, basis: 'WORKING' },
        ],
      });
      expect(ok.status).toBe(200);
      const after = await get('exec1', `/brands/${a.brands.B1}/sla-policy`);
      expect(after.body.firstResponseMinutes).toBe(10);
      expect(after.body.checkpoints.map((c: { action: string }) => c.action)).toEqual([
        'REMIND_OWNER',
        'REASSIGN',
        'ESCALATE_MANAGER',
      ]);
    });

    it('pipeline stage labels and required fields are editable; unknown fields rejected', async () => {
      const stages = await get('bm1', `/brands/${a.brands.B1}/pipeline-stages`);
      const qualified = stages.body.find((s: { key: string }) => s.key === 'QUALIFIED');
      expect(
        (
          await send('patch', 'bm1', `/pipeline-stages/${qualified.id}`, {
            requiredFields: ['not-a-field'],
          })
        ).status,
      ).toBe(400);
      const ok = await send('patch', 'bm1', `/pipeline-stages/${qualified.id}`, {
        label: 'Eligible',
        requiredFields: ['qualification'],
      });
      expect(ok.status).toBe(200);
      expect(ok.body.label).toBe('Eligible');
    });

    it('settings are brand-scoped: other brand 404, no settings.manage 403, other org 404', async () => {
      expect((await get('bm1', `/brands/${a.brands.B2}/working-hours`)).status).toBe(404);
      expect(
        (
          await send('put', 'bm1', `/brands/${a.brands.B2}/working-hours`, {
            shifts: [{ weekday: 1, startMinute: 0, endMinute: 60 }],
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await send('post', 'exec1', `/brands/${a.brands.B1}/holidays`, {
            date: '2026-12-25',
            name: 'x',
          })
        ).status,
      ).toBe(403);
      expect((await get('adminB', `/brands/${a.brands.B1}/sla-policy`)).status).toBe(404);
      const holiday = await ctx.owner.holiday.findFirstOrThrow({ where: { brandId: a.brands.B1 } });
      expect((await send('delete', 'adminB', `/holidays/${holiday.id}`)).status).toBe(404);
      expect((await send('delete', 'bm1', `/holidays/${holiday.id}`)).status).toBe(204);
    });
  });
});
