import { Db } from '../src/db/db.service';
import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

/** Phase 5 exit gate: duplicate and multi-enquiry scenarios. */
describe('Duplicates, merge and lead workspace', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  let b: OrgFixture;
  const t: Record<string, string> = {};
  const key: Record<string, string> = {};

  const post = (who: string, url: string, body: object = {}) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const patch = (who: string, url: string, body: object) =>
    ctx.http().patch(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const intake = (k: string, body: object) =>
    ctx.http().post('/api/v1/intake/leads').set('Authorization', `Bearer ${key[k]}`).send(body);
  const enquiryOf = (body: { body: { reference: string } }) =>
    ctx.owner.enquiry.findUniqueOrThrow({ where: { id: body.body.reference } });
  const personByPhone = (phone: string) =>
    ctx.owner.person.findFirstOrThrow({ where: { phoneE164: phone } });

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'dup-a');
    b = await createOrgFixture(ctx.owner, 'dup-b');
    await createUser(ctx.owner, a, 'admin@dup.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    await createUser(ctx.owner, a, 'bm1@dup.test', [
      { role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B1' },
    ]);
    await createUser(ctx.owner, a, 'exec1@dup.test', [
      { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' },
    ]);
    await createUser(ctx.owner, b, 'admin@dupb.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    for (const [k, e] of Object.entries({
      admin: 'admin@dup.test',
      bm1: 'bm1@dup.test',
      exec1: 'exec1@dup.test',
      adminB: 'admin@dupb.test',
    }))
      t[k] = await bearer(ctx, e);
    for (const [k, brand, channel] of [
      ['web1', a.brands.B1, 'WEBSITE'],
      ['google1', a.brands.B1, 'GOOGLE_ADS'],
      ['web2', a.brands.B2, 'WEBSITE'],
    ] as const) {
      const src = await ctx.owner.leadSource.findFirstOrThrow({
        where: { brandId: brand, channel },
      });
      key[k] = (await post('admin', '/intake-keys', { sourceId: src.id, name: k })).body.key;
    }
  });
  afterAll(() => ctx.close());

  describe('enquiry classification', () => {
    it('NEW_LEAD → EXISTING_PERSON (other brand) → CROSS_CHANNEL_DUPLICATE (<24h) → EXISTING_LEAD (next day)', async () => {
      const first = await intake('web1', {
        name: 'Neha Varma',
        phone: '9811100001',
        course: 'Data Science',
      });
      expect((await enquiryOf(first)).classification).toBe('NEW_LEAD');
      const otherBrand = await intake('web2', { name: 'Neha Varma', phone: '+919811100001' });
      expect(otherBrand.body.outcome).toBe('CREATED_LEAD');
      expect((await enquiryOf(otherBrand)).classification).toBe('EXISTING_PERSON');
      const google = await intake('google1', {
        name: 'Neha V',
        phone: '9811100001',
        externalId: 'g-1',
      });
      expect(google.body.outcome).toBe('ADDED_ENQUIRY');
      expect((await enquiryOf(google)).classification).toBe('CROSS_CHANNEL_DUPLICATE');
      ctx.clock.advance(25 * 3600_000);
      const later = await intake('web1', {
        name: 'Neha Varma',
        phone: '9811100001',
        course: 'Digital Marketing',
      });
      expect((await enquiryOf(later)).classification).toBe('EXISTING_LEAD');
    });

    it('several course enquiries by one person never raise a duplicate suggestion', async () => {
      const neha = await personByPhone('+919811100001');
      expect(
        await ctx.owner.duplicateCandidate.count({
          where: { OR: [{ personAId: neha.id }, { personBId: neha.id }] },
        }),
      ).toBe(0);
    });
  });

  describe('suggestions', () => {
    it('same name + phone typo is suggested; a common name alone is not', async () => {
      await intake('web1', { name: 'Rahul Kumar', phone: '9876543210', city: 'Kochi' });
      await intake('web1', { name: 'Kumar Rahul', phone: '9876543219', city: 'Kochi' });
      await intake('web1', { name: 'Rahul Kumar', phone: '9123456780', city: 'Kochi' });
      const list = await get('bm1', '/duplicates');
      expect(list.status).toBe(200);
      const rahuls = list.body.filter((c: { reasons: string[] }) =>
        c.reasons.includes('SAME_NAME'),
      );
      expect(rahuls).toHaveLength(1);
      expect(rahuls[0].reasons).toEqual(['PHONE_NEAR_MATCH', 'SAME_NAME', 'SAME_CITY']);
      expect(rahuls[0].score).toBe(0.9);
    });

    it('two people sharing an email (found by different phones) are suggested', async () => {
      await intake('web1', { name: 'Asha Menon', phone: '9000000011', email: 'asha@example.com' });
      await intake('web1', { name: 'A Menon', phone: '9000000099' });
      await intake('web1', {
        name: 'A Menon',
        phone: '9000000099',
        email: 'asha@example.com',
        message: 'second form',
      });
      const list = await get('bm1', '/duplicates');
      expect(list.body.some((c: { reasons: string[] }) => c.reasons.includes('SAME_EMAIL'))).toBe(
        true,
      );
    });

    it('sales executives cannot review duplicates; other organizations see none', async () => {
      expect((await get('exec1', '/duplicates')).status).toBe(403);
      expect((await get('adminB', '/duplicates')).body).toEqual([]);
    });
  });

  describe('merge', () => {
    let candidateId: string;
    let survivorSide: 'A' | 'B';
    let keepLeadId: string;
    let foldLeadId: string;

    it('preview explains exactly what will happen', async () => {
      const list = await get('bm1', '/duplicates');
      const c = list.body.find((x: { reasons: string[] }) =>
        x.reasons.includes('PHONE_NEAR_MATCH'),
      );
      candidateId = c.id;
      survivorSide = c.personA.phone === '+919876543210' ? 'A' : 'B';
      const prev = await get('bm1', `/duplicates/${candidateId}?survivor=${survivorSide}`);
      expect(prev.status).toBe(200);
      expect(prev.body.plan).toHaveLength(1);
      expect(prev.body.plan[0].action).toBe('MERGE_INTO_SURVIVOR_LEAD');
      keepLeadId = prev.body.plan[0].intoLeadId;
      foldLeadId = prev.body.plan[0].leadId;
      const keep = await ctx.owner.lead.findUniqueOrThrow({ where: { id: keepLeadId } });
      const fold = await ctx.owner.lead.findUniqueOrThrow({ where: { id: foldLeadId } });
      expect(keep.createdAt <= fold.createdAt).toBe(true); // older lead survives
    });

    it('merges people and leads without touching any enquiry', async () => {
      const enquiriesBefore = await ctx.owner.enquiry.findMany({
        where: { leadId: { in: [keepLeadId, foldLeadId] } },
        orderBy: { id: 'asc' },
      });
      const other = survivorSide === 'A' ? 'B' : 'A';
      const res = await post('bm1', `/duplicates/${candidateId}/merge`, {
        survivor: survivorSide,
        fields: { fullName: other, phone: survivorSide, email: survivorSide, city: survivorSide },
        note: 'Same student, typo in second form',
      });
      expect(res.status).toBe(200);
      const survivor = await ctx.owner.person.findUniqueOrThrow({
        where: { id: res.body.survivorId },
      });
      const merged = await ctx.owner.person.findUniqueOrThrow({ where: { id: res.body.mergedId } });
      expect(survivor.fullName).toBe('Kumar Rahul');
      expect(survivor.phoneE164).toBe('+919876543210');
      expect(merged.mergedIntoId).toBe(survivor.id);
      expect(merged.phoneE164).toBe('+919876543219'); // kept for history and matching

      const fold = await ctx.owner.lead.findUniqueOrThrow({ where: { id: foldLeadId } });
      const keep = await ctx.owner.lead.findUniqueOrThrow({ where: { id: keepLeadId } });
      expect(fold).toMatchObject({ status: 'MERGED', mergedIntoLeadId: keepLeadId });
      expect(keep.enquiryCount).toBe(2);
      const enquiriesAfter = await ctx.owner.enquiry.findMany({
        where: { leadId: { in: [keepLeadId, foldLeadId] } },
        orderBy: { id: 'asc' },
      });
      expect(enquiriesAfter).toEqual(enquiriesBefore);
      expect(await ctx.owner.personMerge.count({ where: { survivorId: survivor.id } })).toBe(1);
      expect(
        (await ctx.owner.duplicateCandidate.findUniqueOrThrow({ where: { id: candidateId } }))
          .status,
      ).toBe('MERGED');
    });

    it('the surviving lead shows the combined history; the merged lead points to it; lists hide merged leads', async () => {
      const detail = await get('bm1', `/leads/${keepLeadId}`);
      expect(detail.body.enquiries).toHaveLength(2);
      expect(detail.body.mergedLeads.map((l: { id: string }) => l.id)).toEqual([foldLeadId]);
      const folded = await get('bm1', `/leads/${foldLeadId}`);
      expect(folded.body.mergedInto.id).toBe(keepLeadId);
      const list = await get('bm1', '/leads?pageSize=200');
      expect(list.body.items.map((l: { id: string }) => l.id)).not.toContain(foldLeadId);
      const timeline = await get('bm1', `/leads/${keepLeadId}/timeline`);
      expect(timeline.body.map((i: { type: string }) => i.type)).toEqual(
        expect.arrayContaining(['LEAD_MERGED', 'ENQUIRY']),
      );
    });

    it("a later enquiry from the merged person's old number goes to the survivor", async () => {
      const people = await ctx.owner.person.count();
      const res = await intake('web1', {
        name: 'Rahul K',
        phone: '9876543219',
        message: 'calling again',
      });
      expect(res.body.outcome).toBe('ADDED_ENQUIRY');
      expect((await enquiryOf(res)).leadId).toBe(keepLeadId);
      expect(await ctx.owner.person.count()).toBe(people);
    });

    it('cannot merge the same suggestion twice', async () => {
      const again = await post('bm1', `/duplicates/${candidateId}/merge`, {
        survivor: 'A',
        fields: { fullName: 'A', phone: 'A', email: 'A', city: 'A' },
      });
      expect(again.status).toBe(400);
    });

    it('a pair spanning two brands needs merge rights in both; the other brand lead moves to the survivor', async () => {
      await intake('web1', { name: 'Omar Haddad', phone: '9700000001', email: 'omar@example.ae' });
      await intake('web2', { name: 'Omar H', phone: '+971501110000', email: 'omar@example.ae' }); // email match → same person
      // Different email holder via phone in brand 2:
      await intake('web2', { name: 'Omar Haddad', phone: '+971502220000' });
      await intake('web2', {
        name: 'Omar Haddad',
        phone: '+971502220000',
        email: 'omar@example.ae',
        message: 'again',
      });
      const all = await get('admin', '/duplicates');
      const c = all.body.find(
        (x: { personA: { fullName: string }; reasons: string[] }) =>
          x.reasons.includes('SAME_EMAIL') && x.personA.fullName.startsWith('Omar'),
      );
      expect(c).toBeDefined();
      expect(
        (await get('bm1', '/duplicates')).body.find((x: { id: string }) => x.id === c.id),
      ).toBeUndefined();
      expect(
        (
          await post('bm1', `/duplicates/${c.id}/merge`, {
            survivor: 'A',
            fields: { fullName: 'A', phone: 'A', email: 'A', city: 'A' },
          })
        ).status,
      ).toBe(404);
      const res = await post('admin', `/duplicates/${c.id}/merge`, {
        survivor: 'A',
        fields: { fullName: 'A', phone: 'A', email: 'A', city: 'A' },
      });
      expect(res.status).toBe(200);
      const leads = await ctx.owner.lead.findMany({
        where: { personId: res.body.survivorId, status: { not: 'MERGED' } },
      });
      expect(new Set(leads.map((l) => l.brandId))).toEqual(new Set([a.brands.B1, a.brands.B2]));
    });
  });

  describe('dismissal', () => {
    it('a dismissed pair is never raised again', async () => {
      const c = (await get('bm1', '/duplicates')).body.find((x: { reasons: string[] }) =>
        x.reasons.includes('SAME_EMAIL'),
      );
      expect(
        (await post('bm1', `/duplicates/${c.id}/dismiss`, { note: 'Siblings sharing an email' }))
          .status,
      ).toBe(200);
      await intake('web1', { name: 'A Menon', phone: '9000000099', city: 'Kochi' }); // contact change re-runs detection
      expect((await post('admin', '/duplicates/scan')).status).toBe(200);
      const after = await ctx.owner.duplicateCandidate.findUniqueOrThrow({ where: { id: c.id } });
      expect(after.status).toBe('DISMISSED');
      expect(
        (await get('bm1', '/duplicates')).body.find((x: { id: string }) => x.id === c.id),
      ).toBeUndefined();
    });
  });

  describe('lead workspace', () => {
    let leadId: string;
    beforeAll(async () => {
      leadId = (
        await ctx.owner.lead.findFirstOrThrow({
          where: { person: { phoneE164: '+919811100001' }, brandId: a.brands.B1 },
        })
      ).id;
    });

    it('notes and profile edits appear in the timeline with the author', async () => {
      expect(
        (await post('bm1', `/leads/${leadId}/notes`, { body: 'Prefers evening calls' })).status,
      ).toBe(201);
      expect(
        (
          await patch('bm1', `/leads/${leadId}/profile`, {
            fullName: 'Neha S Varma',
            city: 'Kochi',
          })
        ).status,
      ).toBe(200);
      const timeline = await get('bm1', `/leads/${leadId}/timeline`);
      const note = timeline.body.find((i: { type: string }) => i.type === 'NOTE');
      expect(note).toMatchObject({ body: 'Prefers evening calls', actor: 'bm1' });
      expect(
        timeline.body.find((i: { type: string }) => i.type === 'PROFILE_UPDATED').body,
      ).toContain('fullName');
      expect(timeline.body.filter((i: { type: string }) => i.type === 'ENQUIRY')).toHaveLength(3);
    });

    it("changing a phone to another person's number is refused and raises a suggestion", async () => {
      const res = await patch('bm1', `/leads/${leadId}/profile`, { phone: '9123456780' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PHONE_BELONGS_TO_OTHER_PERSON');
      const neha = await personByPhone('+919811100001');
      expect(
        await ctx.owner.duplicateCandidate.count({
          where: {
            reasons: { has: 'SAME_PHONE' },
            OR: [{ personAId: neha.id }, { personBId: neha.id }],
          },
        }),
      ).toBe(1);
    });

    it('validates profile edits and requires some contact detail', async () => {
      expect((await patch('bm1', `/leads/${leadId}/profile`, { email: 'nope' })).status).toBe(400);
      expect(
        (await patch('bm1', `/leads/${leadId}/profile`, { phone: null, email: null })).status,
      ).toBe(400);
    });

    it('timeline history is append-only and scoped', async () => {
      await expect(
        ctx.app.get(Db).tenant(a.orgId, (tx) => tx.leadEvent.updateMany({ data: { body: 'x' } })),
      ).rejects.toThrow();
      expect((await post('exec1', `/leads/${leadId}/notes`, { body: 'x' })).status).toBe(404);
      expect((await get('adminB', `/leads/${leadId}/timeline`)).status).toBe(404);
    });
  });
});
