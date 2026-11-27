/**
 * Resolves database URLs before anything reads them (API, scripts, Prisma CLI wrapper).
 *
 * Explicit values always win:
 *   APP_DATABASE_URL        app role crm_app (subject to row-level security)
 *   MIGRATION_DATABASE_URL  owner role (migrations, role setup, seeds)
 *
 * Fallback for hosted Postgres integrations (e.g. Neon on Vercel) that inject owner
 * credentials as DATABASE_URL (pooled) and DATABASE_URL_UNPOOLED (direct):
 *   MIGRATION_DATABASE_URL ← DATABASE_URL_UNPOOLED
 *   APP_DATABASE_URL       ← DATABASE_URL with user/password replaced by crm_app / CRM_APP_DB_PASSWORD
 */
export function resolveDatabaseEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.MIGRATION_DATABASE_URL && env.DATABASE_URL_UNPOOLED) {
    env.MIGRATION_DATABASE_URL = env.DATABASE_URL_UNPOOLED;
  }
  if (!env.APP_DATABASE_URL && env.DATABASE_URL && env.CRM_APP_DB_PASSWORD) {
    const url = new URL(env.DATABASE_URL);
    url.username = 'crm_app';
    url.password = env.CRM_APP_DB_PASSWORD;
    if (url.hostname.includes('-pooler')) {
      // PgBouncer transaction mode: disable prepared statements; keep one connection per instance.
      url.searchParams.set('pgbouncer', 'true');
      if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '3');
    }
    env.APP_DATABASE_URL = url.toString();
  }
}
