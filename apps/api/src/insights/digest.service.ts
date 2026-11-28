import { Inject, Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { NotificationsService } from '../allocation/notifications.service';
import { AssistantService } from '../assistant/assistant.service';
import { loadGrants } from '../auth/auth.service';
import { Authz } from '../auth/authz';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { APP_CONFIG, type AppConfig } from '../config';
import { Db } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { MailService } from '../mail/mail.service';
import { InsightsService, isManager } from './insights.service';

/** Mondays from this local hour (organization time zone), A-051. */
const DIGEST_HOUR = 8;

/**
 * Weekly insights digest (A-051) with the optional AI brief (A-052): one job per organization and week, which
 * enqueues one job per recipient. Keys are deterministic, so ticks and retries never send a week twice.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly jobs: JobsService,
    private readonly insights: InsightsService,
    private readonly assistant: AssistantService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.jobs.register('insights.digest', async (j) => {
      await this.orgJob(j.organizationId!, j.payload);
    });
    this.jobs.register('insights.digest.user', async (j) => {
      await this.userJob(j.organizationId!, j.payload);
    });
  }

  /** Called on every scheduler tick: on Mondays from 08:00 local time, once per organization and week. */
  async schedule() {
    const now = this.clock.now();
    const orgs = await this.db.system((tx) =>
      tx.organization.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, timezone: true },
      }),
    );
    let queued = 0;
    for (const o of orgs) {
      const local = DateTime.fromJSDate(now, { zone: o.timezone });
      if (local.weekday !== 1 || local.hour < DIGEST_HOUR) continue;
      const week = local.toISODate()!;
      await this.db.tenant(o.id, (tx) =>
        this.jobs.enqueue(tx, {
          organizationId: o.id,
          type: 'insights.digest',
          key: `insights.digest:${o.id}:${week}`,
          payload: { week },
          runAt: now,
        }),
      );
      queued++;
    }
    return { queued };
  }

  private async principal(organizationId: string, userId: string): Promise<OrgPrincipal | null> {
    return this.db.system(async (tx) => {
      const u = await tx.user.findUnique({ where: { id: userId } });
      if (!u || u.status !== 'ACTIVE' || u.organizationId !== organizationId) return null;
      return {
        userId: u.id,
        email: u.email,
        name: u.name,
        organizationId,
        isPlatformAdmin: false,
        familyId: 'job:insights.digest',
        authz: new Authz(await loadGrants(tx, u.id)),
      };
    });
  }

  /** Recipients: active users with team-level report access or above. */
  private async orgJob(organizationId: string, payload: unknown) {
    const { week } = payload as { week: string };
    const users = await this.db.tenant(organizationId, (tx) =>
      tx.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true } }),
    );
    let recipients = 0;
    for (const u of users) {
      const p = await this.principal(organizationId, u.id);
      if (!p || !isManager(p)) continue;
      recipients++;
      await this.db.tenant(organizationId, (tx) =>
        this.jobs.enqueue(tx, {
          organizationId,
          type: 'insights.digest.user',
          key: `insights.digest.user:${u.id}:${week}`,
          payload: { userId: u.id, week },
          runAt: this.clock.now(),
        }),
      );
    }
    return { recipients };
  }

  private async userJob(organizationId: string, payload: unknown) {
    const { userId, week } = payload as { userId: string; week: string };
    const p = await this.principal(organizationId, userId);
    if (!p || !isManager(p)) return { skipped: true };
    // The last 7 complete days before the digest day.
    const to = DateTime.fromISO(week, { zone: 'UTC' }).minus({ days: 1 }).toISODate()!;
    const from = DateTime.fromISO(to, { zone: 'UTC' }).minus({ days: 6 }).toISODate()!;
    const r = await this.insights.compute(p, { from, to });
    const brief = await this.assistant.brief(p, {
      period: r.period,
      previous: r.previous,
      headline: r.headline,
      insights: r.insights.map((i) => ({
        severity: i.severity,
        title: i.title,
        evidence: i.evidence,
        action: i.action,
      })),
    });
    const top = r.insights.slice(0, 3).map((i) => i.title);
    const title = r.insights.length
      ? `Weekly insights: ${r.insights.length} to look at${r.counts.high ? ` (${r.counts.high} high)` : ''}`
      : 'Weekly insights: nothing needs attention';
    await this.db.tenant(organizationId, (tx) =>
      this.notifications.create(tx, {
        organizationId,
        userId,
        type: 'INSIGHTS_DIGEST',
        title,
        body: top.length
          ? top.join(' · ')
          : `${r.headline.leadsCreated} new leads, ${r.headline.admissions} admissions.`,
        link: '/insights',
        dedupKey: `insights.digest:${userId}:${week}`,
        now: this.clock.now(),
      }),
    );
    const h = r.headline;
    const lines = [
      `Hello ${p.name},`,
      '',
      `Your weekly insights for ${from} to ${to} (compared with ${r.previous.from} to ${r.previous.to}):`,
      '',
      `New leads: ${h.leadsCreated} · Contact rate: ${h.contactRatePct ?? '–'}% · First response on time: ${h.firstResponsePct ?? '–'}% · Admissions: ${h.admissions} (previous ${h.previousAdmissions}) · Overdue tasks: ${h.overdueTasks}`,
      '',
      ...(brief ? ['Summary (written by AI from these figures):', brief, ''] : []),
      ...(r.insights.length
        ? r.insights.flatMap((i) => [
            `[${i.severity}] ${i.title}`,
            `  ${i.detail}`,
            `  Suggested: ${i.action}`,
            '',
          ])
        : ['Nothing needs attention this week.', '']),
      `Open the CRM: ${this.config.WEB_ORIGIN}/insights`,
    ];
    try {
      await this.mail.send({ to: p.email, subject: title, text: lines.join('\n') });
    } catch (e) {
      // The in-app notification (and push) already went out; a retry would not duplicate it.
      this.logger.warn({ err: e, userId }, 'Digest e-mail failed');
    }
    return { insights: r.insights.length, brief: !!brief };
  }
}
