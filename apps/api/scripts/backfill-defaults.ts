/** Deploy-time backfill: give every brand its operational defaults (idempotent). */
import { PrismaClient } from '@prisma/client';
import { resolveDatabaseEnv } from '../src/db-env';
import { ensureBrandDefaults } from '../src/settings/brand-defaults';

async function main(): Promise<void> {
  resolveDatabaseEnv();
  const prisma = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  try {
    const n = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      const brands = await tx.brand.findMany({
        select: { id: true, organizationId: true, country: true },
      });
      let changed = 0;
      for (const b of brands) if ((await ensureBrandDefaults(tx, b)).created.length) changed++;
      return changed;
    });
    console.log(`Brand defaults backfilled for ${n} brand(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
