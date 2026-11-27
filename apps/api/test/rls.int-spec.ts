import { Db } from '../src/db/db.service';
import { createOrgFixture, createTestContext, OrgFixture, TestContext } from './helpers';

/** Database-level tenant isolation: holds even if application code forgets a filter. */
describe('Row-level security', () => {
  let ctx: TestContext;
  let db: Db;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeAll(async () => {
    ctx = await createTestContext();
    db = ctx.app.get(Db);
    a = await createOrgFixture(ctx.owner, 'rls-a');
    b = await createOrgFixture(ctx.owner, 'rls-b');
  });
  afterAll(() => ctx.close());

  it('an unfiltered query inside a tenant transaction sees only that tenant', async () => {
    const brands = await db.tenant(a.orgId, (tx) => tx.brand.findMany());
    expect(brands).toHaveLength(2);
    expect(brands.every((x) => x.organizationId === a.orgId)).toBe(true);
    const orgs = await db.tenant(a.orgId, (tx) => tx.organization.findMany());
    expect(orgs.map((o) => o.id)).toEqual([a.orgId]);
  });

  it('a tenant cannot read another tenant row even by primary key', async () => {
    const found = await db.tenant(a.orgId, (tx) =>
      tx.brand.findUnique({ where: { id: b.brands.B1 } }),
    );
    expect(found).toBeNull();
    const raw = await db.tenant(
      a.orgId,
      (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM brands WHERE id = ${b.brands.B1}::uuid`,
    );
    expect(raw).toHaveLength(0);
  });

  it('a tenant cannot write rows into another tenant', async () => {
    await expect(
      db.tenant(a.orgId, (tx) =>
        tx.brand.create({
          data: {
            organizationId: b.orgId,
            name: 'x',
            code: 'X1',
            country: 'IN',
            timezone: 'Asia/Kolkata',
            currency: 'INR',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a tenant cannot update another tenant rows', async () => {
    const res = await db.tenant(a.orgId, (tx) =>
      tx.brand.updateMany({ where: { id: b.brands.B1 }, data: { name: 'hacked' } }),
    );
    expect(res.count).toBe(0);
  });

  it('without any tenant set, the app role sees nothing', async () => {
    const prisma = ctx.app.get(Db)['prisma'];
    expect(await prisma.brand.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
  });

  it('audit_logs are append-only for the app role', async () => {
    await db.tenant(a.orgId, (tx) =>
      tx.auditLog.create({ data: { organizationId: a.orgId, action: 'test', entityType: 'test' } }),
    );
    await expect(
      db.tenant(a.orgId, (tx) => tx.auditLog.updateMany({ data: { action: 'changed' } })),
    ).rejects.toThrow();
    await expect(db.tenant(a.orgId, (tx) => tx.auditLog.deleteMany({}))).rejects.toThrow();
  });

  it('even the table owner cannot update audit rows (trigger)', async () => {
    await expect(ctx.owner.$executeRawUnsafe(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(
      /append-only/,
    );
  });
});
