/**
 * Creates the first platform Super Admin from SEED_PLATFORM_ADMIN_EMAIL / _PASSWORD.
 * Idempotent: does nothing if the user already exists. Safe for production use.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/crypto';

async function main(): Promise<void> {
  const email = process.env.SEED_PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_PLATFORM_ADMIN_PASSWORD;
  if (!email || !password)
    throw new Error('Set SEED_PLATFORM_ADMIN_EMAIL and SEED_PLATFORM_ADMIN_PASSWORD');
  if (password.length < 10)
    throw new Error('SEED_PLATFORM_ADMIN_PASSWORD must be at least 10 characters');

  const prisma = new PrismaClient();
  try {
    const passwordHash = await hashPassword(password);
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      if (await tx.user.findUnique({ where: { email } })) return false;
      await tx.user.create({
        data: {
          email,
          name: 'Platform Admin',
          isPlatformAdmin: true,
          status: 'ACTIVE',
          passwordHash,
        },
      });
      return true;
    });
    console.log(
      created ? `Platform admin created: ${email}` : `Platform admin already exists: ${email}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
