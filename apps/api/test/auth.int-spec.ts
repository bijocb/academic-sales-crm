import {
  bearer,
  createOrgFixture,
  createTestContext,
  createUser,
  OrgFixture,
  PASSWORD,
  TestContext,
} from './helpers';

const H = { 'x-crm-client': 'web' };

function cookiesOf(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  return Object.fromEntries(
    raw.map((c) => c.split(';')[0].split('=')).map(([k, ...v]) => [k, v.join('=')]),
  );
}

describe('Authentication', () => {
  let ctx: TestContext;
  let fx: OrgFixture;

  beforeAll(async () => {
    ctx = await createTestContext();
    fx = await createOrgFixture(ctx.owner, 'auth');
    await createUser(ctx.owner, fx, 'admin@auth.test', [
      { role: 'ORG_ADMIN', scope: 'ORGANIZATION' },
    ]);
    await createUser(ctx.owner, fx, 'exec@auth.test', [
      { role: 'SALES_EXECUTIVE', scope: 'TEAM', brand: 'B1' },
    ]);
  });
  afterAll(() => ctx.close());

  it('logs in with httpOnly cookies and reads /me', async () => {
    const res = await ctx
      .http()
      .post('/api/v1/auth/login')
      .set(H)
      .send({ email: 'EXEC@auth.test', password: PASSWORD });
    expect(res.status).toBe(200);
    const setCookie = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(setCookie).toMatch(/crm_at=.*HttpOnly/);
    expect(setCookie).toMatch(/crm_rt=.*Path=\/api\/v1\/auth.*HttpOnly/);
    const c = cookiesOf(res);
    const me = await ctx.http().get('/api/v1/auth/me').set('Cookie', `crm_at=${c.crm_at}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('exec@auth.test');
    expect(me.body.organization.id).toBe(fx.orgId);
    expect(Object.keys(me.body.permissions)).toContain('lead.read_own');
  });

  it('rejects wrong passwords and unknown emails identically', async () => {
    const a = await ctx
      .http()
      .post('/api/v1/auth/login')
      .set(H)
      .send({ email: 'exec@auth.test', password: 'wrong-password' });
    const b = await ctx
      .http()
      .post('/api/v1/auth/login')
      .set(H)
      .send({ email: 'nobody@auth.test', password: 'wrong-password' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe(b.body.error.code);
  });

  it('requires authentication on protected routes', async () => {
    expect((await ctx.http().get('/api/v1/brands')).status).toBe(401);
    expect(
      (await ctx.http().get('/api/v1/brands').set('Authorization', 'Bearer garbage')).status,
    ).toBe(401);
  });

  it('requires the CSRF header for cookie-authenticated writes', async () => {
    const login = await ctx
      .http()
      .post('/api/v1/auth/login')
      .set(H)
      .send({ email: 'exec@auth.test', password: PASSWORD });
    const c = cookiesOf(login);
    const res = await ctx.http().post('/api/v1/auth/logout').set('Cookie', `crm_at=${c.crm_at}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_HEADER_MISSING');
  });

  describe('lockout', () => {
    it('locks after repeated failures, even for the correct password, then unlocks', async () => {
      await createUser(ctx.owner, fx, 'lock@auth.test', []);
      for (let i = 0; i < 5; i++) {
        await ctx
          .http()
          .post('/api/v1/auth/login')
          .set(H)
          .send({ email: 'lock@auth.test', password: 'wrong-password' });
      }
      const locked = await ctx
        .http()
        .post('/api/v1/auth/login')
        .set(H)
        .send({ email: 'lock@auth.test', password: PASSWORD });
      expect(locked.status).toBe(401);
      const user = await ctx.owner.user.findUniqueOrThrow({ where: { email: 'lock@auth.test' } });
      expect(user.lockedUntil).not.toBeNull();
      const events = await ctx.owner.auditLog.findMany({
        where: { entityId: user.id },
        select: { action: true },
      });
      expect(events.map((e) => e.action)).toEqual(
        expect.arrayContaining([
          'auth.login_failed',
          'auth.account_locked',
          'auth.login_blocked_locked',
        ]),
      );

      ctx.clock.advance(16 * 60_000);
      const ok = await ctx
        .http()
        .post('/api/v1/auth/login')
        .set(H)
        .send({ email: 'lock@auth.test', password: PASSWORD });
      expect(ok.status).toBe(200);
    });
  });

  describe('refresh tokens', () => {
    it('rotates on refresh; reusing an old token later revokes the whole session family', async () => {
      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .set(H)
        .send({ email: 'admin@auth.test', password: PASSWORD });
      const first = cookiesOf(login);
      const r1 = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .set(H)
        .set('Cookie', `crm_rt=${first.crm_rt}`);
      expect(r1.status).toBe(200);
      const second = cookiesOf(r1);
      expect(second.crm_rt).not.toBe(first.crm_rt);

      // Within the grace window a stale token is refused but does not kill the family.
      const race = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .set(H)
        .set('Cookie', `crm_rt=${first.crm_rt}`);
      expect(race.status).toBe(401);
      expect(
        (
          await ctx
            .http()
            .get('/api/v1/auth/me')
            .set('Authorization', `Bearer ${r1.body.accessToken}`)
        ).status,
      ).toBe(200);

      // After the grace window, reuse is treated as theft.
      ctx.clock.advance(60_000);
      const reuse = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .set(H)
        .set('Cookie', `crm_rt=${first.crm_rt}`);
      expect(reuse.status).toBe(401);
      expect(
        (
          await ctx
            .http()
            .get('/api/v1/auth/me')
            .set('Authorization', `Bearer ${r1.body.accessToken}`)
        ).status,
      ).toBe(401);
      const r2 = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .set(H)
        .set('Cookie', `crm_rt=${second.crm_rt}`);
      expect(r2.status).toBe(401);
    });
  });

  it('logout invalidates the access token immediately', async () => {
    const token = await bearer(ctx, 'admin@auth.test');
    expect((await ctx.http().post('/api/v1/auth/logout').set('Authorization', token)).status).toBe(
      204,
    );
    expect((await ctx.http().get('/api/v1/auth/me').set('Authorization', token)).status).toBe(401);
  });

  it('deactivating a user ends their sessions immediately', async () => {
    const userId = await createUser(ctx.owner, fx, 'leaver@auth.test', [
      { role: 'SALES_EXECUTIVE', scope: 'BRAND', brand: 'B1' },
    ]);
    const userToken = await bearer(ctx, 'leaver@auth.test');
    const adminToken = await bearer(ctx, 'admin@auth.test');
    const res = await ctx
      .http()
      .post(`/api/v1/users/${userId}/status`)
      .set('Authorization', adminToken)
      .send({ status: 'DEACTIVATED', reason: 'Left the company' });
    expect(res.status).toBe(200);
    expect((await ctx.http().get('/api/v1/auth/me').set('Authorization', userToken)).status).toBe(
      401,
    );
    const login = await ctx
      .http()
      .post('/api/v1/auth/login')
      .set(H)
      .send({ email: 'leaver@auth.test', password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it('password reset: email link works once and revokes existing sessions', async () => {
    await createUser(ctx.owner, fx, 'forgot@auth.test', [
      { role: 'SALES_EXECUTIVE', scope: 'BRAND', brand: 'B1' },
    ]);
    const oldToken = await bearer(ctx, 'forgot@auth.test');
    const unknown = await ctx
      .http()
      .post('/api/v1/auth/password/forgot')
      .set(H)
      .send({ email: 'ghost@auth.test' });
    const known = await ctx
      .http()
      .post('/api/v1/auth/password/forgot')
      .set(H)
      .send({ email: 'forgot@auth.test' });
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
    expect(ctx.mail.sent.some((m) => m.to === 'ghost@auth.test')).toBe(false);

    const token = ctx.mail.lastTokenFor('forgot@auth.test');
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/password/reset')
          .set(H)
          .send({ token, newPassword: 'Brand-New-Pass-1' })
      ).status,
    ).toBe(204);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/password/reset')
          .set(H)
          .send({ token, newPassword: 'Another-Pass-22' })
      ).status,
    ).toBe(400);
    expect((await ctx.http().get('/api/v1/auth/me').set('Authorization', oldToken)).status).toBe(
      401,
    );
    await bearer(ctx, 'forgot@auth.test', 'Brand-New-Pass-1');
  });

  it('password reset links expire', async () => {
    await createUser(ctx.owner, fx, 'slow@auth.test', []);
    await ctx.http().post('/api/v1/auth/password/forgot').set(H).send({ email: 'slow@auth.test' });
    const token = ctx.mail.lastTokenFor('slow@auth.test');
    ctx.clock.advance(31 * 60_000);
    const res = await ctx
      .http()
      .post('/api/v1/auth/password/reset')
      .set(H)
      .send({ token, newPassword: 'Too-Late-Pass-1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('rate-limits login attempts per client', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await ctx
        .http()
        .post('/api/v1/auth/login')
        .set(H)
        .set('x-test-rate-limit', '1')
        .send({ email: 'nobody@auth.test', password: 'x' });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });

  it('rejects short passwords', async () => {
    const res = await ctx
      .http()
      .post('/api/v1/auth/password/reset')
      .set(H)
      .send({ token: 'x'.repeat(30), newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
