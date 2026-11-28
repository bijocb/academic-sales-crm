import { Injectable, OnModuleInit } from '@nestjs/common';
import type { MessageStatus, MessageTemplate } from '@prisma/client';
import {
  ContactPreferenceSchema,
  LogCallSchema,
  MESSAGE_CHANNELS,
  QuickSendSchema,
  renderTemplate,
  SendMessageSchema,
  TEMPLATE_CATEGORIES,
  z,
} from '@crm/contracts';
import { NotificationsService } from '../allocation/notifications.service';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { JobRow, JobsService } from '../jobs/jobs.service';
import { LeadsService } from '../leads/leads.service';
import { MailService } from '../mail/mail.service';
import { SlaClockService } from '../work/sla-clock.service';
import { recordActivity } from './activity-writer';
import { templateVars } from './message-vars';

type Channel = (typeof MESSAGE_CHANNELS)[number];
interface Prepared {
  ok: true;
  channel: Channel;
  body: string;
  subject: string | null;
  recipient: string;
  provider: string;
  template: MessageTemplate | null;
}
interface Problem {
  ok: false;
  code: string;
  message: string;
}
import { closeRecoveryOnOptOut } from '../recovery/recovery-hooks';
import { ProviderError, ProviderRegistry } from './providers';

const RANK: Record<MessageStatus, number> = {
  QUEUED: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  FAILED: -1,
};
const STOP_WORDS = /^\s*(stop|unsubscribe|opt[\s-]?out|stop all)\s*$/i;
const WORKABLE = ['OPEN', 'ON_HOLD', 'IN_RECOVERY'];

