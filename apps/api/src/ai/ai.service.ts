import { Injectable, Logger } from '@nestjs/common';
import type { AiSettings, AiModel, Lead } from '@prisma/client';
import {
  AI_SUGGESTION_KINDS,
  AiSettingsSchema,
  DismissSuggestionSchema,
  ScoreOverrideSchema,
  z,
} from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { LeadsService } from '../leads/leads.service';
import { TaskCoreService } from '../work/task-core.service';
import { extractFeatures, WINDOW_MS } from './features';
import {
  Band,
  bandForProbability,
  bandForRules,
  confidenceFor,
  Contribution,
  MODEL_RULES_VERSION,
  ModelStats,
  modelVersion,
  predict,
  rules,
  train,
  usable,
} from './scoring';

type Kind = (typeof AI_SUGGESTION_KINDS)[number];
const DAY = 86_400_000;
/** History used for calibration (ASSUMED, A-045). */
const TRAINING_DAYS = 365;
const DISMISS_DAYS = 7;
const RESCORE_LIMIT = 500;
const RANK: Record<Band, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

export interface ScoreResult {
  method: 'MODEL' | 'RULES';
  modelId: string | null;
  modelVersion: string;
  score: number;
  band: Band;
  probabilityBp: number | null;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Model only: log-odds of the brand's base rate; prior + Σ factor weights = the prediction's log-odds. */
  prior: number | null;
  factors: Contribution[];
  basis: { sampleSize: number; conversions: number; trainedAt: Date } | null;
  /** Why the rules were used instead of a model. */
  fallbackReason: string | null;
}

export interface Suggestion {
  kind: Kind;
  title: string;
  reason: string;
  needsApproval: boolean;
  courseId?: string;
}

