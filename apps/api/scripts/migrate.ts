/**
 * Deploy-time database step: resolve URLs, apply migrations, enable the app role, and run
 * seeds when configured (platform admin if SEED_PLATFORM_ADMIN_* set; demo data only if
 * ALLOW_DEMO_SEED=true). Used by `pnpm db:migrate`, the Docker entrypoint and Vercel builds.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { resolveDatabaseEnv } from '../src/db-env';

resolveDatabaseEnv();
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error('MIGRATION_DATABASE_URL (or DATABASE_URL_UNPOOLED) is required');
// Prisma CLI validates the runtime URL variable too; the owner URL is fine for migrate.
process.env.APP_DATABASE_URL ??= process.env.MIGRATION_DATABASE_URL;

const cwd = path.resolve(__dirname, '..');
const run = (cmd: string) => execSync(cmd, { cwd, stdio: 'inherit', env: process.env });

run('npx prisma migrate deploy');
run('npx tsx scripts/setup-db-role.ts');
if (process.argv.includes('--seed')) {
  if (process.env.SEED_PLATFORM_ADMIN_EMAIL) run('npx tsx prisma/seed.ts');
  if (process.env.ALLOW_DEMO_SEED === 'true') run('npx tsx prisma/seed-demo.ts');
}
