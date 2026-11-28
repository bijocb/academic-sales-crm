import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { z } from '@crm/contracts';
import type { AssistantAskSchema, AssistantSettingsSchema } from '@crm/contracts';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { AppError, conflict, forbidden } from '../common/errors';
import { Db } from '../db/db.service';
import { InsightsService, isManager } from '../insights/insights.service';
import { ReportsService } from '../reports/reports.service';
import { AssistantProvider } from './provider';
import { AssistantTools, TOOL_SPECS } from './tools';

/** ASSUMED (A-052): per-user hourly limit; the monthly organization limit is a setting. */
export const QUESTIONS_PER_USER_HOUR = 20;
const MAX_ROUNDS = 8;

const SYSTEM = `You are the reporting assistant of an education sales and admissions CRM. You help team leaders, brand managers and management understand their numbers and decide what to do next.

Rules:
- Answer only from the results of your tools. Never invent numbers. If the tools cannot answer, say what is missing.
- Call list_scope first when you need today's date, the time zone, or brand and team ids. Relative periods ("this month", "last week") are in the organization's time zone.
- You only see aggregate figures and the names of brands, teams, executives, courses, sources and campaigns. You never see individual students. If asked about a specific student, say that the lead page in the CRM has that.
- Money amounts are in minor units (paise / fils) with a currency code; show them as normal amounts (divide by 100) with the currency. Never add or convert different currencies.
- Be concise and practical: lead with the answer, then the key numbers, then up to three concrete actions. Use short bullet lists. Name the period you looked at.
- Comparisons of people are for coaching, not blame; mention sample sizes when they are small.`;

