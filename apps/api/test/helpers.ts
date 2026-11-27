import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { SYSTEM_ROLE_TEMPLATES } from '@crm/contracts';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { Clock, FixedClock } from '../src/common/clock';
import { MailMessage, MailService } from '../src/mail/mail.service';
import { hashPassword } from '../src/auth/crypto';
import { seedSystemRoles } from '../src/platform/organizations.service';
import { ensureBrandDefaults } from '../src/settings/brand-defaults';
import { TEST_ENV } from './env';

/** TEST DOUBLE — captures outgoing mail instead of sending it. */
export class CapturingMail extends MailService {
  readonly sent: MailMessage[] = [];
  async send(m: MailMessage): Promise<void> {
    this.sent.push(m);
  }
  lastTokenFor(email: string): string {
    const msg = [...this.sent].reverse().find((m) => m.to === email);
    const match = msg?.text.match(/token=([^&\s]+)/);
    if (!match) throw new Error(`No token mail for ${email}`);
    return decodeURIComponent(match[1]);
  }
}

export interface TestContext {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  owner: PrismaClient; // superuser connection for fixtures (bypasses RLS)
  mail: CapturingMail;
  clock: FixedClock;
  close: () => Promise<void>;
}

export const PASSWORD = 'Correct-Horse-9';
let cachedHash: Promise<string> | undefined;
const passwordHash = () => (cachedHash ??= hashPassword(PASSWORD));

export async function createTestContext(): Promise<TestContext> {
  Object.assign(process.env, TEST_ENV);
  const config = loadConfig(process.env);
  const mail = new CapturingMail();
  const clock = new FixedClock(new Date());
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(MailService)
    .useValue(mail)
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, config);
  await app.init();
  const owner = new PrismaClient({ datasourceUrl: TEST_ENV.MIGRATION_DATABASE_URL });
  await resetDatabase(owner);
  return {
    app,
    http: () => request(app.getHttpServer()),
    owner,
    mail,
    clock,
    close: async () => {
      await owner.$disconnect();
      await app.close();
    },
  };
}

export async function resetDatabase(owner: PrismaClient): Promise<void> {
  // Superuser-only: replica mode skips the append-only triggers so fixtures can be wiped.
  await owner.$transaction([
    owner.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    owner.$executeRawUnsafe(
      `TRUNCATE message_events, outbound_messages, activities, message_templates, appointments, jobs, sla_events, sla_instances, tasks, notifications, lead_assignments, allocation_runs, allocation_rules, allocation_settings, user_leaves, lead_events, person_merges, duplicate_candidates, outbox_events, org_counters, enquiries, intake_exceptions, lead_imports, intake_keys, campaigns, leads, persons, lead_sources, sla_checkpoints, sla_policies, pipeline_stages, working_hours, holidays, batches, courses, course_categories, audit_logs, auth_tokens, sessions, team_members, role_assignments, role_permissions, roles, teams, branches, users, brands, organizations CASCADE`,
    ),
  ]);
}

export type RoleKey = keyof typeof SYSTEM_ROLE_TEMPLATES;

export interface OrgFixture {
  orgId: string;
  roles: Record<string, string>;
  brands: Record<string, string>;
  branches: Record<string, string>;
  teams: Record<string, string>;
}

/** Builds an org with brands B1 (IN) and B2 (AE), a branch and a team in each. */
export async function createOrgFixture(
  owner: PrismaClient,
  slug: string,
  opts: { autoAllocate?: boolean } = {},
): Promise<OrgFixture> {
  return owner.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: `Org ${slug}`, slug, country: 'IN', timezone: 'Asia/Kolkata', currency: 'INR' },
    });
    const roles = await seedSystemRoles(tx, org.id);
    const brands: Record<string, string> = {};
    const branches: Record<string, string> = {};
    const teams: Record<string, string> = {};
    for (const [code, country, tz, cur] of [
      ['B1', 'IN', 'Asia/Kolkata', 'INR'],
      ['B2', 'AE', 'Asia/Dubai', 'AED'],
    ] as const) {
      const b = await tx.brand.create({
        data: {
          organizationId: org.id,
          name: `Brand ${code}`,
          code,
          country,
          timezone: tz,
          currency: cur,
        },
      });
      await ensureBrandDefaults(tx, b);
      // Earlier suites test intake without allocation; Phase 6 suites opt in.
      if (!opts.autoAllocate)
        await tx.allocationSettings.update({ where: { brandId: b.id }, data: { enabled: false } });
      const br = await tx.branch.create({
        data: {
          organizationId: org.id,
          brandId: b.id,
          name: `Branch ${code}`,
          code: `${code}-BR`,
          country,
          timezone: tz,
        },
      });
      const t = await tx.team.create({
        data: { organizationId: org.id, brandId: b.id, branchId: br.id, name: `Team ${code}` },
      });
      brands[code] = b.id;
      branches[code] = br.id;
      teams[code] = t.id;
    }
    return { orgId: org.id, roles, brands, branches, teams };
  });
}

export async function createUser(
  owner: PrismaClient,
  fx: OrgFixture,
  email: string,
  grants: Array<{
    role: RoleKey;
    scope: 'ORGANIZATION' | 'BRAND' | 'BRANCH' | 'TEAM';
    brand?: string;
  }>,
): Promise<string> {
  const hash = await passwordHash();
  return owner.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        organizationId: fx.orgId,
        email,
        name: email.split('@')[0],
        status: 'ACTIVE',
        passwordHash: hash,
      },
    });
    for (const g of grants) {
      const brandId = g.brand ? fx.brands[g.brand] : null;
      await tx.roleAssignment.create({
        data: {
          organizationId: fx.orgId,
          userId: u.id,
          roleId: fx.roles[g.role],
          scopeType: g.scope,
          brandId: g.scope === 'ORGANIZATION' ? null : brandId,
          branchId: g.scope === 'BRANCH' ? fx.branches[g.brand!] : null,
          teamId: g.scope === 'TEAM' ? fx.teams[g.brand!] : null,
        },
      });
      if (g.scope === 'TEAM')
        await tx.teamMember.create({
          data: { organizationId: fx.orgId, teamId: fx.teams[g.brand!], userId: u.id },
        });
    }
    return u.id;
  });
}

export async function createPlatformAdmin(owner: PrismaClient, email: string): Promise<string> {
  const u = await owner.user.create({
    data: {
      email,
      name: 'Platform',
      isPlatformAdmin: true,
      status: 'ACTIVE',
      passwordHash: await passwordHash(),
    },
  });
  return u.id;
}

/** Logs in and returns a Bearer header value. */
export async function bearer(
  ctx: TestContext,
  email: string,
  password = PASSWORD,
): Promise<string> {
  const res = await ctx
    .http()
    .post('/api/v1/auth/login')
    .set('x-crm-client', 'web')
    .send({ email, password });
  if (res.status !== 200)
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return `Bearer ${res.body.accessToken}`;
}
