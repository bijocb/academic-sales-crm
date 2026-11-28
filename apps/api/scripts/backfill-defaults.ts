/** Deploy-time backfill: give every brand its operational defaults (idempotent). */
import { PrismaClient } from '@prisma/client';
import { resolveDatabaseEnv } from '../src/db-env';
import { ensureBrandDefaults } from '../src/settings/brand-defaults';
import { nameKey } from '../src/leads/duplicate-rules';
import { SYSTEM_ROLE_TEMPLATES } from '@crm/contracts';

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
      // System roles are read-only and always mirror their templates (e.g. lead.receive in Phase 6).
      const systemRoles = await tx.role.findMany({
        where: { isSystem: true },
        include: { permissions: true },
      });
      for (const role of systemRoles) {
        const tpl = SYSTEM_ROLE_TEMPLATES[role.key];
        if (!tpl) continue;
        const want = new Set<string>(tpl.permissions);
        const have = new Set(role.permissions.map((x) => x.permission));
        const add = [...want].filter((x) => !have.has(x));
        const remove = [...have].filter((x) => !want.has(x));
        if (add.length)
          await tx.rolePermission.createMany({
            data: add.map((permission) => ({
              organizationId: role.organizationId,
              roleId: role.id,
              permission,
            })),
          });
        if (remove.length)
          await tx.rolePermission.deleteMany({
            where: { roleId: role.id, permission: { in: remove } },
          });
      }
      return changed;
    });
    console.log(`Brand defaults backfilled for ${n} brand(s)`);
    // Phase 5: name keys for duplicate suggestions — in batches, so a large import never times out a deploy.
    let keyed = 0;
    for (;;) {
      const done = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        const batch = await tx.person.findMany({
          where: { nameKey: null },
          select: { id: true, fullName: true },
          take: 500,
        });
        for (const p of batch)
          await tx.person.update({ where: { id: p.id }, data: { nameKey: nameKey(p.fullName) } });
        return batch.length;
      });
      keyed += done;
      if (done < 500) break;
    }
    if (keyed) console.log(`Name keys backfilled for ${keyed} person(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
