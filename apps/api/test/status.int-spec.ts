import { TEST_ENV } from './env';
import { createOrgFixture, createTestContext, OrgFixture, TestContext } from './helpers';

/** Phase 15 monitoring: /internal/status reports dead-lettered and overdue jobs (docs/RUNBOOK.md). */
describe('Operational status', () => {
  let ctx: TestContext;
  let a: OrgFixture;
  const NOW = new Date('2026-11-30T05:30:00Z');
  const status = (auth?: string) => {
    const r = ctx.http().get('/api/v1/internal/status');
    return auth ? r.set('Authorization', auth) : r;
  };
  const AUTH = `Bearer ${TEST_ENV.CRON_SECRET}`;
  const job = (key: string, data: Record<string, unknown>) =>
    ctx.owner.job.create({
      data: {
        organizationId: a.orgId,
        type: 'sla.checkpoint',
        key,
        payload: {},
        runAt: NOW,
        createdAt: NOW,
        ...data,
      },
    });

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await createOrgFixture(ctx.owner, 'status-a');
    ctx.clock.set(NOW);
  });
  afterAll(() => ctx.close());

  it('needs the scheduler secret', async () => {
    expect((await status()).status).toBe(401);
    expect((await status('Bearer wrong-secret-wrong-secret-wrong')).status).toBe(401);
  });

  it('is healthy with an empty queue', async () => {
    const r = await status(AUTH);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, problems: [], jobs: { overdue: 0, deadLast24h: 0 } });
  });

  it('reports overdue jobs (scheduler down) and dead-lettered jobs with 503', async () => {
    await job('status:stale', { status: 'PENDING', runAt: new Date(NOW.getTime() - 45 * 60_000) });
    await job('status:dead', {
      status: 'DEAD',
      attempts: 5,
      lastError: 'boom',
      finishedAt: new Date(NOW.getTime() - 60 * 60_000),
    });
    const r = await status(AUTH);
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
    expect(r.body.problems.join(' ')).toMatch(/scheduler is not running/);
    expect(r.body.problems.join(' ')).toMatch(/dead-lettered/);
    expect(r.body.jobs).toMatchObject({
      overdue: 1,
      oldestDueMinutes: 45,
      deadLast24h: 1,
      deadByType: { 'sla.checkpoint': 1 },
    });
  });
});