/** Calls, WhatsApp, email and contact preferences (FR-010). See docs/plans/PHASE-08.md. */
@Injectable()
export class EngagementService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly leads: LeadsService,
    private readonly sla: SlaClockService,
    private readonly jobs: JobsService,
    private readonly providers: ProviderRegistry,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('message.send', (j) => this.deliver(j));
  }

  providersStatus() {
    return {
      sandbox: this.providers.sandbox,
      whatsapp: this.providers.whatsapp?.name ?? null,
      telephony: this.providers.telephony?.name ?? null,
      email: 'smtp',
      callRecording: false,
    };
  }

  private async editableLead(tx: Tx, p: OrgPrincipal, leadId: string) {
    const lead = await this.leads.visibleLead(tx, p, leadId);
    if (!this.leads.canEdit(p, lead.brandId)) throw forbidden();
    return lead;
  }

  // ------------------------------------------------------------------ calls
  logCall(p: OrgPrincipal, leadId: string, input: z.infer<typeof LogCallSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.editableLead(tx, p, leadId);
      const startedAt = new Date(input.startedAt);
      if (startedAt.getTime() > now.getTime() + 5 * 60_000)
        throw badRequest('CALL_IN_FUTURE', 'A call cannot start in the future');
      const activity = await recordActivity(tx, {
        lead,
        type: 'CALL',
        direction: input.direction,
        actorUserId: p.userId,
        now,
        startedAt,
        durationSec: input.durationSec ?? null,
        outcome: input.outcome,
        body: input.notes ?? null,
        provider: input.providerRef ? (this.providers.telephony?.name ?? 'manual') : 'manual',
        providerRef: input.providerRef ?? null,
      });
      // A-011: an outbound call attempt is the first response.
      const resolved =
        input.direction === 'OUTBOUND'
          ? await this.sla.resolve(tx, leadId, {
              resolution: input.outcome,
              byUserId: p.userId,
              now,
            })
          : null;
      return { activity, slaResolved: !!resolved, doNotContact: lead.person.doNotContact };
    });
  }

  dial(p: OrgPrincipal, leadId: string) {
    const telephony = this.providers.telephony;
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.editableLead(tx, p, leadId);
      if (!telephony)
        throw conflict(
          'TELEPHONY_NOT_CONFIGURED',
          'Click-to-call is not set up yet — log the call manually.',
        );
      if (!lead.person.phoneE164) throw badRequest('NO_PHONE', 'This person has no phone number');
      const me = await tx.user.findUniqueOrThrow({
        where: { id: p.userId },
        select: { phone: true },
      });
      try {
        const r = await telephony.dial({
          agentPhone: me.phone,
          customerPhone: lead.person.phoneE164,
          clientRef: `${leadId}:${p.userId}`,
        });
        return {
          provider: telephony.name,
          providerRef: r.providerRef,
          doNotContact: lead.person.doNotContact,
        };
      } catch (e) {
        throw conflict(
          'TELEPHONY_FAILED',
          e instanceof Error ? e.message : 'The call could not be placed',
        );
      }
    });
  }

  // --------------------------------------------------------------- messages
  /**
   * Everything that must hold before one message goes out on one channel. Returns the rendered message, or the
   * reason it cannot be sent (shown in the quick-message preview; thrown by a single send).
   */
  private async prepare(
    tx: Tx,
    lead: Awaited<ReturnType<EngagementService['editableLead']>>,
    channel: Channel,
    template: MessageTemplate | null,
    input: { subject?: string; body?: string },
    vars: Record<string, string | undefined>,
  ): Promise<Prepared | Problem> {
    const no = (code: string, message: string): Problem => ({ ok: false, code, message });
    if (lead.person.doNotContact) return no('OPTED_OUT', 'This person asked not to be contacted');
    // Students (CONVERTED) still receive fee and follow-up messages (A-049); closed or merged leads do not.
    if (!WORKABLE.includes(lead.status) && lead.status !== 'LOST' && lead.status !== 'CONVERTED')
      return no('LEAD_NOT_ACTIVE', 'Messages can only be sent on active leads and students');
    if (template && template.status !== 'APPROVED')
      return no('TEMPLATE_NOT_APPROVED', 'Only approved templates can be sent');
    let provider: string;
    let recipient: string | null;
    if (channel === 'WHATSAPP' || channel === 'SMS') {
      const p = channel === 'WHATSAPP' ? this.providers.whatsapp : this.providers.sms;
      if (!p)
        return no(
          `${channel}_NOT_CONFIGURED`,
          `${channel === 'WHATSAPP' ? 'WhatsApp' : 'SMS'} is not connected yet (no approved provider).`,
        );
      // ASSUMED (A-034, A-049): business-initiated WhatsApp and SMS always use an approved (registered) template.
      if (!template)
        return no(
          'TEMPLATE_REQUIRED',
          `${channel === 'WHATSAPP' ? 'WhatsApp' : 'SMS'} messages must use an approved template`,
        );
      provider = p.name;
      recipient = lead.person.phoneE164;
      if (!recipient) return no('NO_PHONE', 'This person has no phone number');
    } else {
      provider = 'smtp';
      recipient = lead.person.email;
      if (!recipient) return no('NO_EMAIL', 'This person has no email address');
    }
    const body = renderTemplate(template?.body ?? input.body!, vars);
    const subjectSrc = input.subject ?? template?.subject ?? null;
    const subject = subjectSrc ? renderTemplate(subjectSrc, vars) : null;
    const missing = [
      ...new Set(
        [...(body + (subject ?? '')).matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]),
      ),
    ];
    if (missing.length)
      return no(
        'TEMPLATE_INCOMPLETE',
        `Not known for this lead yet: ${missing.map((m) => m.replace(/_/g, ' ')).join(', ')}`,
      );
    if (channel === 'EMAIL' && !subject) return no('SUBJECT_REQUIRED', 'An email needs a subject');
    return { ok: true, channel, body, subject, recipient, provider, template };
  }

  /** Records the activity and queues delivery of a prepared message (job `message.send`). */
  private async queue(
    tx: Tx,
    p: OrgPrincipal,
    lead: Awaited<ReturnType<EngagementService['editableLead']>>,
    m: Prepared,
    now: Date,
  ) {
    const activity = await recordActivity(tx, {
      lead,
      type: m.channel,
      direction: 'OUTBOUND',
      actorUserId: p.userId,
      now,
      subject: m.subject,
      body: m.body,
      templateId: m.template?.id ?? null,
      provider: m.provider,
    });
    const message = await tx.outboundMessage.create({
      data: {
        organizationId: lead.organizationId,
        brandId: lead.brandId,
        leadId: lead.id,
        activityId: activity.id,
        channel: m.channel,
        recipient: m.recipient,
        provider: m.provider,
        senderUserId: p.userId,
        createdAt: now,
      },
    });
    await this.event(tx, message, 'QUEUED', 'QUEUED', null, now);
    await this.jobs.enqueue(tx, {
      organizationId: lead.organizationId,
      type: 'message.send',
      key: `msg:${message.id}`,
      payload: {
        messageId: message.id,
        templateName: m.template?.providerTemplateName ?? m.template?.name ?? null,
        language: m.template?.language ?? 'en',
      },
      runAt: now,
      maxAttempts: 4,
    });
    return { activity, message };
  }

  send(p: OrgPrincipal, leadId: string, input: z.infer<typeof SendMessageSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.editableLead(tx, p, leadId);
      const template = input.templateId
        ? await tx.messageTemplate.findFirst({
            where: { id: input.templateId, brandId: lead.brandId, channel: input.channel },
          })
        : null;
      if (input.templateId && !template) throw notFound('Template');
      const r = await this.prepare(
        tx,
        lead,
        input.channel,
        template,
        input,
        await templateVars(tx, lead, now, p.userId),
      );
      if (!r.ok)
        throw r.code.endsWith('NOT_CONFIGURED') || r.code === 'OPTED_OUT'
          ? conflict(r.code, r.message)
          : badRequest(r.code, r.message);
      return this.queue(tx, p, lead, r, now);
    });
  }

  /** The situation's approved template per channel, in the person's language when one exists. */
  private async quickTemplates(tx: Tx, brandId: string, category: string, language: string | null) {
    const all = await tx.messageTemplate.findMany({
      where: { brandId, category, status: 'APPROVED' },
      orderBy: { name: 'asc' },
    });
    return Object.fromEntries(
      MESSAGE_CHANNELS.map((c) => {
        const forChannel = all.filter((t) => t.channel === c);
        return [
          c,
          forChannel.find((t) => t.language === language) ??
            forChannel.find((t) => t.language === 'en') ??
            forChannel[0] ??
            null,
        ];
      }),
    ) as Record<Channel, MessageTemplate | null>;
  }

  /** What one click would send for a situation: per channel, the rendered message or why it cannot go. */
  quickPreview(p: OrgPrincipal, leadId: string, category: (typeof TEMPLATE_CATEGORIES)[number]) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.editableLead(tx, p, leadId);
      const templates = await this.quickTemplates(tx, lead.brandId, category, lead.person.language);
      const vars = await templateVars(tx, lead, now, p.userId);
      const channels = [];
      for (const c of MESSAGE_CHANNELS) {
        const t = templates[c];
        const r = t
          ? await this.prepare(tx, lead, c, t, {}, vars)
          : ({
              ok: false,
              code: 'NO_TEMPLATE',
              message: 'No approved template for this situation',
            } as Problem);
        channels.push(
          r.ok
            ? {
                channel: c,
                ready: true,
                template: t!.name,
                recipient: r.recipient,
                subject: r.subject,
                body: r.body,
              }
            : {
                channel: c,
                ready: false,
                template: t?.name ?? null,
                code: r.code,
                reason: r.message,
              },
        );
      }
      return { category, channels };
    });
  }

  /** One click: queue the situation's template on every chosen channel that is ready; report the rest. */
  quickSend(p: OrgPrincipal, leadId: string, input: z.infer<typeof QuickSendSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.editableLead(tx, p, leadId);
      const templates = await this.quickTemplates(
        tx,
        lead.brandId,
        input.category,
        lead.person.language,
      );
      const vars = await templateVars(tx, lead, now, p.userId);
      const results = [];
      for (const c of [...new Set(input.channels)]) {
        const t = templates[c];
        if (!t) {
          results.push({
            channel: c,
            sent: false,
            reason: 'No approved template for this situation',
          });
          continue;
        }
        const r = await this.prepare(tx, lead, c, t, {}, vars);
        if (!r.ok) {
          results.push({ channel: c, sent: false, reason: r.message });
          continue;
        }
        const q = await this.queue(tx, p, lead, r, now);
        results.push({ channel: c, sent: true, messageId: q.message.id, template: t.name });
      }
      if (!results.some((r) => r.sent))
        throw badRequest(
          'NOTHING_SENT',
          results.map((r) => `${r.channel}: ${r.reason}`).join(' · '),
        );
      return { category: input.category, results };
    });
  }

  messages(p: OrgPrincipal, leadId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.leads.visibleLead(tx, p, leadId);
      const items = await tx.outboundMessage.findMany({
        where: { leadId },
        orderBy: { createdAt: 'desc' },
      });
      const events = await tx.messageEvent.findMany({
        where: { messageId: { in: items.map((m) => m.id) } },
        orderBy: { occurredAt: 'asc' },
      });
      return items.map((m) => ({ ...m, events: events.filter((e) => e.messageId === m.id) }));
    });
  }

  /** Background delivery (job `message.send`). */
  async deliver(job: JobRow): Promise<void> {
    const { messageId, templateName, language } = job.payload as {
      messageId: string;
      templateName: string | null;
      language: string;
    };
    const org = job.organizationId!;
    const loaded = await this.db.tenant(org, async (tx) => {
      const m = await tx.outboundMessage.findUnique({ where: { id: messageId } });
      if (!m || m.status !== 'QUEUED') return null;
      const a = await tx.activity.findUniqueOrThrow({ where: { id: m.activityId } });
      return { m, a };
    });
    if (!loaded) return;
    const { m, a } = loaded;
    try {
      let providerRef: string | null = null;
      if (m.channel === 'WHATSAPP') {
        if (!this.providers.whatsapp)
          throw new ProviderError('WhatsApp provider is not configured', true);
        providerRef = (
          await this.providers.whatsapp.send({
            to: m.recipient,
            templateName: templateName ?? 'unknown',
            language,
            body: a.body ?? '',
            clientRef: m.id,
          })
        ).providerRef;
      } else if (m.channel === 'SMS') {
        if (!this.providers.sms) throw new ProviderError('SMS provider is not configured', true);
        providerRef = (
          await this.providers.sms.send({
            to: m.recipient,
            body: a.body ?? '',
            templateName,
            clientRef: m.id,
          })
        ).providerRef;
      } else {
        await this.mail.send({ to: m.recipient, subject: a.subject ?? '', text: a.body ?? '' });
      }
      const now = this.clock.now();
      await this.db.tenant(org, async (tx) => {
        await tx.outboundMessage.update({
          where: { id: m.id },
          data: {
            status: 'SENT',
            providerRef,
            sentAt: now,
            attempts: { increment: 1 },
            lastError: null,
          },
        });
        await this.event(tx, m, 'SENT', 'SENT', providerRef, now);
      });
    } catch (e) {
      const permanent = e instanceof ProviderError && e.permanent;
      const last = job.attempts >= job.maxAttempts;
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      const now = this.clock.now();
      await this.db.tenant(org, async (tx) => {
        if (permanent || last) {
          await tx.outboundMessage.update({
            where: { id: m.id },
            data: {
              status: 'FAILED',
              failedAt: now,
              lastError: detail,
              attempts: { increment: 1 },
            },
          });
          await this.event(tx, m, 'FAILED', 'FAILED', detail, now);
          if (m.senderUserId)
            await this.notifications.create(tx, {
              organizationId: org,
              userId: m.senderUserId,
              type: 'MESSAGE_FAILED',
              title: `${m.channel === 'WHATSAPP' ? 'WhatsApp' : m.channel === 'SMS' ? 'SMS' : 'Email'} not delivered`,
              body: detail,
              link: `/leads/${m.leadId}`,
              dedupKey: `msg-failed:${m.id}`,
              now,
            });
        } else {
          await tx.outboundMessage.update({
            where: { id: m.id },
            data: { lastError: detail, attempts: { increment: 1 } },
          });
          await this.event(tx, m, 'RETRY', null, detail, now);
        }
      });
      if (!permanent) throw e; // temporary: the job queue retries (and dead-letters after the last attempt)
    }
  }

  /** Provider delivery receipt. Status only moves forward; every receipt is kept. */
  async applyReceipt(
    provider: string,
    providerRef: string,
    status: MessageStatus,
    detail?: string,
  ) {
    // Webhooks carry no tenant: find the message's organization first (ids only).
    const found = await this.db.system((tx) =>
      tx.outboundMessage.findUnique({
        where: { provider_providerRef: { provider, providerRef } },
        select: { id: true, organizationId: true },
      }),
    );
    if (!found) return { matched: false };
    const now = this.clock.now();
    return this.db.tenant(found.organizationId, async (tx) => {
      const m = await tx.outboundMessage.findUniqueOrThrow({ where: { id: found.id } });
      const forward =
        status === 'FAILED'
          ? RANK[m.status] >= 0 && RANK[m.status] < RANK.DELIVERED
          : RANK[status] > RANK[m.status];
      await this.event(tx, m, forward ? 'RECEIPT' : 'RECEIPT_IGNORED', status, detail ?? null, now);
      if (forward) {
        await tx.outboundMessage.update({
          where: { id: m.id },
          data: {
            status,
            ...(status === 'DELIVERED' ? { deliveredAt: now } : {}),
            ...(status === 'READ' ? { readAt: now, deliveredAt: m.deliveredAt ?? now } : {}),
            ...(status === 'FAILED'
              ? { failedAt: now, lastError: detail ?? 'Rejected by provider' }
              : {}),
          },
        });
      }
      return { matched: true, applied: forward };
    });
  }

  /** Inbound WhatsApp from a person: logged on their active lead in that brand; STOP opts them out. */
  async inbound(brandId: string, from: string, text: string, providerRef?: string) {
    const brand = await this.db.system((tx) =>
      tx.brand.findUnique({ where: { id: brandId }, select: { organizationId: true } }),
    );
    if (!brand) return { matched: false };
    const now = this.clock.now();
    return this.db.tenant(brand.organizationId, async (tx) => {
      const person = await tx.person.findFirst({ where: { phoneE164: from, mergedIntoId: null } });
      if (!person) return { matched: false };
      const lead = await tx.lead.findFirst({
        where: { personId: person.id, brandId, status: { notIn: ['MERGED'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (lead)
        await recordActivity(tx, {
          lead,
          type: 'WHATSAPP',
          direction: 'INBOUND',
          actorUserId: null,
          now,
          body: text.slice(0, 4000),
          provider: this.providers.whatsapp?.name ?? 'whatsapp',
          providerRef: providerRef ?? null,
        });
      const optOut = STOP_WORDS.test(text);
      if (optOut && !person.doNotContact)
        await this.setDnc(
          tx,
          person.id,
          lead?.id ?? null,
          brand.organizationId,
          lead?.brandId ?? brandId,
          true,
          'Replied STOP on WhatsApp',
          null,
          now,
        );
      if (lead?.ownerId && !optOut)
        await this.notifications.create(tx, {
          organizationId: brand.organizationId,
          userId: lead.ownerId,
          type: 'MESSAGE_RECEIVED',
          title: `WhatsApp from ${person.fullName} (${lead.leadNumber})`,
          body: text.slice(0, 200),
          link: `/leads/${lead.id}`,
          dedupKey: `inbound:${providerRef ?? `${lead.id}:${now.toISOString()}`}`,
          now,
        });
      return { matched: !!lead, optedOut: optOut };
    });
  }

  // ------------------------------------------------------------- opt-out
  setContactPreference(
    p: OrgPrincipal,
    leadId: string,
    input: z.infer<typeof ContactPreferenceSchema>,
  ) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.editableLead(tx, p, leadId);
      await this.setDnc(
        tx,
        lead.personId,
        lead.id,
        lead.organizationId,
        lead.brandId,
        input.doNotContact,
        input.reason,
        p.userId,
        now,
      );
      return { doNotContact: input.doNotContact };
    });
  }

  private async setDnc(
    tx: Tx,
    personId: string,
    leadId: string | null,
    organizationId: string,
    brandId: string,
    doNotContact: boolean,
    reason: string,
    actorUserId: string | null,
    now: Date,
  ) {
    await tx.person.update({
      where: { id: personId },
      data: { doNotContact, doNotContactAt: doNotContact ? now : null },
    });
    if (doNotContact) await closeRecoveryOnOptOut(tx, personId, actorUserId, now);
    if (leadId)
      await tx.leadEvent.create({
        data: {
          organizationId,
          leadId,
          type: doNotContact ? 'OPTED_OUT' : 'OPTED_IN',
          actorUserId,
          body: `${doNotContact ? 'Do not contact' : 'Contact allowed again'} — ${reason}`,
          occurredAt: now,
        },
      });
    await this.audit.record(tx, {
      organizationId,
      brandId,
      actorUserId,
      action: doNotContact ? 'person.opted_out' : 'person.opted_in',
      entityType: 'person',
      entityId: personId,
      after: { doNotContact },
      reason,
    });
  }

  private event(
    tx: Tx,
    m: { id: string; organizationId: string },
    type: string,
    status: string | null,
    detail: string | null,
    now: Date,
  ) {
    return tx.messageEvent.create({
      data: {
        organizationId: m.organizationId,
        messageId: m.id,
        type,
        status,
        detail,
        occurredAt: now,
      },
    });
  }
}
