/**
 * Enables login for the crm_app role with CRM_APP_DB_PASSWORD (role itself is created by
 * the first migration). Runs as the owner (MIGRATION_DATABASE_URL). Idempotent.
 */
import { PrismaClient } from '@prisma/client';
import { resolveDatabaseEnv } from '../src/db-env';

async function main(): Promise<void> {
  resolveDatabaseEnv();
  const owner = process.env.MIGRATION_DATABASE_URL;
  const password = process.env.CRM_APP_DB_PASSWORD;
  if (!owner || !password)
    throw new Error('MIGRATION_DATABASE_URL and CRM_APP_DB_PASSWORD are required');
  if (password.length < 16 && process.env.NODE_ENV === 'production') {
    throw new Error('CRM_APP_DB_PASSWORD must be at least 16 characters in production');
  }
  const prisma = new PrismaClient({ datasourceUrl: owner });
  try {
    const quoted = `'${password.replace(/'/g, "''")}'`;
    await prisma.$executeRawUnsafe(`ALTER ROLE crm_app LOGIN PASSWORD ${quoted}`);
    console.log('crm_app login enabled');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
