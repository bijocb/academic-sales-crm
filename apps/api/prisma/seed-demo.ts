/**
 * DEVELOPMENT ONLY — creates a clearly labelled demo organization for local exploration.
 * Refuses to run when NODE_ENV=production unless ALLOW_DEMO_SEED=true (a labelled demo
 * deployment). All demo users share DEMO_PASSWORD (env), default below for local use only.
 */
import { PrismaClient } from '@prisma/client';
import { resolveDatabaseEnv } from '../src/db-env';
import { hashPassword } from '../src/auth/crypto';
import { seedSystemRoles } from '../src/platform/organizations.service';
import { ensureBrandDefaults } from '../src/settings/brand-defaults';
import { AuditService } from '../src/audit/audit.service';
import { SystemClock } from '../src/common/clock';
import { Db } from '../src/db/db.service';
import type { PrismaService } from '../src/db/prisma.service';
import { IntakeService } from '../src/leads/intake.service';
import { DuplicateDetector } from '../src/leads/duplicate-detector';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoPass#2026';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error(
      'seed-demo is disabled in production (set ALLOW_DEMO_SEED=true only for a demo deployment)',
    );
  }
  resolveDatabaseEnv();
  // Owner connection: seeds write across tenants.
  const prisma = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
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
      console.log('Demo organization created: admin@, brand.india@, leader@, exec@demo.local');
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await seedDemoCatalog(tx);
    });
    await seedDemoLeads(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** Demo courses and batches (idempotent: only when the demo brand has no courses). */
async function seedDemoCatalog(tx: Tx): Promise<void> {
  const org = await tx.organization.findUnique({ where: { slug: 'demo-education' } });
  if (!org) return;
  const brands = await tx.brand.findMany({ where: { organizationId: org.id } });
  for (const b of brands) await ensureBrandDefaults(tx, b);
  const catalog: Record<
    string,
    Array<{
      code: string;
      name: string;
      fee: number;
      months: number;
      mode: 'ONLINE' | 'OFFLINE' | 'HYBRID';
    }>
  > = {
    'ACAD-IN': [
      {
        code: 'DS-PRO',
        name: '[DEMO] Data Science Professional',
        fee: 85_000_00,
        months: 6,
        mode: 'HYBRID',
      },
      {
        code: 'DM-CERT',
        name: '[DEMO] Digital Marketing Certificate',
        fee: 45_000_00,
        months: 3,
        mode: 'ONLINE',
      },
    ],
    'INST-AE': [
      {
        code: 'PM-PRO',
        name: '[DEMO] Project Management Professional',
        fee: 6_500_00,
        months: 4,
        mode: 'OFFLINE',
      },
    ],
  };
  for (const b of brands) {
    const items = catalog[b.code];
    if (!items || (await tx.course.count({ where: { brandId: b.id } })) > 0) continue;
    const cat = await tx.courseCategory.upsert({
      where: { brandId_code: { brandId: b.id, code: 'PROF' } },
      update: {},
      create: {
        organizationId: org.id,
        brandId: b.id,
        name: 'Professional programmes',
        code: 'PROF',
      },
    });
    for (const c of items) {
      const course = await tx.course.create({
        data: {
          organizationId: org.id,
          brandId: b.id,
          categoryId: cat.id,
          code: c.code,
          name: c.name,
          deliveryMode: c.mode,
          durationValue: c.months,
          durationUnit: 'MONTHS',
          listFeeMinor: BigInt(c.fee),
          currency: b.currency,
          eligibility: 'Graduate in any discipline',
        },
      });
      await tx.batch.create({
        data: {
          organizationId: org.id,
          brandId: b.id,
          courseId: course.id,
          code: 'JAN-2027',
          name: 'January 2027 intake',
          startDate: new Date('2027-01-11T00:00:00Z'),
          endDate: new Date(Date.UTC(2027, 0 + c.months, 10)),
          capacity: 30,
          status: 'OPEN',
        },
      });
    }
  }
  console.log('Demo catalogue ensured');
}

/** A handful of [DEMO] leads through the real intake pipeline (idempotent via external IDs). */
async function seedDemoLeads(prisma: PrismaClient): Promise<void> {
  const org = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const o = await tx.organization.findUnique({
      where: { slug: 'demo-education' },
      include: { brands: { include: { leadSources: true } } },
    });
    return o;
  });
  if (!org) return;
  const intake = new IntakeService(
    new Db(prisma as unknown as PrismaService),
    new SystemClock(),
    new AuditService(),
    new DuplicateDetector(),
  );
  const brand = (code: string) => org.brands.find((b) => b.code === code)!;
  const src = (code: string, channel: string) =>
    brand(code).leadSources.find((s) => s.channel === channel)?.id;
  const leads: Array<[string, string, Record<string, string>]> = [
    [
      'ACAD-IN',
      'WEBSITE',
      {
        name: '[DEMO] Ananya Menon',
        phone: '9846000001',
        email: 'ananya.demo@example.com',
        courseCode: 'DS-PRO',
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: 'ds-jan-2027',
        city: 'Kochi',
      },
    ],
    [
      'ACAD-IN',
      'GOOGLE_ADS',
      {
        name: '[DEMO] Rohit Nair',
        phone: '9846000002',
        courseCode: 'DM-CERT',
        utm_source: 'google',
        utm_campaign: 'dm-brand',
      },
    ],
    [
      'ACAD-IN',
      'META_ADS',
      {
        name: '[DEMO] Sneha Pillai',
        phone: '9846000003',
        email: 'sneha.demo@example.com',
        course: 'Data Science',
        utm_source: 'facebook',
        utm_medium: 'paid_social',
      },
    ],
    [
      'ACAD-IN',
      'WEBSITE',
      {
        name: '[DEMO] Ananya Menon',
        phone: '+91 98460 00001',
        courseCode: 'DM-CERT',
        message: 'Also interested in weekend batches',
      },
    ],
    [
      'INST-AE',
      'WEBSITE',
      {
        name: '[DEMO] Omar Haddad',
        phone: '050 600 0001',
        email: 'omar.demo@example.ae',
        courseCode: 'PM-PRO',
        city: 'Dubai',
      },
    ],
    [
      'INST-AE',
      'REFERRAL',
      { name: '[DEMO] Priya Sharma', phone: '+971 55 600 0002', course: 'Project Management' },
    ],
    [
      'ACAD-IN',
      'MANUAL',
      {
        name: '[DEMO] Menon Ananya',
        phone: '9846000010',
        city: 'Kochi',
        message: 'Walk-in; possibly the same student as the website enquiry',
      },
    ],
  ];
  let i = 0;
  for (const [code, channel, data] of leads) {
    i++;
    await intake.ingest(
      {
        organizationId: org.id,
        brandId: brand(code).id,
        channel: channel as never,
        sourceId: src(code, channel),
        exceptionOnInvalid: true,
        dedupKey: `demo-seed:${i}`,
      },
      data,
    );
  }
  console.log('Demo leads ensured');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
