import { createTestContext, TestContext } from './helpers';

/**
 * Phase 15 security review: database-level guarantees that must hold for every table, now and as tables are added.
 * See docs/SECURITY-REVIEW.md.
 */
describe('Database security baseline', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it('every table with organization_id has forced RLS and the tenant_isolation policy', async () => {
    const rows = await ctx.owner.$queryRaw<
      Array<{ table: string; rls: boolean; forced: boolean; policy: boolean }>
    >`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS policy
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM information_schema.columns col
                    WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'organization_id')
      ORDER BY 1`;
    expect(rows.length).toBeGreaterThan(60);
    expect(rows.filter((r) => !(r.rls && r.forced && r.policy)).map((r) => r.table)).toEqual([]);
  });

  it('the application role cannot bypass RLS and is not a superuser', async () => {
    const [role] = await ctx.owner.$queryRaw<Array<{ super: boolean; bypass: boolean }>>`
      SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = 'crm_app'`;
    expect(role).toEqual({ super: false, bypass: false });
  });

  // CLAUDE.md rule 4 plus every history table added since.
  const APPEND_ONLY = [
    'audit_logs',
    'lead_assignments',
    'lead_stage_history',
    'lead_status_history',
    'activities',
    'payments',
    'payment_events',
    'refunds',
    'refund_events',
    'fee_adjustments',
    'admission_status_history',
    'incentive_rules',
    'incentive_lines',
    'ai_models',
    'lead_scores',
    'lead_score_overrides',
    'ai_suggestion_events',
  ];

  it.each(APPEND_ONLY)(
    '%s is append-only: no UPDATE/DELETE grant for crm_app and a blocking trigger',
    async (table) => {
      const [g] = await ctx.owner.$queryRaw<Array<{ upd: boolean; del: boolean; trg: number }>>`
      SELECT has_table_privilege('crm_app', ${table}, 'UPDATE') AS upd,
             has_table_privilege('crm_app', ${table}, 'DELETE') AS del,
             (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
               WHERE c.relname = ${table} AND NOT t.tgisinternal) AS trg`;
      expect({ table, ...g, trg: g.trg > 0 }).toEqual({ table, upd: false, del: false, trg: true });
    },
  );
});
