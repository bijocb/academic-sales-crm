import { execSync } from 'node:child_process';
import path from 'node:path';
import { TEST_ENV } from './env';

/** Applies migrations to the test database and enables the crm_app login. */
export default function globalSetup(): void {
  const cwd = path.resolve(__dirname, '..');
  const env = { ...process.env, ...TEST_ENV };
  execSync('npx prisma migrate deploy', { cwd, env, stdio: 'pipe' });
  execSync('npx tsx scripts/setup-db-role.ts', { cwd, env, stdio: 'pipe' });
}
