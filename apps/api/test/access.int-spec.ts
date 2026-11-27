import {
  bearer,
  createOrgFixture,
  createPlatformAdmin,
  createTestContext,
  createUser,
  OrgFixture,
  TestContext,
} from './helpers';

/**
 * Phase 2 exit gate: cross-organization and cross-brand isolation, role rules.
 * Out-of-scope reads by ID return 404 (indistinguishable from "does not exist").
 */
describe('Access control', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  let b: OrgFixture;
  const t: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'acc-a');
    b = await createOrgFixture(ctx.owner, 'acc-b');
    ids.adminA = await createUser(ctx.owner, a, 'admin@a.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    ids.adminB = await createUser(ctx.owner, b, 'admin@b.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    ids.bm1 = await createUser(ctx.owner, a, 'bm1@a.test', [
      { role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B1' },
    ]);
    ids.bm2 = await createUser(ctx.owner, a, 'bm2@a.test', [
      { role: 'BRAND_MANAGER', scope: 'BRAND', brand: 'B2' },
    ]);
    ids.exec1 = await createUser(ctx.owner, a, 'exec1@a.test', [
      { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' },
    ]);
    ids.exec2 = await createUser(ctx.owner, a, 'exec2@a.test', [
      { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B2' },
    ]);
    ids.tl1 = await createUser(ctx.owner, a, 'tl1@a.test', [
      { role: 'TEAM_LEADER', scope: 'TEAM', brand: 'B1' },
    ]);
    await createPlatformAdmin(ctx.owner, 'root@platform.test');
    for (const [k, email] of Object.entries({
      adminA: 'admin@a.test',
      adminB: 'admin@b.test',
      bm1: 'bm1@a.test',
      bm2: 'bm2@a.test',
      exec1: 'exec1@a.test',
      tl1: 'tl1@a.test',
      root: 'root@platform.test',
    }))
      t[k] = await bearer(ctx, email);
  });
  afterAll(() => ctx.close());

  const get = (who: string, url: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', t[who]);
  const post = (who: string, url: string, body: object) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', t[who]).send(body);
  const patch = (who: string, url: string, body: object) =>
    ctx.http().patch(`/api/v1${url}`).set('Authorization', t[who]).send(body);

  describe('cross-organization', () => {
    it('lists only own organization data', async () => {
      const res = await get('adminB', '/brands');
      expect(res.status).toBe(200);
      expect(res.body.map((x: { id: string }) => x.id).sort()).toEqual(
        Object.values(b.brands).sort(),
      );
      const users = await get('adminB', '/users');
      expect(users.body.items.map((u: { email: string }) => u.email)).toEqual(['admin@b.test']);
    });

    it('returns 404 for another organization’s IDs (read and write)', async () => {
      expect((await get('adminB', `/brands/${a.brands.B1}`)).status).toBe(404);
      expect((await get('adminB', `/teams/${a.teams.B1}`)).status).toBe(404);
      expect((await get('adminB', `/users/${ids.bm1}`)).status).toBe(404);
      expect((await patch('adminB', `/brands/${a.brands.B1}`, { name: 'pwned' })).status).toBe(404);
      expect((await patch('adminB', `/branches/${a.branches.B1}`, { name: 'pwned' })).status).toBe(
        404,
      );
      expect(
        (
          await post('adminB', `/users/${ids.bm1}/status`, {
            status: 'SUSPENDED',
            reason: 'cross-org',
          })
        ).status,
      ).toBe(404);
      const brand = await ctx.owner.brand.findUniqueOrThrow({ where: { id: a.brands.B1 } });
      expect(brand.name).toBe('Brand B1');
    });

    it('cannot attach another organization’s brand to its own records', async () => {
      const res = await post('adminB', '/teams', { brandId: a.brands.B1, name: 'Sneaky' });
      expect(res.status).toBe(404);
      const roleRes = await post('adminB', `/users/${ids.adminB}/role-assignments`, {
        roleId: a.roles.SALES_EXECUTIVE,
        scopeType: 'ORGANIZATION',
      });
      expect(roleRes.status).toBe(400);
    });
  });

  describe('cross-brand within one organization', () => {
    it('brand manager sees only their brand', async () => {
      const res = await get('bm1', '/brands');
      expect(res.body.map((x: { id: string }) => x.id)).toEqual([a.brands.B1]);
      expect((await get('bm1', `/brands/${a.brands.B2}`)).status).toBe(404);
      const branches = await get('bm1', '/branches');
      expect(branches.body.map((x: { id: string }) => x.id)).toEqual([a.branches.B1]);
      expect((await get('bm1', `/branches?brandId=${a.brands.B2}`)).status).toBe(404);
    });

    it('brand manager cannot see or modify the other brand’s teams and users', async () => {
      const teams = await get('bm1', '/teams');
      expect(teams.body.map((x: { id: string }) => x.id)).toEqual([a.teams.B1]);
      expect((await get('bm1', `/teams/${a.teams.B2}`)).status).toBe(404);
      expect((await patch('bm1', `/teams/${a.teams.B2}`, { name: 'x' })).status).toBe(404);
      expect((await patch('bm1', `/brands/${a.brands.B2}`, { name: 'x' })).status).toBe(404);
      expect(
        (
          await post('bm1', '/branches', {
            brandId: a.brands.B2,
            name: 'x',
            code: 'XX',
            country: 'AE',
          })
        ).status,
      ).toBe(404);
      expect((await get('bm1', `/users/${ids.exec2}`)).status).toBe(404);
      const users = await get('bm1', '/users');
      const emails = users.body.items.map((u: { email: string }) => u.email).sort();
      expect(emails).toEqual(['bm1@a.test', 'exec1@a.test', 'tl1@a.test']);
    });

    it('brand manager cannot create a brand (organization-level action)', async () => {
      const res = await post('bm1', '/brands', { name: 'New', code: 'NEW', country: 'IN' });
      expect(res.status).toBe(403);
    });

    it('brand manager can manage within their own brand', async () => {
      const br = await post('bm1', '/branches', {
        brandId: a.brands.B1,
        name: 'Calicut',
        code: 'CLT',
        country: 'IN',
      });
      expect(br.status).toBe(201);
      expect(br.body.timezone).toBe('Asia/Kolkata');
      const team = await post('bm1', '/teams', {
        brandId: a.brands.B1,
        branchId: br.body.id,
        name: 'Calicut Sales',
      });
      expect(team.status).toBe(201);
      const add = await post('bm1', `/teams/${team.body.id}/members`, { userId: ids.exec1 });
      expect(add.status).toBe(201);
    });

    it('sales executive and team leader have no admin write access', async () => {
      expect((await post('exec1', '/teams', { brandId: a.brands.B1, name: 'x' })).status).toBe(403);
      expect((await post('tl1', '/users', { name: 'x', email: 'x@a.test' })).status).toBe(403);
      expect((await get('exec1', '/users')).status).toBe(403);
      const teams = await get('tl1', '/teams');
      expect(teams.body.map((x: { id: string }) => x.id)).toEqual([a.teams.B1]);
    });
  });

  describe('role assignment rules', () => {
    it('brand manager cannot grant Organization Admin or grant into another brand', async () => {
      const toOrg = await post('bm1', `/users/${ids.exec1}/role-assignments`, {
        roleId: a.roles.ORG_ADMIN,
        scopeType: 'ORGANIZATION',
      });
      expect(toOrg.status).toBe(403);
      const orgAdminAtBrand = await post('bm1', `/users/${ids.exec1}/role-assignments`, {
        roleId: a.roles.ORG_ADMIN,
        scopeType: 'BRAND',
        brandId: a.brands.B1,
      });
      expect(orgAdminAtBrand.status).toBe(403);
      const otherBrand = await post('bm1', `/users/${ids.exec1}/role-assignments`, {
        roleId: a.roles.SALES_EXECUTIVE,
        scopeType: 'BRAND',
        brandId: a.brands.B2,
      });
      expect(otherBrand.status).toBe(403);
    });

    it('brand manager can grant a weaker role in their brand; it is audited and revocable with history', async () => {
      const res = await post('bm1', `/users/${ids.exec1}/role-assignments`, {
        roleId: a.roles.COUNSELLOR,
        scopeType: 'BRAND',
        brandId: a.brands.B1,
        reason: 'Covers counselling',
      });
      expect(res.status).toBe(201);
      const audit = await ctx.owner.auditLog.findFirst({
        where: { action: 'role.granted', entityId: res.body.id },
      });
      expect(audit?.actorUserId).toBe(ids.bm1);
      const rev = await post('bm1', `/role-assignments/${res.body.id}/revoke`, {
        reason: 'No longer needed',
      });
      expect(rev.status).toBe(200);
      const all = await get('bm1', `/users/${ids.exec1}/role-assignments?includeRevoked=true`);
      expect(all.body.find((x: { id: string }) => x.id === res.body.id).revokedAt).not.toBeNull();
    });

    it('brand manager cannot manage a user who also holds organization-level roles', async () => {
      const uid = await createUser(ctx.owner, a, 'dual@a.test', [
        { role: 'MANAGEMENT_VIEWER', scope: 'ORGANIZATION' },
        { role: 'SALES_EXECUTIVE', scope: 'BRAND', brand: 'B1' },
      ]);
      const res = await post('bm1', `/users/${uid}/status`, { status: 'SUSPENDED', reason: 'try' });
      expect(res.status).toBe(403);
    });

    it('brand manager must place new users inside their scope', async () => {
      const noScope = await post('bm1', '/users', { name: 'New Exec', email: 'new1@a.test' });
      expect(noScope.status).toBe(400);
      const ok = await post('bm1', '/users', {
        name: 'New Exec',
        email: 'new2@a.test',
        assignment: { roleId: a.roles.SALES_EXECUTIVE, scopeType: 'BRAND', brandId: a.brands.B1 },
      });
      expect(ok.status).toBe(201);
      expect(ok.body.status).toBe('INVITED');
      expect(ctx.mail.lastTokenFor('new2@a.test')).toBeTruthy();
      const outside = await post('bm1', '/users', {
        name: 'Other',
        email: 'new3@a.test',
        assignment: { roleId: a.roles.SALES_EXECUTIVE, scopeType: 'BRAND', brandId: a.brands.B2 },
      });
      expect(outside.status).toBe(403);
    });

    it('invited user activates by accepting the invite', async () => {
      const token = ctx.mail.lastTokenFor('new2@a.test');
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/auth/password/reset')
            .set('x-crm-client', 'web')
            .send({ token, newPassword: 'Invite-Accepted-1' })
        ).status,
      ).toBe(204);
      const login = await bearer(ctx, 'new2@a.test', 'Invite-Accepted-1');
      const brands = await ctx.http().get('/api/v1/brands').set('Authorization', login);
      expect(brands.body.map((x: { id: string }) => x.id)).toEqual([a.brands.B1]);
    });

    it('email addresses are unique across organizations', async () => {
      const res = await post('adminB', '/users', { name: 'Dup', email: 'bm1@a.test' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_IN_USE');
    });

    it('the last organization admin cannot be deactivated or lose the role', async () => {
      const assignments = await get('adminB', `/users/${ids.adminB}/role-assignments`);
      const rev = await post('adminB', `/role-assignments/${assignments.body[0].id}/revoke`, {
        reason: 'oops',
      });
      expect(rev.status).toBe(400);
      expect(rev.body.error.code).toBe('LAST_ORG_ADMIN');
      const self = await post('adminB', `/users/${ids.adminB}/status`, {
        status: 'DEACTIVATED',
        reason: 'oops',
      });
      expect(self.status).toBe(400);
    });

    it('custom roles cannot exceed the creator’s permissions; system roles are read-only', async () => {
      const ok = await post('adminA', '/roles', {
        key: 'JUNIOR_EXEC',
        name: 'Junior Executive',
        permissions: ['lead.read_own', 'brand.read'],
      });
      expect(ok.status).toBe(201);
      const sys = await patch('adminA', `/roles/${a.roles.SALES_EXECUTIVE}`, { name: 'Renamed' });
      expect(sys.status).toBe(400);
      expect(
        (await post('bm1', '/roles', { key: 'X', name: 'X', permissions: ['lead.read'] })).status,
      ).toBe(403);
    });
  });

  describe('platform administration', () => {
    it('platform admin creates an organization with system roles and an invited admin', async () => {
      const res = await post('root', '/platform/organizations', {
        name: 'Gulf Academy',
        slug: 'gulf-academy',
        country: 'AE',
        admin: { name: 'Gulf Admin', email: 'admin@gulf.test' },
      });
      expect(res.status).toBe(201);
      expect(res.body.organization.timezone).toBe('Asia/Dubai');
      expect(res.body.organization.currency).toBe('AED');
      const roles = await ctx.owner.role.count({
        where: { organizationId: res.body.organization.id, isSystem: true },
      });
      expect(roles).toBe(10);
      const token = ctx.mail.lastTokenFor('admin@gulf.test');
      await ctx
        .http()
        .post('/api/v1/auth/password/reset')
        .set('x-crm-client', 'web')
        .send({ token, newPassword: 'Gulf-Admin-Pass1' });
      const gulf = await bearer(ctx, 'admin@gulf.test', 'Gulf-Admin-Pass1');
      const me = await ctx.http().get('/api/v1/auth/me').set('Authorization', gulf);
      expect(me.body.organization.slug).toBe('gulf-academy');
    });

    it('platform admin cannot read organization business data; org users cannot use platform routes', async () => {
      expect((await get('root', '/brands')).status).toBe(403);
      expect((await get('root', '/users')).status).toBe(403);
      expect((await get('adminA', '/platform/organizations')).status).toBe(403);
    });

    it('suspending an organization ends its users’ sessions', async () => {
      const res = await post('root', `/platform/organizations/${b.orgId}/suspend`, {
        reason: 'Unpaid subscription',
      });
      expect(res.status).toBe(201);
      expect((await get('adminB', '/brands')).status).toBe(401);
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/auth/login')
            .set('x-crm-client', 'web')
            .send({ email: 'admin@b.test', password: 'Correct-Horse-9' })
        ).status,
      ).toBe(401);
    });
  });

  it('audit log is brand-scoped for brand managers', async () => {
    const mine = await get('bm1', '/audit-logs');
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.every((x: { brandId: string }) => x.brandId === a.brands.B1)).toBe(true);
  });
});