const BRIEF = `Write a weekly management brief from the figures and insights below (JSON). At most 150 words: one sentence on the overall picture, then up to four bullets with the most important points and an action each. Use only these figures. Money is in minor units: divide by 100.`;

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  private readonly tools: AssistantTools;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly insights: InsightsService,
    reports: ReportsService,
    @Optional() @Inject(AssistantProvider) private readonly provider: AssistantProvider | null,
  ) {
    this.tools = new AssistantTools(db, reports, insights);
  }

  private settingsRow(organizationId: string) {
    return this.db.tenant(organizationId, (tx) =>
      tx.assistantSettings.findUnique({ where: { organizationId } }),
    );
  }

  private monthStart() {
    const n = this.clock.now();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
  }

  /** What the assistant page needs: on/off, configured, sandbox, usage this month. */
  async status(p: OrgPrincipal) {
    const s = await this.settingsRow(p.organizationId);
    const used = await this.db.tenant(p.organizationId, (tx) =>
      tx.assistantQuestion.count({ where: { createdAt: { gte: this.monthStart() } } }),
    );
    return {
      enabled: s?.enabled ?? false,
      briefEnabled: s?.briefEnabled ?? true,
      monthlyQuestionLimit: s?.monthlyQuestionLimit ?? 500,
      usedThisMonth: used,
      configured: !!this.provider,
      provider: this.provider?.name ?? null,
      sandbox: this.provider?.name === 'sandbox',
      canAsk: isManager(p),
      canManage: p.authz.scope('settings.manage').all,
    };
  }

  async updateSettings(p: OrgPrincipal, input: z.infer<typeof AssistantSettingsSchema>) {
    if (!p.authz.scope('settings.manage').all)
      throw forbidden('Only organization administrators can change the assistant');
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.assistantSettings.findUnique({
        where: { organizationId: p.organizationId },
      });
      const after = await tx.assistantSettings.upsert({
        where: { organizationId: p.organizationId },
        create: { organizationId: p.organizationId, ...input, updatedById: p.userId },
        update: { ...input, updatedById: p.userId },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        actorUserId: p.userId,
        action: 'assistant_settings.updated',
        entityType: 'assistant_settings',
        entityId: after.id,
        before,
        after,
      });
      return after;
    });
  }

  private async checkLimits(p: OrgPrincipal, limit: number) {
    const now = this.clock.now();
    const [mine, org] = await this.db.tenant(p.organizationId, (tx) =>
      Promise.all([
        tx.assistantQuestion.count({
          where: {
            userId: p.userId,
            kind: 'QUESTION',
            createdAt: { gte: new Date(now.getTime() - 3600_000) },
          },
        }),
        tx.assistantQuestion.count({ where: { createdAt: { gte: this.monthStart() } } }),
      ]),
    );
    if (mine >= QUESTIONS_PER_USER_HOUR)
      throw new AppError(
        HttpStatus.TOO_MANY_REQUESTS,
        'ASSISTANT_LIMIT',
        `You can ask ${QUESTIONS_PER_USER_HOUR} questions per hour. Please try again later.`,
      );
    if (org >= limit)
      throw new AppError(
        HttpStatus.TOO_MANY_REQUESTS,
        'ASSISTANT_LIMIT',
        "Your organization's monthly assistant limit is used up. An administrator can raise it.",
      );
  }

  async ask(p: OrgPrincipal, input: z.infer<typeof AssistantAskSchema>) {
    if (!isManager(p)) throw forbidden('The assistant is for team leaders and management');
    const s = await this.settingsRow(p.organizationId);
    if (!s?.enabled)
      throw conflict('ASSISTANT_OFF', 'The assistant is switched off for your organization');
    if (!this.provider)
      throw conflict('ASSISTANT_NOT_CONFIGURED', 'The assistant is not set up on this server yet');
    await this.checkLimits(p, s.monthlyQuestionLimit);
    const provider = this.provider;
    let result;
    try {
      result = await provider.ask({
        system: SYSTEM,
        messages: [...input.history, { role: 'user', content: input.question }],
        tools: TOOL_SPECS,
        runTool: (name, args) => this.tools.run(p, name, args),
        maxRounds: MAX_ROUNDS,
      });
    } catch (e) {
      this.logger.warn({ err: e }, 'Assistant provider failed');
      await this.save(p, {
        kind: 'QUESTION',
        question: input.question,
        answer: null,
        status: 'FAILED',
        errorCode: e instanceof AppError ? e.code : 'PROVIDER_ERROR',
        toolsUsed: [],
        provider: provider.name,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
      });
      throw new AppError(
        HttpStatus.BAD_GATEWAY,
        'ASSISTANT_FAILED',
        'The assistant could not answer just now. Please try again.',
      );
    }
    const id = await this.save(p, {
      kind: 'QUESTION',
      question: input.question,
      answer: result.text,
      status: result.status,
      errorCode: null,
      toolsUsed: result.toolsUsed,
      provider: provider.name,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    return {
      id,
      status: result.status,
      answer: result.text,
      toolsUsed: result.toolsUsed,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      provider: provider.name,
      sandbox: provider.name === 'sandbox',
    };
  }

  /**
   * The AI-written weekly brief for a digest recipient (A-052), or null when the assistant or the brief is off, or
   * the provider fails (the digest is sent without it).
   */
  async brief(p: OrgPrincipal, figures: unknown): Promise<string | null> {
    const s = await this.settingsRow(p.organizationId);
    if (!s?.enabled || !s.briefEnabled || !this.provider) return null;
    const used = await this.db.tenant(p.organizationId, (tx) =>
      tx.assistantQuestion.count({ where: { createdAt: { gte: this.monthStart() } } }),
    );
    if (used >= s.monthlyQuestionLimit) return null;
    try {
      const data = JSON.stringify(figures, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      const r = await this.provider.ask({
        system: SYSTEM,
        messages: [{ role: 'user', content: `${BRIEF}\n\n${data}` }],
        tools: [],
        runTool: async () => null,
        maxRounds: 1,
      });
      await this.save(p, {
        kind: 'BRIEF',
        question: 'Weekly brief',
        answer: r.text,
        status: r.status,
        errorCode: null,
        toolsUsed: [],
        provider: this.provider.name,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      });
      return r.status === 'ANSWERED' ? r.text : null;
    } catch (e) {
      this.logger.warn({ err: e }, 'Weekly brief failed; digest goes without it');
      return null;
    }
  }

  /** Own recent questions; an organization administrator can review everyone's. */
  history(p: OrgPrincipal, all: boolean) {
    if (all && !p.authz.scope('settings.manage').all) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      const rows = await tx.assistantQuestion.findMany({
        where: all ? {} : { userId: p.userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const users = all
        ? new Map(
            (
              await tx.user.findMany({
                where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
                select: { id: true, name: true },
              })
            ).map((u) => [u.id, u.name]),
          )
        : null;
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        question: r.question,
        answer: r.answer,
        status: r.status,
        toolsUsed: r.toolsUsed,
        provider: r.provider,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        createdAt: r.createdAt,
        ...(users ? { user: users.get(r.userId) ?? null } : {}),
      }));
    });
  }

  private save(
    p: OrgPrincipal,
    r: {
      kind: 'QUESTION' | 'BRIEF';
      question: string;
      answer: string | null;
      status: 'ANSWERED' | 'REFUSED' | 'FAILED';
      errorCode: string | null;
      toolsUsed: unknown[];
      provider: string;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
    },
  ) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const row = await tx.assistantQuestion.create({
        data: {
          organizationId: p.organizationId,
          userId: p.userId,
          ...r,
          toolsUsed: r.toolsUsed as object[],
          createdAt: this.clock.now(),
        },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        actorUserId: p.userId,
        action: r.kind === 'BRIEF' ? 'assistant.brief' : 'assistant.asked',
        entityType: 'assistant_question',
        entityId: row.id,
        after: { status: r.status, tools: r.toolsUsed.length, model: r.model },
      });
      return row.id;
    });
  }
}
