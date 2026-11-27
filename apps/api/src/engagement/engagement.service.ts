import { Injectable, OnModuleInit } from '@nestjs/common';
import type { MessageStatus } from '@prisma/client';
import {
  ContactPreferenceSchema,
  LogCallSchema,
  renderTemplate,
  SendMessageSchema,
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
  send(p: OrgPrincipal, leadId: string, input: z.infer<typeof SendMessageSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.editableLead(tx, p, leadId);
      if (!WORKABLE.includes(lead.status) && lead.status !== 'LOST')
        throw badRequest('LEAD_NOT_ACTIVE', 'Messages can only be sent on active leads');
      if (lead.person.doNotContact)
        throw conflict('OPTED_OUT', 'This person asked not to be contacted');

      const template = input.templateId
        ? await tx.messageTemplate.findFirst({
            where: { id: input.templateId, brandId: lead.brandId, channel: input.channel },
          })
        : null;
      if (input.templateId && !template) throw notFound('Template');
      if (template && template.status !== 'APPROVED')
        throw badRequest('TEMPLATE_NOT_APPROVED', 'Only approved templates can be sent');

      let provider: string;
      let recipient: string | null;
      if (input.channel === 'WHATSAPP') {
        if (!this.providers.whatsapp)
          throw conflict(
            'WHATSAPP_NOT_CONFIGURED',
            'WhatsApp is not connected yet (no approved provider).',
          );
        // ASSUMED (A-034): business-initiated WhatsApp messages always use an approved template.
        if (!template)
          throw badRequest('TEMPLATE_REQUIRED', 'WhatsApp messages must use an approved template');
        provider = this.providers.whatsapp.name;
        recipient = lead.person.phoneE164;
        if (!recipient) throw badRequest('NO_PHONE', 'This person has no phone number');
      } else {
        provider = 'smtp';
        recipient = lead.person.email;
        if (!recipient) throw badRequest('NO_EMAIL', 'This person has no email address');
      }

      const [owner, brand] = await Promise.all([
        lead.ownerId
          ? tx.user.findUnique({ where: { id: lead.ownerId }, select: { name: true } })
          : null,
        tx.brand.findUniqueOrThrow({ where: { id: lead.brandId }, select: { name: true } }),
      ]);
      const vars = {
        first_name: lead.person.fullName.split(/\s+/)[0],
        full_name: lead.person.fullName,
        course: lead.course?.name,
        owner_name: owner?.name,
        brand: brand.name,
      };
      const body = renderTemplate(template?.body ?? input.body!, vars);
      const subjectSrc = input.subject ?? template?.subject ?? null;
      const subject = subjectSrc ? renderTemplate(subjectSrc, vars) : null;
      if (/\{\{\s*[a-z_]+\s*\}\}/.test(body + (subject ?? '')))
        throw badRequest(
          'TEMPLATE_INCOMPLETE',
          'Some template fields are empty for this lead (e.g. course)',
        );
      if (input.channel === 'EMAIL' && !subject)
        throw badRequest('SUBJECT_REQUIRED', 'An email needs a subject');

      const activity = await recordActivity(tx, {
        lead,
        type: input.channel,
        direction: 'OUTBOUND',
        actorUserId: p.userId,
        now,
        subject,
        body,
        templateId: template?.id ?? null,
        provider,
      });
      const message = await tx.outboundMessage.create({
        data: {
          organizationId: lead.organizationId,
          brandId: lead.brandId,
          leadId: lead.id,
          activityId: activity.id,
          channel: input.channel,
          recipient,
          provider,
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
          templateName: template?.providerTemplateName ?? template?.name ?? null,
          language: template?.language ?? 'en',
        },
        runAt: now,
        maxAttempts: 4,
      });
      return { activity, message };
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
              title: `${m.channel === 'WHATSAPP' ? 'WhatsApp' : 'Email'} not delivered`,
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
