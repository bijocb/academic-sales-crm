/**
 * LOAD TESTING ONLY — adds volume to the [DEMO] organization of a scratch database (Phase 15, docs/PERFORMANCE.md):
 * 40 extra sales executives and LOAD_LEADS leads (default 20,000) with enquiries, assignments, calls and open tasks.
 * Refuses to run when NODE_ENV=production or when the database name does not contain "load".
 *
 *   MIGRATION_DATABASE_URL=postgresql://…/crm_load LOAD_LEADS=20000 npx tsx scripts/seed-load.ts
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/crypto';
import { resolveDatabaseEnv } from '../src/db-env';

resolveDatabaseEnv();
const url = process.env.MIGRATION_DATABASE_URL ?? '';
if (process.env.NODE_ENV === 'production') throw new Error('seed-load never runs in production');
if (!/load/i.test(new URL(url).pathname))
  throw new Error('seed-load only runs on a database named *load*');

const TOTAL = Number(process.env.LOAD_LEADS ?? 20_000);
const EXECUTIVES = 40;
const BATCH = 1000;
const DAY = 86_400_000;
// Deterministic pseudo-random numbers, so every run builds the same data.
let seed = 42;
const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const now = new Date();
  try {
    const org = await prisma.organization.findUniqueOrThrow({ where: { slug: 'demo-education' } });
    const brand = await prisma.brand.findFirstOrThrow({
      where: { organizationId: org.id, country: 'IN' },
    });
    const team = await prisma.team.findFirstOrThrow({ where: { brandId: brand.id } });
    const role = await prisma.role.findFirstOrThrow({
      where: { organizationId: org.id, key: 'SALES_EXECUTIVE' },
    });
    const source = await prisma.leadSource.findFirstOrThrow({
      where: { brandId: brand.id, channel: 'WEBSITE' },
    });
    if (
      await prisma.lead.count({
        where: { organizationId: org.id, leadNumber: { startsWith: 'LD-' } },
      })
    ) {
      console.log('Load data already present');
      return;
    }
    const passwordHash = await hashPassword(process.env.DEMO_PASSWORD ?? 'DemoPass#2026');
    const execs: string[] = [];
    for (let i = 1; i <= EXECUTIVES; i++) {
      const u = await prisma.user.create({
        data: {
          organizationId: org.id,
          email: `load.exec${i}@demo.local`,
          name: `[LOAD] Executive ${i}`,
          status: 'ACTIVE',
          passwordHash,
          languages: ['en'],
        },
      });
      await prisma.roleAssignment.create({
        data: {
          organizationId: org.id,
          userId: u.id,
          roleId: role.id,
          scopeType: 'TEAM',
          brandId: brand.id,
          teamId: team.id,
          grantReason: 'load test seed',
        },
      });
      await prisma.teamMember.create({
        data: { organizationId: org.id, teamId: team.id, userId: u.id },
      });
      execs.push(u.id);
    }
    const STAGES = ['NEW_ENQUIRY', 'CONTACTED', 'QUALIFIED', 'INTERESTED', 'COUNSELLING_COMPLETED'];
    for (let start = 0; start < TOTAL; start += BATCH) {
      const persons: Array<{
        id: string;
        organizationId: string;
        fullName: string;
        phoneE164: string;
        createdAt: Date;
      }> = [];
      const leads: Parameters<typeof prisma.lead.createMany>[0]['data'] = [];
      const enquiries: Parameters<typeof prisma.enquiry.createMany>[0]['data'] = [];
      const assignments: Parameters<typeof prisma.leadAssignment.createMany>[0]['data'] = [];
      const calls: Parameters<typeof prisma.activity.createMany>[0]['data'] = [];
      const tasks: Parameters<typeof prisma.task.createMany>[0]['data'] = [];
      for (let i = start; i < Math.min(start + BATCH, TOTAL); i++) {
        const createdAt = new Date(now.getTime() - Math.floor(rnd() * 180 * DAY));
        const personId = crypto.randomUUID();
        const leadId = crypto.randomUUID();
        const r = rnd();
        const status =
          r < 0.7 ? 'OPEN' : r < 0.85 ? 'LOST' : r < 0.95 ? 'CONVERTED' : 'CLOSED_LOST';
        const owner = rnd() < 0.95 ? pick(execs) : null;
        persons.push({
          id: personId,
          organizationId: org.id,
          fullName: `[LOAD] Lead ${i + 1}`,
          phoneE164: `+917${String(100_000_000 + i).padStart(9, '0')}`,
          createdAt,
        });
        leads.push({
          id: leadId,
          organizationId: org.id,
          brandId: brand.id,
          personId,
          leadNumber: `LD-${String(i + 1).padStart(6, '0')}`,
          stage: status === 'CONVERTED' ? 'ADMISSION_CONFIRMED' : pick(STAGES),
          status,
          ownerId: owner,
          firstEnquiryAt: createdAt,
          lastEnquiryAt: createdAt,
          createdAt,
        });
        enquiries.push({
          organizationId: org.id,
          brandId: brand.id,
          leadId,
          personId,
          classification: 'NEW_LEAD',
          channel: 'WEBSITE',
          sourceId: source.id,
          dedupKey: `load-${i}`,
          receivedAt: createdAt,
          createdAt,
        });
        if (!owner) continue;
        assignments.push({
          organizationId: org.id,
          brandId: brand.id,
          leadId,
          toUserId: owner,
          type: 'AUTO',
          attemptNo: 1,
          assignedAt: createdAt,
        });
        if (rnd() < 0.5) {
          const at = new Date(createdAt.getTime() + Math.floor(rnd() * 2 * DAY));
          calls.push({
            organizationId: org.id,
            brandId: brand.id,
            leadId,
            personId,
            type: 'CALL',
            direction: 'OUTBOUND',
            outcome: rnd() < 0.6 ? 'CONNECTED' : 'NO_ANSWER',
            actorUserId: owner,
            occurredAt: at,
            createdAt: at,
          });
        }
        if (status === 'OPEN' && rnd() < 0.5)
          tasks.push({
            organizationId: org.id,
            brandId: brand.id,
            leadId,
            ownerId: owner,
            type: 'CALL_BACK',
            title: 'Call back',
            dueAt: new Date(now.getTime() + Math.floor((rnd() - 0.4) * 10 * DAY)),
            createdAt,
          });
      }
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.person.createMany({ data: persons });
        await tx.lead.createMany({ data: leads });
        await tx.enquiry.createMany({ data: enquiries });
        await tx.leadAssignment.createMany({ data: assignments });
        await tx.activity.createMany({ data: calls });
        await tx.task.createMany({ data: tasks });
      });
      process.stdout.write(`\r${Math.min(start + BATCH, TOTAL)} / ${TOTAL} leads`);
    }
    console.log('\nLoad data created');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