/**
 * AI assistance (FR-006, FR-021, A-045): explainable, in-house, advisory. No data leaves the CRM.
 * See docs/plans/PHASE-14.md and docs/AI-REVIEW.md.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger('AI');
  /** Test hook: simulates a model outage. */
  failScoring = false;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly leads: LeadsService,
    private readonly tasks: TaskCoreService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {
    this.jobs.register('ai.train', (j) => this.trainJob(j.organizationId!, j.payload));
    this.jobs.register('ai.rescore', (j) => this.rescoreJob(j.organizationId!, j.payload));
  }

  // ------------------------------------------------------------ settings
  private settingsTx(tx: Tx, brandId: string) {
    return tx.aiSettings.findUnique({ where: { brandId } });
  }

  getSettings(p: OrgPrincipal, brandId: string) {
    if (!p.authz.can('settings.manage', { brandId }) && !p.authz.can('report.read', { brandId }))
      throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      const s = await this.settingsTx(tx, brandId);
      if (!s) throw notFound('Brand');
      const model = await this.latestModel(tx, brandId);
      return { ...s, model: model ? this.presentModel(model) : null };
    });
  }

  updateSettings(p: OrgPrincipal, brandId: string, input: z.infer<typeof AiSettingsSchema>) {
    if (!p.authz.can('settings.manage', { brandId })) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await this.settingsTx(tx, brandId);
      if (!before) throw notFound('Brand');
      const after = await tx.aiSettings.update({
        where: { brandId },
        data: { ...input, updatedById: p.userId },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId,
        actorUserId: p.userId,
        action: 'ai_settings.updated',
        entityType: 'ai_settings',
        entityId: after.id,
        before: this.pick(before),
        after: this.pick(after),
      });
      return after;
    });
  }

  private pick(s: AiSettings) {
    const { enabled, scoringEnabled, nextActionsEnabled, highThresholdBp, mediumThresholdBp } = s;
    return {
      enabled,
      scoringEnabled,
      nextActionsEnabled,
      highThresholdBp,
      mediumThresholdBp,
      minTrainingSize: s.minTrainingSize,
    };
  }

  // -------------------------------------------------------------- models
  private latestModel(tx: Tx, brandId: string) {
    return tx.aiModel.findFirst({ where: { brandId }, orderBy: { version: 'desc' } });
  }

  private presentModel(m: AiModel) {
    return {
      id: m.id,
      version: modelVersion(m.version),
      sampleSize: m.sampleSize,
      conversions: m.positives,
      usable: m.usable,
      trainedAt: m.trainedAt,
    };
  }

  listModels(p: OrgPrincipal, brandId: string) {
    if (!p.authz.can('settings.manage', { brandId })) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) =>
      (
        await tx.aiModel.findMany({ where: { brandId }, orderBy: { version: 'desc' }, take: 20 })
      ).map((m) => this.presentModel(m)),
    );
  }

  /** Calibrates a new model version on the brand's decided leads (converted vs lost) of the last year. */
  async trainInTx(tx: Tx, organizationId: string, brandId: string) {
    const now = this.clock.now();
    const settings = await this.settingsTx(tx, brandId);
    if (!settings) throw notFound('Brand');
    const decided = await tx.lead.findMany({
      where: {
        brandId,
        status: { in: ['CONVERTED', 'LOST', 'CLOSED_LOST'] },
        createdAt: {
          gte: new Date(now.getTime() - TRAINING_DAYS * DAY),
          lte: new Date(now.getTime() - WINDOW_MS),
        },
      },
      select: { id: true, status: true },
    });
    const features = await extractFeatures(
      tx,
      decided.map((l) => l.id),
    );
    const stats = train(
      decided
        .filter((l) => features.has(l.id))
        .map((l) => ({ features: features.get(l.id)!, converted: l.status === 'CONVERTED' })),
    );
    const last = await this.latestModel(tx, brandId);
    return tx.aiModel.create({
      data: {
        organizationId,
        brandId,
        version: (last?.version ?? 0) + 1,
        sampleSize: stats.n,
        positives: stats.positives,
        usable: usable(stats, settings.minTrainingSize),
        stats: JSON.parse(JSON.stringify(stats)),
        trainedAt: now,
      },
    });
  }

  trainNow(p: OrgPrincipal, brandId: string) {
    if (!p.authz.can('settings.manage', { brandId })) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      const m = await this.trainInTx(tx, p.organizationId, brandId);
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId,
        actorUserId: p.userId,
        action: 'ai_model.trained',
        entityType: 'ai_model',
        entityId: m.id,
        after: { version: m.version, sampleSize: m.sampleSize, usable: m.usable },
      });
      return this.presentModel(m);
    });
  }

  // ------------------------------------------------------------- scoring
  /** Scores one lead: the calibrated model when usable, otherwise the labelled rules (never throws for "no model"). */
  async compute(tx: Tx, lead: Pick<Lead, 'id' | 'brandId'>, s: AiSettings): Promise<ScoreResult> {
    if (this.failScoring) throw new Error('Simulated model outage');
    const f = (await extractFeatures(tx, [lead.id])).get(lead.id);
    if (!f) throw new Error('Lead not found for scoring');
    const model = await this.latestModel(tx, lead.brandId);
    if (model?.usable) {
      const stats = model.stats as unknown as ModelStats;
      const pr = predict(stats, f);
      return {
        method: 'MODEL',
        modelId: model.id,
        modelVersion: modelVersion(model.version),
        score: Math.round(pr.probability * 100),
        band: bandForProbability(pr.probability, s.highThresholdBp, s.mediumThresholdBp),
        probabilityBp: Math.round(pr.probability * 10000),
        confidence: confidenceFor(model.sampleSize),
        prior: pr.prior,
        factors: pr.contributions,
        basis: {
          sampleSize: model.sampleSize,
          conversions: model.positives,
          trainedAt: model.trainedAt,
        },
        fallbackReason: null,
      };
    }
    const r = rules(f);
    return {
      method: 'RULES',
      modelId: null,
      modelVersion: MODEL_RULES_VERSION,
      score: r.score,
      band: bandForRules(r.score),
      probabilityBp: null,
      confidence: 'LOW',
      prior: null,
      factors: r.contributions,
      basis: null,
      fallbackReason: model
        ? `Not enough decided leads to calibrate (${model.sampleSize} of ${s.minTrainingSize} needed, with at least 5 conversions and 5 losses)`
        : 'No model has been trained for this brand yet',
    };
  }

  /** Stores the result when it changed and refreshes the lead's effective priority. */
  private async persist(
    tx: Tx,
    lead: Pick<Lead, 'id' | 'brandId' | 'organizationId'>,
    r: ScoreResult,
  ) {
    const last = await tx.leadScore.findFirst({
      where: { leadId: lead.id },
      orderBy: { computedAt: 'desc' },
    });
    const same =
      last &&
      last.score === r.score &&
      last.band === r.band &&
      last.modelVersion === r.modelVersion &&
      last.probabilityBp === r.probabilityBp;
    const row = same
      ? last
      : await tx.leadScore.create({
          data: {
            organizationId: lead.organizationId,
            brandId: lead.brandId,
            leadId: lead.id,
            modelId: r.modelId,
            modelVersion: r.modelVersion,
            method: r.method,
            score: r.score,
            band: r.band,
            probabilityBp: r.probabilityBp,
            confidence: r.confidence,
            factors: JSON.parse(JSON.stringify(r.factors)),
            computedAt: this.clock.now(),
          },
        });
    const override = await this.latestOverride(tx, lead.id);
    await tx.lead.update({
      where: { id: lead.id },
      data: {
        priorityBand: override?.band ?? r.band,
        priorityRank: RANK[(override?.band ?? r.band) as Band],
        priorityScore: r.score,
      },
    });
    return row;
  }

  private latestOverride(tx: Tx, leadId: string) {
    return tx.leadScoreOverride.findFirst({ where: { leadId }, orderBy: { createdAt: 'desc' } });
  }

  /** The lead page panel. Never fails the page: outages degrade to the rules, then to "unavailable". */
  forLead(p: OrgPrincipal, leadId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      const s = await this.settingsTx(tx, lead.brandId);
      if (!s?.enabled) return { enabled: false as const };
      let score: (ScoreResult & { degraded: boolean }) | null = null;
      let unavailable: string | null = null;
      if (s.scoringEnabled) {
        try {
          score = { ...(await this.compute(tx, lead, s)), degraded: false };
        } catch (e) {
          this.logger.warn({ err: e, leadId }, 'Scoring failed; using rules');
          try {
            const f = (await extractFeatures(tx, [lead.id])).get(lead.id)!;
            const r = rules(f);
            score = {
              method: 'RULES',
              modelId: null,
              modelVersion: MODEL_RULES_VERSION,
              score: r.score,
              band: bandForRules(r.score),
              probabilityBp: null,
              confidence: 'LOW',
              prior: null,
              factors: r.contributions,
              basis: null,
              fallbackReason: 'The scoring model is unavailable right now',
              degraded: true,
            };
          } catch {
            unavailable = 'AI assistance is unavailable right now; work the lead as usual.';
          }
        }
        if (score) await this.persist(tx, lead, score);
      }
      const override = await this.latestOverride(tx, lead.id);
      const overrideBy = override
        ? await tx.user.findUnique({ where: { id: override.createdById }, select: { name: true } })
        : null;
      const suggestions =
        s.nextActionsEnabled && !unavailable ? await this.suggestions(tx, lead) : [];
      return {
        enabled: true as const,
        advisory:
          'Advisory only: a priority estimate from past outcomes of this brand, not a guarantee. People decide.',
        score,
        unavailable,
        override: override
          ? {
              band: override.band,
              reason: override.reason,
              by: overrideBy?.name ?? null,
              at: override.createdAt,
            }
          : null,
        effectiveBand: override?.band ?? score?.band ?? null,
        canOverride: this.leads.canEdit(p, lead.brandId),
        suggestions,
      };
    });
  }

  override(p: OrgPrincipal, leadId: string, input: z.infer<typeof ScoreOverrideSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      if (!this.leads.canEdit(p, lead.brandId)) throw forbidden();
      const s = await this.settingsTx(tx, lead.brandId);
      if (!s?.enabled)
        throw badRequest('AI_DISABLED', 'AI assistance is switched off for this brand');
      const last = await tx.leadScore.findFirst({
        where: { leadId },
        orderBy: { computedAt: 'desc' },
      });
      const o = await tx.leadScoreOverride.create({
        data: {
          organizationId: p.organizationId,
          leadId,
          scoreId: last?.id ?? null,
          band: input.band,
          reason: input.reason,
          createdById: p.userId,
          createdAt: this.clock.now(),
        },
      });
      await tx.lead.update({
        where: { id: leadId },
        data: { priorityBand: input.band, priorityRank: RANK[input.band] },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId: lead.brandId,
        actorUserId: p.userId,
        action: 'lead_priority.overridden',
        entityType: 'lead',
        entityId: leadId,
        before: { band: lead.priorityBand, score: last?.band ?? null },
        after: { band: input.band, reason: input.reason },
      });
      return o;
    });
  }

  // ---------------------------------------------------------- suggestions
  private async suggestions(tx: Tx, lead: Lead): Promise<Suggestion[]> {
    if (lead.status !== 'OPEN' || !lead.ownerId) return [];
    const now = this.clock.now();
    const [calls, openTasks, appts, quotes, dismissed] = await Promise.all([
      tx.activity.findMany({
        where: { leadId: lead.id, type: 'CALL', outcome: 'CONNECTED' },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
      tx.task.findMany({
        where: { leadId: lead.id, status: 'OPEN' },
        select: { type: true, title: true },
      }),
      tx.appointment.findMany({
        where: { leadId: lead.id },
        select: { status: true, startsAt: true },
      }),
      tx.quotation.findMany({ where: { leadId: lead.id }, select: { status: true } }),
      tx.aiSuggestionEvent.findMany({
        where: {
          leadId: lead.id,
          action: 'DISMISSED',
          createdAt: { gte: new Date(now.getTime() - DISMISS_DAYS * DAY) },
        },
        select: { kind: true },
      }),
    ]);
    const hidden = new Set(dismissed.map((d) => d.kind));
    const has = (...types: string[]) => openTasks.some((t) => types.includes(t.type));
    const out: Suggestion[] = [];
    const connected = calls.length > 0;
    if (!connected && !has('FIRST_CALL', 'CALL_BACK'))
      out.push({
        kind: 'FIRST_CALL',
        title: 'Call the lead',
        reason: 'No connected call yet and no call is planned.',
        needsApproval: false,
      });
    const days = connected ? Math.floor((now.getTime() - calls[0].occurredAt.getTime()) / DAY) : 0;
    if (connected && days >= 3 && openTasks.length === 0)
      out.push({
        kind: 'CALL_BACK',
        title: 'Plan a follow-up call',
        reason: `Last connected call ${days} days ago and nothing is planned.`,
        needsApproval: false,
      });
    const counselled = appts.some((a) => a.status === 'COMPLETED');
    const upcoming = appts.some((a) => a.status === 'SCHEDULED' && a.startsAt >= now);
    if (
      connected &&
      !counselled &&
      !upcoming &&
      ['NEW_ENQUIRY', 'CONTACTED', 'QUALIFIED', 'INTERESTED'].includes(lead.stage) &&
      !has('COUNSELLING')
    )
      out.push({
        kind: 'BOOK_COUNSELLING',
        title: 'Book a counselling session',
        reason: 'The lead has been reached but has no counselling session booked.',
        needsApproval: false,
      });
    if (
      counselled &&
      !quotes.some((q) => q.status === 'OPEN' || q.status === 'ACCEPTED') &&
      !openTasks.some((t) => t.type === 'CUSTOM' && t.title === 'Send a quotation')
    )
      out.push({
        kind: 'SEND_QUOTATION',
        title: 'Send a quotation',
        reason: 'Counselling is completed but no quotation is open.',
        needsApproval: false,
      });
    if (!lead.courseId) {
      const c = await this.courseHint(tx, lead);
      if (c) out.push(c);
    }
    return out.filter((s) => !hidden.has(s.kind));
  }

  /** Course most often joined by converted leads from the same first-touch source (needs human approval). */
  private async courseHint(tx: Tx, lead: Lead): Promise<Suggestion | null> {
    const first = await tx.enquiry.findFirst({
      where: { leadId: lead.id },
      orderBy: { receivedAt: 'asc' },
      select: { sourceId: true },
    });
    if (!first?.sourceId) return null;
    const since = new Date(this.clock.now().getTime() - TRAINING_DAYS * DAY);
    const rows = await tx.$queryRaw<Array<{ course_id: string; n: bigint; total: bigint }>>`
      WITH firsts AS (
        SELECT DISTINCT ON (e.lead_id) e.lead_id, e.source_id FROM enquiries e
        JOIN leads l ON l.id = e.lead_id
        WHERE l.brand_id = ${lead.brandId}::uuid AND l.status = 'CONVERTED' AND l.course_id IS NOT NULL
          AND l.created_at >= ${since}
        ORDER BY e.lead_id, e.received_at ASC)
      SELECT l.course_id, count(*) AS n, sum(count(*)) OVER () AS total
      FROM firsts f JOIN leads l ON l.id = f.lead_id
      WHERE f.source_id = ${first.sourceId}::uuid
      GROUP BY l.course_id ORDER BY n DESC, l.course_id LIMIT 1`;
    const top = rows[0];
    if (!top || Number(top.n) < 5) return null;
    const course = await tx.course.findFirst({
      where: { id: top.course_id, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    if (!course) return null;
    return {
      kind: 'SUGGEST_COURSE',
      title: `Suggest course: ${course.name}`,
      reason: `${top.n} of ${top.total} students who joined from the same source chose this course. Confirm it fits this student before approving.`,
      needsApproval: true,
      courseId: course.id,
    };
  }

  accept(p: OrgPrincipal, leadId: string, kind: Kind) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      if (!this.leads.canEdit(p, lead.brandId)) throw forbidden();
      const s = await this.settingsTx(tx, lead.brandId);
      if (!s?.enabled || !s.nextActionsEnabled)
        throw badRequest('AI_DISABLED', 'Next-best actions are switched off for this brand');
      const sug = (await this.suggestions(tx, lead)).find((x) => x.kind === kind);
      if (!sug) throw badRequest('SUGGESTION_NOT_AVAILABLE', 'This suggestion no longer applies');
      let detail: Record<string, unknown>;
      if (kind === 'SUGGEST_COURSE') {
        await tx.lead.update({ where: { id: leadId }, data: { courseId: sug.courseId } });
        await tx.leadEvent.create({
          data: {
            organizationId: p.organizationId,
            leadId,
            type: 'COURSE_SET',
            actorUserId: p.userId,
            body: `${sug.title.replace('Suggest course: ', 'Course set to ')} (AI suggestion approved)`,
            data: { courseId: sug.courseId, source: 'AI_SUGGESTION' },
            occurredAt: now,
          },
        });
        await this.audit.record(tx, {
          organizationId: p.organizationId,
          brandId: lead.brandId,
          actorUserId: p.userId,
          action: 'ai_suggestion.course_approved',
          entityType: 'lead',
          entityId: leadId,
          before: { courseId: lead.courseId },
          after: { courseId: sug.courseId },
        });
        detail = { courseId: sug.courseId };
      } else {
        const type = {
          FIRST_CALL: 'FIRST_CALL',
          CALL_BACK: 'CALL_BACK',
          BOOK_COUNSELLING: 'COUNSELLING',
          SEND_QUOTATION: 'CUSTOM',
        }[kind] as 'FIRST_CALL' | 'CALL_BACK' | 'COUNSELLING' | 'CUSTOM';
        const task = await this.tasks.create(tx, {
          lead: lead,
          ownerId: lead.ownerId!,
          input: {
            type,
            title: sug.title,
            dueAt: now.toISOString(),
            priority: lead.priorityBand === 'HIGH' ? 'HIGH' : 'NORMAL',
            notes: `Suggested by AI assistance: ${sug.reason}`,
          },
          createdById: p.userId,
          now,
          notifyOwner: lead.ownerId !== p.userId,
        });
        detail = { taskId: task.id };
      }
      await tx.aiSuggestionEvent.create({
        data: {
          organizationId: p.organizationId,
          leadId,
          kind,
          action: 'ACCEPTED',
          detail: JSON.parse(JSON.stringify(detail)),
          createdById: p.userId,
          createdAt: now,
        },
      });
      return { kind, ...detail };
    });
  }

  dismiss(
    p: OrgPrincipal,
    leadId: string,
    kind: Kind,
    input: z.infer<typeof DismissSuggestionSchema>,
  ) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const lead = await this.leads.visibleLead(tx, p, leadId);
      if (!this.leads.canEdit(p, lead.brandId)) throw forbidden();
      return tx.aiSuggestionEvent.create({
        data: {
          organizationId: p.organizationId,
          leadId,
          kind,
          action: 'DISMISSED',
          reason: input.reason ?? null,
          createdById: p.userId,
          createdAt: this.clock.now(),
        },
      });
    });
  }

  // ---------------------------------------------------------------- jobs
  /** Called on every scheduler tick: daily training and hourly rescoring per enabled brand (deterministic keys). */
  async schedule() {
    const now = this.clock.now();
    const iso = now.toISOString();
    const brands = await this.db.system((tx) =>
      tx.aiSettings.findMany({
        where: { enabled: true },
        select: { organizationId: true, brandId: true },
      }),
    );
    for (const b of brands)
      await this.db.tenant(b.organizationId, async (tx) => {
        await this.jobs.enqueue(tx, {
          organizationId: b.organizationId,
          type: 'ai.train',
          key: `ai.train:${b.brandId}:${iso.slice(0, 10)}`,
          payload: { brandId: b.brandId },
          runAt: now,
        });
        await this.jobs.enqueue(tx, {
          organizationId: b.organizationId,
          type: 'ai.rescore',
          key: `ai.rescore:${b.brandId}:${iso.slice(0, 13)}`,
          payload: { brandId: b.brandId },
          runAt: now,
        });
      });
    return { brands: brands.length };
  }

  private async trainJob(organizationId: string, payload: unknown) {
    const { brandId } = payload as { brandId: string };
    await this.db.tenant(organizationId, async (tx) => {
      const s = await this.settingsTx(tx, brandId);
      if (s?.enabled) await this.trainInTx(tx, organizationId, brandId);
    });
  }

  /** Rescores the brand's open leads (most recently active first). */
  async rescoreJob(organizationId: string, payload: unknown) {
    const { brandId } = payload as { brandId: string };
    await this.db.tenant(organizationId, async (tx) => {
      const s = await this.settingsTx(tx, brandId);
      if (!s?.enabled || !s.scoringEnabled) return;
      const open = await tx.lead.findMany({
        where: { brandId, status: { in: ['OPEN', 'ON_HOLD', 'IN_RECOVERY'] } },
        orderBy: { updatedAt: 'desc' },
        take: RESCORE_LIMIT,
        select: { id: true, brandId: true, organizationId: true },
      });
      for (const l of open) await this.persist(tx, l, await this.compute(tx, l, s));
    });
  }
}
