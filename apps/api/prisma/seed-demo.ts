/**
 * DEVELOPMENT ONLY — creates a clearly labelled demo organization for local exploration.
 * Refuses to run when NODE_ENV=production. All demo users share DEMO_PASSWORD.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/crypto';
import { seedSystemRoles } from '../src/platform/organizations.service';

const DEMO_PASSWORD = 'DemoPass#2026';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('seed-demo is disabled in production');
  const prisma = new PrismaClient();
  try {
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      if (await tx.organization.findUnique({ where: { slug: 'demo-education' } })) {
        console.log('Demo organization already exists');
        return;
      }
      const org = await tx.organization.create({
        data: {
          name: '[DEMO] Demo Education Group',
          slug: 'demo-education',
          country: 'IN',
          timezone: 'Asia/Kolkata',
          currency: 'INR',
        },
      });
      const roles = await seedSystemRoles(tx, org.id);
      const brandIn = await tx.brand.create({
        data: {
          organizationId: org.id,
          name: '[DEMO] Academy India',
          code: 'ACAD-IN',
          country: 'IN',
          timezone: 'Asia/Kolkata',
          currency: 'INR',
        },
      });
      const brandAe = await tx.brand.create({
        data: {
          organizationId: org.id,
          name: '[DEMO] Institute Dubai',
          code: 'INST-AE',
          country: 'AE',
          timezone: 'Asia/Dubai',
          currency: 'AED',
        },
      });
      const kochi = await tx.branch.create({
        data: {
          organizationId: org.id,
          brandId: brandIn.id,
          name: 'Kochi',
          code: 'KOCHI',
          city: 'Kochi',
          country: 'IN',
          timezone: 'Asia/Kolkata',
        },
      });
      await tx.branch.create({
        data: {
          organizationId: org.id,
          brandId: brandAe.id,
          name: 'Dubai',
          code: 'DXB',
          city: 'Dubai',
          country: 'AE',
          timezone: 'Asia/Dubai',
        },
      });

      const mk = (email: string, name: string) =>
        tx.user.create({
          data: {
            organizationId: org.id,
            email,
            name,
            status: 'ACTIVE',
            passwordHash,
            languages: ['en'],
          },
        });
      const admin = await mk('admin@demo.local', 'Demo Org Admin');
      const bmIn = await mk('brand.india@demo.local', 'Demo Brand Manager India');
      const tl = await mk('leader@demo.local', 'Demo Team Leader');
      const exec = await mk('exec@demo.local', 'Demo Sales Executive');
      const team = await tx.team.create({
        data: {
          organizationId: org.id,
          brandId: brandIn.id,
          branchId: kochi.id,
          name: 'Kochi Sales A',
          leaderId: tl.id,
        },
      });
      for (const u of [tl, exec])
        await tx.teamMember.create({
          data: { organizationId: org.id, teamId: team.id, userId: u.id },
        });

      const grant = (
        userId: string,
        roleId: string,
        scopeType: 'ORGANIZATION' | 'BRAND' | 'TEAM',
        brandId?: string,
        teamId?: string,
      ) =>
        tx.roleAssignment.create({
          data: {
            organizationId: org.id,
            userId,
            roleId,
            scopeType,
            brandId,
            teamId,
            grantReason: 'demo seed',
          },
        });
      await grant(admin.id, roles.ORG_ADMIN, 'ORGANIZATION');
      await grant(bmIn.id, roles.BRAND_MANAGER, 'BRAND', brandIn.id);
      await grant(tl.id, roles.TEAM_LEADER, 'TEAM', brandIn.id, team.id);
      await grant(exec.id, roles.SALES_EXECUTIVE, 'TEAM', brandIn.id, team.id);
      console.log(
        `Demo organization created. Users (password ${DEMO_PASSWORD}): admin@, brand.india@, leader@, exec@demo.local`,
      );
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
