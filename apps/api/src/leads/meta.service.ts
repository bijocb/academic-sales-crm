import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { MetaConnection } from '@prisma/client';
import { MetaConnectionSchema, UpdateMetaConnectionSchema, z } from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../common/errors';
import { SecretBox } from '../common/secret-box';
import { APP_CONFIG, AppConfig } from '../config';
import { Db, Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { IntakeService } from './intake.service';
import { MetaClient, metaToLead, validMetaSignature } from './meta';

export const SECRET_BOX = Symbol('SECRET_BOX');
/** Development/test only: the sandbox signs webhooks with this when META_APP_SECRET is not set. */
export const SANDBOX_META_APP_SECRET = 'sandbox-meta-app-secret-dev-only';

interface LeadgenChange {
  field?: string;
  value?: { leadgen_id?: string | number; page_id?: string | number; form_id?: string | number };
}

/**
 * Facebook / Instagram Lead Ads (A-047, docs/plans/META-LEAD-ADS.md): page connections, the signed webhook,
 * and the job that fetches each lead from the Graph API and sends it through the normal intake.
 */
@Injectable()
export class MetaService {
  private readonly logger = new Logger('Meta');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly jobs: JobsService,
    private readonly intake: IntakeService,
    private readonly audit: AuditService,
    @Optional() @Inject(MetaClient) private readonly client: MetaClient | null,
    @Optional() @Inject(SECRET_BOX) private readonly box: SecretBox | null,
  ) {
    this.jobs.register('meta.lead', (j) => this.fetchLeadJob(j.organizationId!, j.payload));
  }

  private get appSecret() {
    return (
      this.config.META_APP_SECRET ??
      (this.config.NODE_ENV === 'production' ? undefined : SANDBOX_META_APP_SECRET)
    );
  }

  // ------------------------------------------------------------ connections
  private present(c: MetaConnection) {
    // The token is write-only: never returned.
    const { tokenSealed: _sealed, ...rest } = c;
    void _sealed;
    return { ...rest, tokenSet: true };
  }

  private requireReady() {
    if (!this.client || !this.appSecret)
      throw conflict(
        'META_NOT_CONFIGURED',
        'Meta Lead Ads is not configured on this server (META_APP_SECRET)',
      );
    if (!this.box)
      throw conflict(
        'SECRETS_KEY_MISSING',
        'Token encryption is not configured on this server (SECRETS_KEY)',
      );
    return { client: this.client, box: this.box };
  }

  private assertManage(p: OrgPrincipal, brandId: string) {
    if (!p.authz.can('integration.manage', { brandId })) throw forbidden();
  }

  list(p: OrgPrincipal, brandId: string) {
    this.assertManage(p, brandId);
    return this.db.tenant(p.organizationId, async (tx) =>
      (await tx.metaConnection.findMany({ where: { brandId }, orderBy: { createdAt: 'asc' } })).map(
        (c) => this.present(c),
      ),
    );
  }

  private async checkSource(tx: Tx, brandId: string, sourceId: string) {
    const s = await tx.leadSource.findFirst({ where: { id: sourceId, brandId } });
    if (!s) throw badRequest('INVALID_SOURCE', 'Choose a lead source of this brand');
    return s;
  }

  async create(p: OrgPrincipal, input: z.infer<typeof MetaConnectionSchema>) {
    this.assertManage(p, input.brandId);
    const { client, box } = this.requireReady();
    const now = this.clock.now();
    // Subscribe first: a wrong token or page fails here, before anything is stored.
    try {
      await client.subscribePage(input.pageId, input.accessToken);
    } catch (e) {
      throw badRequest(
        'META_SUBSCRIBE_FAILED',
        `Meta refused the page connection: ${(e as Error).message}`,
      );
    }
    return this.db.tenant(p.organizationId, async (tx) => {
      await this.checkSource(tx, input.brandId, input.sourceId);
      const taken = await this.db.system((sys) =>
        sys.metaConnection.findUnique({ where: { pageId: input.pageId }, select: { id: true } }),
      );
      if (taken)
        throw conflict('PAGE_ALREADY_CONNECTED', 'This Facebook page is already connected');
      const c = await tx.metaConnection.create({
        data: {
          organizationId: p.organizationId,
          brandId: input.brandId,
          sourceId: input.sourceId,
          pageId: input.pageId,
          pageName: input.pageName,
          tokenSealed: box.seal(input.accessToken),
          subscribed: true,
          createdById: p.userId,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: input.brandId,
        actorUserId: p.userId,
        action: 'meta_connection.created',
        entityType: 'meta_connection',
        entityId: c.id,
        after: { pageId: c.pageId, pageName: c.pageName, sourceId: c.sourceId },
      });
      return this.present(c);
    });
  }

  async update(p: OrgPrincipal, id: string, input: z.infer<typeof UpdateMetaConnectionSchema>) {
    const before = await this.db.tenant(p.organizationId, (tx) =>
      tx.metaConnection.findUnique({ where: { id } }),
    );
    if (!before) throw notFound('Meta connection');
    this.assertManage(p, before.brandId);
    let sealed: string | undefined;
    if (input.accessToken) {
      const { client, box } = this.requireReady();
      try {
        await client.subscribePage(before.pageId, input.accessToken);
      } catch (e) {
        throw badRequest(
          'META_SUBSCRIBE_FAILED',
          `Meta refused the new token: ${(e as Error).message}`,
        );
      }
      sealed = box.seal(input.accessToken);
    }
    return this.db.tenant(p.organizationId, async (tx) => {
      if (input.sourceId) await this.checkSource(tx, before.brandId, input.sourceId);
      const c = await tx.metaConnection.update({
        where: { id },
        data: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.pageName ? { pageName: input.pageName } : {}),
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
          ...(sealed
            ? { tokenSealed: sealed, subscribed: true, lastError: null, lastErrorAt: null }
            : {}),
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: before.brandId,
        actorUserId: p.userId,
        action: 'meta_connection.updated',
        entityType: 'meta_connection',
        entityId: id,
        before: { status: before.status, pageName: before.pageName, sourceId: before.sourceId },
        after: {
          status: c.status,
          pageName: c.pageName,
          sourceId: c.sourceId,
          tokenReplaced: !!sealed,
        },
      });
      return this.present(c);
    });
  }

  // ---------------------------------------------------------------- webhook
  /** Meta's subscription check: echo the challenge when the verify token matches. */
  verify(q: Record<string, string | undefined>) {
    const expected =
      this.config.META_VERIFY_TOKEN ??
      (this.config.NODE_ENV === 'production' ? undefined : 'sandbox-verify');
    if (!this.client || !expected) throw new NotFoundException();
    if (q['hub.mode'] !== 'subscribe' || q['hub.verify_token'] !== expected)
      throw unauthorized('INVALID_VERIFY_TOKEN', 'Verify token does not match');
    return q['hub.challenge'] ?? '';
  }

  /** Signed `leadgen` notifications → one idempotent job per lead. Unknown or paused pages are ignored. */
  async receive(raw: Buffer | undefined, signature: string | undefined) {
    const secret = this.appSecret;
    if (!this.client || !secret) throw new NotFoundException();
    if (!validMetaSignature(raw, signature, secret))
      throw unauthorized('INVALID_SIGNATURE', 'Invalid webhook signature');
    let body: { object?: string; entry?: Array<{ id?: string; changes?: LeadgenChange[] }> };
    try {
      body = JSON.parse(raw!.toString('utf8'));
    } catch {
      return { received: 0, ignored: 'Unreadable payload' };
    }
    const changes = (body.entry ?? []).flatMap((e) =>
      (e.changes ?? [])
        .filter((c) => c.field === 'leadgen' && c.value?.leadgen_id)
        .map((c) => ({
          leadgenId: String(c.value!.leadgen_id),
          pageId: String(c.value!.page_id ?? e.id ?? ''),
        })),
    );
    let queued = 0;
    const now = this.clock.now();
    for (const ch of changes) {
      // Cross-organization lookup by page id only (the page decides the organization), like payment webhooks.
      const conn = await this.db.system((tx) =>
        tx.metaConnection.findUnique({
          where: { pageId: ch.pageId },
          select: { id: true, organizationId: true, status: true },
        }),
      );
      if (!conn || conn.status !== 'ACTIVE') continue;
      await this.db.tenant(conn.organizationId, (tx) =>
        this.jobs.enqueue(tx, {
          organizationId: conn.organizationId,
          type: 'meta.lead',
          key: `meta.lead:${ch.leadgenId}`,
          payload: { connectionId: conn.id, leadgenId: ch.leadgenId },
          runAt: now,
        }),
      );
      queued++;
    }
    return { received: changes.length, queued };
  }

  // -------------------------------------------------------------------- job
  /** Fetches the lead from the Graph API and sends it through the normal intake. Errors retry, then dead-letter. */
  private async fetchLeadJob(organizationId: string, payload: unknown) {
    const { connectionId, leadgenId } = payload as { connectionId: string; leadgenId: string };
    const conn = await this.db.tenant(organizationId, (tx) =>
      tx.metaConnection.findUnique({ where: { id: connectionId } }),
    );
    if (!conn || conn.status !== 'ACTIVE') return;
    const { client, box } = this.requireReady();
    try {
      const lead = await client.fetchLead(leadgenId, box.open(conn.tokenSealed));
      const result = await this.intake.ingest(
        {
          organizationId,
          brandId: conn.brandId,
          channel: 'META_ADS',
          sourceId: conn.sourceId,
          dedupKey: `meta:${leadgenId}`,
          exceptionOnInvalid: true,
          extra: {
            metaLeadId: leadgenId,
            metaPageId: conn.pageId,
            metaFormId: lead.form_id,
            metaCampaignId: lead.campaign_id,
            metaPlatform: lead.platform,
          },
        },
        metaToLead(lead),
      );
      await this.db.tenant(organizationId, (tx) =>
        tx.metaConnection.update({
          where: { id: conn.id },
          data: { lastLeadAt: this.clock.now(), lastError: null, lastErrorAt: null },
        }),
      );
      this.logger.log({ leadgenId, outcome: result.outcome }, 'Meta lead ingested');
    } catch (e) {
      await this.db.tenant(organizationId, (tx) =>
        tx.metaConnection.update({
          where: { id: conn.id },
          data: { lastError: (e as Error).message.slice(0, 500), lastErrorAt: this.clock.now() },
        }),
      );
      throw e;
    }
  }
}
