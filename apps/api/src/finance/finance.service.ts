import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Admission, FeePlan, Payment, PaymentMethod } from '@prisma/client';
import {
  FeeAdjustmentSchema,
  FinanceSettingsSchema,
  formatAdmissionNumber,
  ManualPaymentSchema,
  PaymentLinkSchema,
  RefundListQuerySchema,
  RefundPaidSchema,
  RefundRejectSchema,
  RefundRequestSchema,
  RefundDecisionSchema,
  ScheduleSchema,
  z,
} from '@crm/contracts';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { AdmissionsService } from '../admissions/admissions.service';
import { NotificationsService } from '../allocation/notifications.service';
import { AuditService } from '../audit/audit.service';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { AppError, badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Db, Tx } from '../db/db.service';
import { JobRow, JobsService } from '../jobs/jobs.service';
import { LeadsService } from '../leads/leads.service';
import { changeLeadStatus } from '../leads/status-history';
import { brandManagers } from '../work/recipients';
import { TaskCoreService } from '../work/task-core.service';
import { GatewayOrderState, GatewayRegistry } from './gateway';

const RECONCILE_AFTER_MS = 10 * 60_000;
const EXPIRE_AFTER_MS = 7 * 24 * 60 * 60_000;
type Perm =
  | 'payment.read'
  | 'payment.record'
  | 'refund.request'
  | 'refund.approve'
  | 'admission.manage'
  | 'pipeline.transition'
  | 'settings.manage';

/** Fee plans, payments, gateway webhooks, reconciliation, receipts and refunds (FR-015). See PHASE-12.md. */
@Injectable()
export class FinanceService implements OnModuleInit {
  private readonly logger = new Logger('Finance');

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly leads: LeadsService,
    private readonly admissions: AdmissionsService,
    private readonly gateways: GatewayRegistry,
    private readonly jobs: JobsService,
    private readonly tasks: TaskCoreService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('instalment.due', (j) => this.instalmentDue(j));
  }

  // -------------------------------------------------------------- access
  private inBrand(p: OrgPrincipal, perm: Perm, brandId: string) {
    const v = p.authz.visibleBrandIds(perm);
    return v.all || v.brandIds.includes(brandId);
  }
  /** Sales working the lead (start admissions, send payment links) — not money handling. */
  private canWork(p: OrgPrincipal, brandId: string) {
    return (
      this.inBrand(p, 'admission.manage', brandId) ||
      (this.leads.canEdit(p, brandId) && this.inBrand(p, 'pipeline.transition', brandId))
    );
  }
  private canSee(p: OrgPrincipal, brandId: string) {
    return this.inBrand(p, 'payment.read', brandId) || this.canWork(p, brandId);
  }

  private async admission(tx: Tx, p: OrgPrincipal, admissionId: string) {
    const a = await tx.admission.findUnique({ where: { id: admissionId } });
    if (!a) throw notFound('Admission');
    await this.leads.visibleLead(tx, p, a.leadId);
    return a;
  }
  private async planOf(tx: Tx, p: OrgPrincipal, planId: string) {
    const plan = await tx.feePlan.findUnique({ where: { id: planId } });
    if (!plan) throw notFound('Fee plan');
    const a = await this.admission(tx, p, plan.admissionId);
    return { plan, a };
  }

  private async today(tx: Tx, brandId: string) {
    const b = await tx.brand.findUniqueOrThrow({
      where: { id: brandId },
      select: { timezone: true },
    });
    return DateTime.fromJSDate(this.clock.now(), { zone: b.timezone });
  }
  private dateOnly = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  // ------------------------------------------------------------ fee plan
  /** Lazily creates the plan: accepted quotation total, else course list fee; one instalment (A-043). */
  private async ensurePlan(tx: Tx, a: Admission, actorUserId: string | null): Promise<FeePlan> {
    const existing = await tx.feePlan.findUnique({ where: { admissionId: a.id } });
    if (existing) return existing;
    const course = await tx.course.findUniqueOrThrow({ where: { id: a.courseId } });
    const quote = a.quotationId
      ? await tx.quotation.findUnique({ where: { id: a.quotationId } })
      : null;
    const base = quote?.totalMinor ?? course.listFeeMinor ?? 0n;
    const settings = await tx.financeSettings.findUniqueOrThrow({ where: { brandId: a.brandId } });
    const plan = await tx.feePlan.create({
      data: {
        organizationId: a.organizationId,
        brandId: a.brandId,
        admissionId: a.id,
        currency: quote?.currency ?? course.currency,
        baseAmountMinor: base,
        createdById: actorUserId,
        createdAt: this.clock.now(),
      },
    });
    if (base > 0n) {
      const due = (await this.today(tx, a.brandId))
        .plus({ days: settings.defaultDueDays })
        .toISODate()!;
      await this.writeSchedule(tx, plan, [{ dueDate: due, amountMinor: base }]);
    }
    return plan;
  }

  private async writeSchedule(
    tx: Tx,
    plan: FeePlan,
    items: Array<{ dueDate: string; amountMinor: bigint }>,
  ) {
    await tx.instalment.deleteMany({ where: { planId: plan.id } });
    await tx.instalment.createMany({
      data: items.map((x, i) => ({
        organizationId: plan.organizationId,
        planId: plan.id,
        seq: i + 1,
        dueDate: this.dateOnly(x.dueDate),
        amountMinor: x.amountMinor,
      })),
    });
    const brand = await tx.brand.findUniqueOrThrow({
      where: { id: plan.brandId },
      select: { timezone: true },
    });
    for (const x of await tx.instalment.findMany({ where: { planId: plan.id } }))
      await this.jobs.enqueue(tx, {
        organizationId: plan.organizationId,
        type: 'instalment.due',
        key: `inst:${plan.id}:${x.seq}:${x.dueDate.toISOString().slice(0, 10)}:${x.amountMinor}`,
        payload: { planId: plan.id, seq: x.seq },
        runAt: DateTime.fromISO(x.dueDate.toISOString().slice(0, 10), { zone: brand.timezone })
          .set({ hour: 9 })
          .toJSDate(),
      });
  }

  /** Totals and oldest-first allocation of net collections to instalments. */
  private async totals(tx: Tx, plan: FeePlan) {
    const [adj, payments, instalments] = await Promise.all([
      tx.feeAdjustment.aggregate({ where: { planId: plan.id }, _sum: { amountMinor: true } }),
      tx.payment.findMany({ where: { planId: plan.id }, orderBy: { receivedAt: 'asc' } }),
      tx.instalment.findMany({ where: { planId: plan.id }, orderBy: { seq: 'asc' } }),
    ]);
    const refunds = await tx.refund.findMany({
      where: { paymentId: { in: payments.map((x) => x.id) } },
    });
    const events = await tx.refundEvent.findMany({
      where: { refundId: { in: refunds.map((r) => r.id) } },
      orderBy: { occurredAt: 'asc' },
    });
    const statusOf = (id: string) =>
      events.filter((e) => e.refundId === id).at(-1)?.type ?? 'REQUESTED';
    const refundedPaid = refunds
      .filter((r) => statusOf(r.id) === 'PAID')
      .reduce((s, r) => s + r.amountMinor, 0n);
    const netFee = plan.baseAmountMinor + (adj._sum.amountMinor ?? 0n);
    const paid = payments.reduce((s, x) => s + x.amountMinor, 0n);
    const netCollected = paid - refundedPaid;
    let left = netCollected;
    const today = (await this.today(tx, plan.brandId)).toISODate()!;
    const schedule = instalments.map((i) => {
      const applied = left >= i.amountMinor ? i.amountMinor : left > 0n ? left : 0n;
      left -= applied;
      const due = i.dueDate.toISOString().slice(0, 10);
      return {
        ...i,
        paidMinor: applied,
        dueMinor: i.amountMinor - applied,
        overdue: applied < i.amountMinor && due < today,
      };
    });
    return {
      netFee,
      adjustments: adj._sum.amountMinor ?? 0n,
      paid,
      refundedPaid,
      netCollected,
      outstanding: netFee - netCollected,
      overdueMinor: schedule.filter((s) => s.overdue).reduce((x, s) => x + s.dueMinor, 0n),
      schedule,
      payments,
      refunds: refunds.map((r) => ({
        ...r,
        status: statusOf(r.id),
        events: events.filter((e) => e.refundId === r.id),
      })),
    };
  }

  finance(p: OrgPrincipal, admissionId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await this.admission(tx, p, admissionId);
      if (!this.canSee(p, a.brandId)) throw forbidden();
      const plan = await this.ensurePlan(tx, a, p.userId);
      const t = await this.totals(tx, plan);
      const [attempts, adjustments, settings] = await Promise.all([
        tx.paymentAttempt.findMany({ where: { planId: plan.id }, orderBy: { createdAt: 'desc' } }),
        tx.feeAdjustment.findMany({ where: { planId: plan.id }, orderBy: { createdAt: 'asc' } }),
        tx.financeSettings.findUniqueOrThrow({ where: { brandId: a.brandId } }),
      ]);
      return {
        plan,
        admissionStatus: a.status,
        ...t,
        attempts,
        adjustmentsLog: adjustments,
        gateway: this.gateways.primary?.name ?? null,
        minConfirmAmountMinor: settings.minConfirmAmountMinor,
        can: {
          work: this.canWork(p, a.brandId),
          record: this.inBrand(p, 'payment.record', a.brandId),
          requestRefund: this.inBrand(p, 'refund.request', a.brandId),
          approveRefund: this.inBrand(p, 'refund.approve', a.brandId),
        },
      };
    });
  }

  setSchedule(p: OrgPrincipal, planId: string, input: z.infer<typeof ScheduleSchema>) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const { plan, a } = await this.planOf(tx, p, planId);
      const paidAny = (await tx.payment.count({ where: { planId } })) > 0;
      if (
        !(this.inBrand(p, 'payment.record', a.brandId) || (!paidAny && this.canWork(p, a.brandId)))
      )
        throw forbidden(
          paidAny ? 'After the first payment only Accounts can change the schedule' : undefined,
        );
      const t = await this.totals(tx, plan);
      let items: Array<{ dueDate: string; amountMinor: bigint }>;
      if (input.mode === 'EQUAL') {
        const share = t.netFee / BigInt(input.count);
        const first = DateTime.fromISO(input.firstDueDate);
        items = Array.from({ length: input.count }, (_, i) => ({
          dueDate: first.plus({ days: i * input.intervalDays }).toISODate()!,
          amountMinor: i === input.count - 1 ? t.netFee - share * BigInt(input.count - 1) : share,
        }));
      } else {
        items = input.instalments.map((x) => ({
          dueDate: x.dueDate,
          amountMinor: BigInt(x.amountMinor),
        }));
      }
      const sum = items.reduce((s, x) => s + x.amountMinor, 0n);
      if (sum !== t.netFee)
        throw badRequest(
          'SCHEDULE_MISMATCH',
          `Instalments add up to ${sum}, the fee is ${t.netFee}`,
        );
      if (items.some((x) => x.amountMinor <= 0n))
        throw badRequest('SCHEDULE_INVALID', 'Every instalment must be positive');
      for (let i = 1; i < items.length; i++)
        if (items[i].dueDate < items[i - 1].dueDate)
          throw badRequest('SCHEDULE_INVALID', 'Due dates must be in order');
      await this.writeSchedule(tx, plan, items);
      await this.audit.record(tx, {
        organizationId: a.organizationId,
        brandId: a.brandId,
        actorUserId: p.userId,
        action: 'fee_plan.scheduled',
        entityType: 'fee_plan',
        entityId: plan.id,
        after: {
          instalments: items.map((x) => ({
            dueDate: x.dueDate,
            amountMinor: x.amountMinor.toString(),
          })),
        },
      });
      return (await this.totals(tx, plan)).schedule;
    });
  }

  /** Concession / penalty / correction: Accounts only; the last instalment absorbs the change (A-043). */
  adjust(p: OrgPrincipal, planId: string, input: z.infer<typeof FeeAdjustmentSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const { plan, a } = await this.planOf(tx, p, planId);
      if (!this.inBrand(p, 'payment.record', a.brandId))
        throw forbidden('Fee adjustments are restricted to Accounts');
      const delta = BigInt(input.amountMinor);
      const t = await this.totals(tx, plan);
      if (t.netFee + delta < 0n)
        throw badRequest('ADJUSTMENT_TOO_LARGE', 'The fee cannot become negative');
      const last = await tx.instalment.findFirst({ where: { planId }, orderBy: { seq: 'desc' } });
      if (last) {
        if (last.amountMinor + delta <= 0n)
          throw badRequest(
            'ADJUSTMENT_TOO_LARGE',
            'Re-plan the instalments: the last one would become zero or negative',
          );
        await tx.instalment.update({
          where: { id: last.id },
          data: { amountMinor: last.amountMinor + delta },
        });
      } else if (delta > 0n) {
        await this.writeSchedule(tx, plan, [
          { dueDate: (await this.today(tx, a.brandId)).toISODate()!, amountMinor: delta },
        ]);
      }
      const row = await tx.feeAdjustment.create({
        data: {
          organizationId: a.organizationId,
          planId,
          amountMinor: delta,
          reason: input.reason,
          createdById: p.userId,
          createdAt: now,
        },
      });
      await this.leadEvent(
        tx,
        a,
        'FEE_ADJUSTED',
        `Fee ${delta > 0n ? 'increased' : 'reduced'} by ${this.money(delta < 0n ? -delta : delta, plan.currency)} — ${input.reason}`,
        p.userId,
        now,
      );
      await this.audit.record(tx, {
        organizationId: a.organizationId,
        brandId: a.brandId,
        actorUserId: p.userId,
        action: 'fee_plan.adjusted',
        entityType: 'fee_plan',
        entityId: plan.id,
        after: { amountMinor: delta.toString() },
        reason: input.reason,
      });
      return row;
    });
  }

  // -------------------------------------------------------- gateway links
  paymentLink(p: OrgPrincipal, planId: string, input: z.infer<typeof PaymentLinkSchema>) {
    const gateway = this.gateways.primary;
    return this.db.tenant(p.organizationId, async (tx) => {
      const { plan, a } = await this.planOf(tx, p, planId);
      if (!this.canWork(p, a.brandId)) throw forbidden();
      if (!gateway)
        throw conflict(
          'GATEWAY_NOT_CONFIGURED',
          'No payment gateway is connected yet — record payments manually.',
        );
      if (['CANCELLED', 'CANCELLED_REFUNDED', 'DEFERRED'].includes(a.status))
        throw badRequest('ADMISSION_NOT_ACTIVE', 'This admission is not active');
      const t = await this.totals(tx, plan);
      const next = t.schedule.find((s) => s.dueMinor > 0n)?.dueMinor ?? t.outstanding;
      const amount = input.amountMinor ? BigInt(input.amountMinor) : next;
      if (amount <= 0n) throw badRequest('NOTHING_DUE', 'Nothing is due on this fee plan');
      if (amount > t.outstanding)
        throw badRequest('OVERPAYMENT', 'The amount is more than the outstanding fee');
      const order = await gateway.createOrder({
        amountMinor: amount,
        currency: plan.currency,
        reference: `${plan.id}:${randomUUID()}`,
      });
      const attempt = await tx.paymentAttempt.create({
        data: {
          organizationId: a.organizationId,
          brandId: a.brandId,
          planId,
          admissionId: a.id,
          provider: gateway.name,
          providerOrderId: order.orderId,
          amountMinor: amount,
          currency: plan.currency,
          status: 'PENDING',
          checkoutUrl: order.checkoutUrl,
          createdById: p.userId,
          createdAt: this.clock.now(),
        },
      });
      await this.audit.record(tx, {
        organizationId: a.organizationId,
        brandId: a.brandId,
        actorUserId: p.userId,
        action: 'payment.link_created',
        entityType: 'payment_attempt',
        entityId: attempt.id,
        after: { amountMinor: amount.toString(), provider: gateway.name },
      });
      return attempt;
    });
  }

  attempt(p: OrgPrincipal, attemptId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const at = await tx.paymentAttempt.findUnique({ where: { id: attemptId } });
      if (!at) throw notFound('Payment attempt');
      const a = await this.admission(tx, p, at.admissionId);
      if (!this.canSee(p, a.brandId)) throw forbidden();
      return at;
    });
  }

  /** "Check payment" (e.g. after the customer returns): asks the gateway server-side — never trusts the browser. */
  async checkAttempt(p: OrgPrincipal, attemptId: string) {
    const at = await this.attempt(p, attemptId);
    await this.reconcileAttempt(at.organizationId, at.id);
    return this.attempt(p, attemptId);
  }

  // -------------------------------------------------------------- webhooks
  /** Signed gateway webhook. Unsigned or badly signed requests are refused and never touch a payment. */
  async webhook(
    provider: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ) {
    const gateway = this.gateways.get(provider);
    if (!gateway) throw notFound('Payment provider');
    const now = this.clock.now();
    if (!rawBody || !gateway.verifySignature(rawBody, headers)) {
      // Stored under a random id so a forged event can never block the real one (unique provider + event id).
      await this.db.system((tx) =>
        tx.paymentEvent.create({
          data: {
            provider,
            eventId: `invalid:${randomUUID()}`,
            type: 'unknown',
            signatureValid: false,
            payload: {},
            result: 'REJECTED_SIGNATURE',
            receivedAt: now,
          },
        }),
      );
      throw new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature is invalid');
    }
    const event = gateway.parseEvent(rawBody);
    // Webhooks carry no tenant: find the attempt (and its organization) first.
    const attempt = await this.db.system((tx) =>
      tx.paymentAttempt.findUnique({
        where: { provider_providerOrderId: { provider, providerOrderId: event.orderId } },
      }),
    );
    const inserted = await this.db.system(
      (tx) =>
        tx.$executeRaw`
        INSERT INTO payment_events (id, organization_id, provider, event_id, type, signature_valid, payload, attempt_id, result, received_at)
        VALUES (gen_random_uuid(), ${attempt?.organizationId ?? null}::uuid, ${provider}, ${event.eventId}, ${event.type}, true,
                ${JSON.stringify(JSON.parse(rawBody.toString('utf8')))}::jsonb, ${attempt?.id ?? null}::uuid,
                ${attempt ? 'ACCEPTED' : 'UNKNOWN_ORDER'}, ${now})
        ON CONFLICT (provider, event_id) DO NOTHING`,
    );
    if (!inserted) return { received: true, duplicate: true };
    if (!attempt) return { received: true, matched: false };
    await this.apply(attempt.organizationId, attempt.id, event, 'GATEWAY_WEBHOOK');
    return { received: true, matched: true };
  }

  /** Applies a trusted gateway state to an attempt (idempotent). */
  private async apply(
    org: string,
    attemptId: string,
    state: GatewayOrderState,
    verification: 'GATEWAY_WEBHOOK' | 'GATEWAY_RECONCILIATION',
  ) {
    const now = this.clock.now();
    const result = await this.db.tenant(org, async (tx) => {
      await tx.$queryRaw`SELECT id FROM payment_attempts WHERE id = ${attemptId}::uuid FOR UPDATE`;
      const at = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      await tx.paymentAttempt.update({ where: { id: at.id }, data: { lastCheckedAt: now } });
      if (at.status === 'SUCCEEDED' && state.status !== 'DISPUTED') return { paid: false };
      if (state.status === 'SUCCEEDED') {
        if (state.amountMinor !== at.amountMinor || state.currency !== at.currency) {
          const mismatch = `Gateway reported ${state.amountMinor} ${state.currency}, expected ${at.amountMinor} ${at.currency}`;
          await tx.paymentAttempt.update({ where: { id: at.id }, data: { mismatch } });
          this.logger.warn({ attemptId, mismatch }, 'Payment amount mismatch — not recorded');
          return { paid: false };
        }
        await tx.paymentAttempt.update({
          where: { id: at.id },
          data: { status: 'SUCCEEDED', mismatch: null },
        });
        const plan = await tx.feePlan.findUniqueOrThrow({ where: { id: at.planId } });
        const a = await tx.admission.findUniqueOrThrow({ where: { id: at.admissionId } });
        await this.createPayment(tx, plan, a, {
          attemptId: at.id,
          amountMinor: at.amountMinor,
          method: 'GATEWAY',
          reference: state.paymentRef,
          verification,
          verifiedById: null,
          receivedAt: now,
          notes: null,
          now,
        });
        return { paid: true, admissionId: a.id };
      }
      if (state.status === 'FAILED' && at.status !== 'SUCCEEDED')
        await tx.paymentAttempt.update({ where: { id: at.id }, data: { status: 'FAILED' } });
      if (state.status === 'DISPUTED') {
        await tx.paymentAttempt.update({ where: { id: at.id }, data: { status: 'DISPUTED' } });
        for (const userId of await brandManagers(tx, at.brandId, 'payment.record'))
          await this.notifications.create(tx, {
            organizationId: org,
            userId,
            type: 'PAYMENT_DISPUTED',
            title: 'A gateway payment is disputed',
            body: `Order ${at.providerOrderId}`,
            link: '/finance',
            dedupKey: `dispute:${at.id}`,
            now,
          });
      }
      return { paid: false };
    });
    if (result.paid && result.admissionId) await this.tryConfirm(org, result.admissionId);
  }

  // --------------------------------------------------------- reconciliation
  /** Asks the gateway about one attempt (server-side). */
  async reconcileAttempt(org: string, attemptId: string) {
    const at = await this.db.tenant(org, (tx) =>
      tx.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } }),
    );
    const gateway = this.gateways.get(at.provider);
    if (!gateway || at.status !== 'PENDING') return;
    const state = await gateway.fetchOrder(at.providerOrderId);
    if (state.status === 'PENDING') {
      const now = this.clock.now();
      await this.db.tenant(org, (tx) =>
        tx.paymentAttempt.update({
          where: { id: at.id },
          data: {
            lastCheckedAt: now,
            ...(now.getTime() - at.createdAt.getTime() > EXPIRE_AFTER_MS
              ? { status: 'EXPIRED' }
              : {}),
          },
        }),
      );
      return;
    }
    await this.apply(org, at.id, state, 'GATEWAY_RECONCILIATION');
  }

  /** Scheduler tick: pending attempts older than 10 minutes are checked with the gateway (missed webhooks). */
  async reconcilePending(limit = 50) {
    const now = this.clock.now();
    const due = await this.db.system((tx) =>
      tx.paymentAttempt.findMany({
        where: {
          status: 'PENDING',
          createdAt: { lt: new Date(now.getTime() - RECONCILE_AFTER_MS) },
          OR: [
            { lastCheckedAt: null },
            { lastCheckedAt: { lt: new Date(now.getTime() - RECONCILE_AFTER_MS) } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: { id: true, organizationId: true },
      }),
    );
    let checked = 0;
    for (const at of due) {
      try {
        await this.reconcileAttempt(at.organizationId, at.id);
        checked++;
      } catch (e) {
        this.logger.error({ err: e, attemptId: at.id }, 'Reconciliation failed');
      }
    }
    return { checked };
  }

  reconciliation(p: OrgPrincipal, brandId?: string) {
    const v = p.authz.visibleBrandIds('payment.read');
    if (!v.all && !v.brandIds.length) throw forbidden();
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const scope = brandId ? { brandId } : v.all ? {} : { brandId: { in: v.brandIds } };
      if (brandId && !v.all && !v.brandIds.includes(brandId)) throw notFound('Brand');
      const [mismatched, disputed, stale, succeeded] = await Promise.all([
        tx.paymentAttempt.findMany({ where: { ...scope, mismatch: { not: null } } }),
        tx.paymentAttempt.findMany({ where: { ...scope, status: 'DISPUTED' } }),
        tx.paymentAttempt.findMany({
          where: {
            ...scope,
            status: 'PENDING',
            createdAt: { lt: new Date(now.getTime() - 60 * 60_000) },
          },
        }),
        tx.paymentAttempt.findMany({
          where: { ...scope, status: 'SUCCEEDED' },
          select: { id: true },
        }),
      ]);
      const paidAttempts = new Set(
        (
          await tx.payment.findMany({
            where: { attemptId: { in: succeeded.map((s) => s.id) } },
            select: { attemptId: true },
          })
        ).map((x) => x.attemptId),
      );
      return {
        mismatched,
        disputed,
        stalePending: stale,
        succeededWithoutPayment: succeeded.filter((s) => !paidAttempts.has(s.id)).map((s) => s.id),
      };
    });
  }

  // ----------------------------------------------------------- payments
  recordManual(p: OrgPrincipal, planId: string, input: z.infer<typeof ManualPaymentSchema>) {
    const now = this.clock.now();
    return this.db
      .tenant(p.organizationId, async (tx) => {
        const { plan, a } = await this.planOf(tx, p, planId);
        if (!this.inBrand(p, 'payment.record', a.brandId))
          throw forbidden('Only Accounts can record and verify payments');
        if (['CANCELLED', 'CANCELLED_REFUNDED'].includes(a.status))
          throw badRequest('ADMISSION_NOT_ACTIVE', 'This admission is not active');
        const receivedAt = new Date(input.receivedAt);
        if (receivedAt > now)
          throw badRequest('PAYMENT_IN_FUTURE', 'The payment date cannot be in the future');
        const t = await this.totals(tx, plan);
        const amount = BigInt(input.amountMinor);
        if (amount > t.outstanding)
          throw badRequest('OVERPAYMENT', 'The amount is more than the outstanding fee');
        return this.createPayment(tx, plan, a, {
          attemptId: null,
          amountMinor: amount,
          method: input.method,
          reference: input.reference ?? null,
          verification: 'MANUAL',
          verifiedById: p.userId,
          receivedAt,
          notes: input.notes ?? null,
          now,
        });
      })
      .then(async (payment) => {
        await this.tryConfirm(p.organizationId, payment.admissionId);
        return payment;
      });
  }

  private async createPayment(
    tx: Tx,
    plan: FeePlan,
    a: Admission,
    x: {
      attemptId: string | null;
      amountMinor: bigint;
      method: PaymentMethod;
      reference: string | null;
      verification: string;
      verifiedById: string | null;
      receivedAt: Date;
      notes: string | null;
      now: Date;
    },
  ): Promise<Payment> {
    const [settings, brand] = await Promise.all([
      tx.financeSettings.findUniqueOrThrow({ where: { brandId: a.brandId } }),
      tx.brand.findUniqueOrThrow({ where: { id: a.brandId } }),
    ]);
    const year = DateTime.fromJSDate(x.now, { zone: brand.timezone }).year;
    const [row] = await tx.$queryRaw<Array<{ value: bigint }>>`
      INSERT INTO org_counters (organization_id, name, value) VALUES (${a.organizationId}::uuid, ${`receipt:${a.brandId}:${year}`}, 1)
      ON CONFLICT (organization_id, name) DO UPDATE SET value = org_counters.value + 1
      RETURNING value`;
    const payment = await tx.payment.create({
      data: {
        organizationId: a.organizationId,
        brandId: a.brandId,
        admissionId: a.id,
        planId: plan.id,
        attemptId: x.attemptId,
        amountMinor: x.amountMinor,
        currency: plan.currency,
        method: x.method,
        reference: x.reference,
        receiptNumber: formatAdmissionNumber(settings.receiptNumberFormat, {
          brand: brand.code,
          year,
          seq: Number(row.value),
        }),
        verification: x.verification,
        verifiedById: x.verifiedById,
        receivedAt: x.receivedAt,
        recordedAt: x.now,
        notes: x.notes,
      },
    });
    await this.leadEvent(
      tx,
      a,
      'PAYMENT_RECEIVED',
      `${this.money(x.amountMinor, plan.currency)} received (${x.method.toLowerCase().replace('_', ' ')}) — receipt ${payment.receiptNumber}`,
      x.verifiedById,
      x.now,
      { paymentId: payment.id },
    );
    await tx.outboxEvent.create({
      data: {
        organizationId: a.organizationId,
        type: 'payment.verified',
        aggregateType: 'payment',
        aggregateId: payment.id,
        payload: {
          admissionId: a.id,
          amountMinor: x.amountMinor.toString(),
          currency: plan.currency,
          verification: x.verification,
        },
      },
    });
    await this.audit.record(tx, {
      organizationId: a.organizationId,
      brandId: a.brandId,
      actorUserId: x.verifiedById,
      action: 'payment.verified',
      entityType: 'payment',
      entityId: payment.id,
      after: {
        amountMinor: x.amountMinor.toString(),
        currency: plan.currency,
        method: x.method,
        verification: x.verification,
        receiptNumber: payment.receiptNumber,
      },
    });
    return payment;
  }

  /** D-006: the first verified payment (≥ brand minimum, A-006a) confirms the admission. Never throws. */
  private async tryConfirm(org: string, admissionId: string) {
    const now = this.clock.now();
    try {
      await this.db.tenant(org, async (tx) => {
        const a = await tx.admission.findUniqueOrThrow({ where: { id: admissionId } });
        if (['CONFIRMED', 'CANCELLED', 'CANCELLED_REFUNDED', 'DEFERRED'].includes(a.status)) return;
        const settings = await tx.financeSettings.findUniqueOrThrow({
          where: { brandId: a.brandId },
        });
        const paid = await tx.payment.aggregate({
          where: { admissionId },
          _sum: { amountMinor: true },
        });
        if ((paid._sum.amountMinor ?? 0n) < settings.minConfirmAmountMinor) return;
        await this.admissions.confirmInTx(tx, admissionId, {
          source: 'VERIFIED_PAYMENT',
          actorUserId: null,
          now,
        });
      });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      await this.db.tenant(org, async (tx) => {
        const a = await tx.admission.findUniqueOrThrow({ where: { id: admissionId } });
        await this.leadEvent(
          tx,
          a,
          'ADMISSION_CONFIRMATION_BLOCKED',
          `Payment verified but the admission could not be confirmed: ${e.message}`,
          null,
          now,
          { code: e.code },
        );
        for (const userId of await brandManagers(tx, a.brandId, 'admission.manage'))
          await this.notifications.create(tx, {
            organizationId: org,
            userId,
            type: 'ADMISSION_CONFIRMATION_BLOCKED',
            title: 'Paid admission waiting for confirmation',
            body: e.message,
            link: `/leads/${a.leadId}`,
            dedupKey: `confirm-blocked:${a.id}:${e.code}`,
            now,
          });
      });
    }
  }

  /** Retry after a blocked confirmation — only when verified money exists (D-006). */
  confirm(p: OrgPrincipal, admissionId: string) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const a = await this.admission(tx, p, admissionId);
      if (!this.inBrand(p, 'admission.manage', a.brandId)) throw forbidden();
      const settings = await tx.financeSettings.findUniqueOrThrow({
        where: { brandId: a.brandId },
      });
      const paid = await tx.payment.aggregate({
        where: { admissionId },
        _sum: { amountMinor: true },
      });
      if ((paid._sum.amountMinor ?? 0n) < settings.minConfirmAmountMinor)
        throw badRequest(
          'NO_VERIFIED_PAYMENT',
          'An admission is confirmed by a verified payment (D-006)',
        );
      return this.admissions.confirmInTx(tx, admissionId, {
        source: 'VERIFIED_PAYMENT',
        actorUserId: p.userId,
        now,
      });
    });
  }

  receipt(p: OrgPrincipal, paymentId: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const pay = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!pay) throw notFound('Payment');
      const a = await this.admission(tx, p, pay.admissionId);
      if (!this.canSee(p, a.brandId)) throw forbidden();
      const [brand, student, course] = await Promise.all([
        tx.brand.findUniqueOrThrow({ where: { id: a.brandId } }),
        tx.student.findUniqueOrThrow({ where: { id: a.studentId } }),
        tx.course.findUniqueOrThrow({ where: { id: a.courseId } }),
      ]);
      return {
        receiptNumber: pay.receiptNumber,
        brand: brand.name,
        student: student.legalName,
        admissionNumber: a.admissionNumber,
        course: course.name,
        amountMinor: pay.amountMinor,
        currency: pay.currency,
        method: pay.method,
        reference: pay.reference,
        receivedAt: pay.receivedAt,
        note: 'Payment receipt — not a tax invoice (O-09).',
      };
    });
  }

  // ---------------------------------------------------------------- refunds
  private async refundState(tx: Tx, refundId: string) {
    const r = await tx.refund.findUnique({ where: { id: refundId } });
    if (!r) throw notFound('Refund');
    const last = await tx.refundEvent.findFirst({
      where: { refundId },
      orderBy: { occurredAt: 'desc' },
    });
    return { r, status: last?.type ?? 'REQUESTED' };
  }

  requestRefund(p: OrgPrincipal, paymentId: string, input: z.infer<typeof RefundRequestSchema>) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      const pay = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!pay) throw notFound('Payment');
      const a = await this.admission(tx, p, pay.admissionId);
      if (!this.inBrand(p, 'refund.request', a.brandId)) throw forbidden();
      // Serialises refund requests per payment (payments are append-only, so no row lock).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'refund:' + paymentId}))`;
      const existing = await tx.refund.findMany({ where: { paymentId } });
      let committed = 0n;
      for (const r of existing)
        if ((await this.refundState(tx, r.id)).status !== 'REJECTED') committed += r.amountMinor;
      const amount = BigInt(input.amountMinor);
      if (amount > pay.amountMinor - committed)
        throw badRequest(
          'REFUND_TOO_LARGE',
          `At most ${this.money(pay.amountMinor - committed, pay.currency)} can still be refunded from this payment`,
        );
      const refund = await tx.refund.create({
        data: {
          organizationId: a.organizationId,
          brandId: a.brandId,
          paymentId,
          admissionId: a.id,
          amountMinor: amount,
          currency: pay.currency,
          reason: input.reason,
          requestedById: p.userId,
          requestedAt: now,
        },
      });
      await this.leadEvent(
        tx,
        a,
        'REFUND_REQUESTED',
        `Refund of ${this.money(amount, pay.currency)} requested — ${input.reason}`,
        p.userId,
        now,
        { refundId: refund.id },
      );
      for (const userId of await brandManagers(tx, a.brandId, 'refund.approve'))
        if (userId !== p.userId)
          await this.notifications.create(tx, {
            organizationId: a.organizationId,
            userId,
            type: 'REFUND_REQUESTED',
            title: `Refund to approve: ${this.money(amount, pay.currency)}`,
            body: input.reason,
            link: '/finance',
            dedupKey: `refund:${refund.id}`,
            now,
          });
      await this.audit.record(tx, {
        organizationId: a.organizationId,
        brandId: a.brandId,
        actorUserId: p.userId,
        action: 'refund.requested',
        entityType: 'refund',
        entityId: refund.id,
        after: { amountMinor: amount.toString(), paymentId },
        reason: input.reason,
      });
      return { ...refund, status: 'REQUESTED' };
    });
  }

  private async decide(
    p: OrgPrincipal,
    refundId: string,
    type: 'APPROVED' | 'REJECTED' | 'PAID',
    data: { note?: string; method?: string; reference?: string; paidOn?: string },
  ) {
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'refund-decision:' + refundId}))`;
      const { r, status } = await this.refundState(tx, refundId);
      const a = await this.admission(tx, p, r.admissionId);
      if (!this.inBrand(p, 'refund.approve', a.brandId)) throw forbidden();
      const allowed = type === 'PAID' ? status === 'APPROVED' : status === 'REQUESTED';
      if (!allowed) throw badRequest('REFUND_STATE', `This refund is ${status.toLowerCase()}`);
      const settings = await tx.financeSettings.findUniqueOrThrow({
        where: { brandId: a.brandId },
      });
      if (type === 'APPROVED' && settings.refundMakerChecker && r.requestedById === p.userId)
        throw forbidden('A refund must be approved by someone other than the requester');
      await tx.refundEvent.create({
        data: {
          organizationId: a.organizationId,
          refundId,
          type,
          note: data.note ?? null,
          method: data.method ?? null,
          reference: data.reference ?? null,
          paidOn: data.paidOn ? this.dateOnly(data.paidOn) : null,
          actorUserId: p.userId,
          occurredAt: now,
        },
      });
      await this.leadEvent(
        tx,
        a,
        `REFUND_${type}`,
        `Refund of ${this.money(r.amountMinor, r.currency)} ${type.toLowerCase()}${data.note ? ` — ${data.note}` : ''}${data.reference ? ` (ref ${data.reference})` : ''}`,
        p.userId,
        now,
        { refundId },
      );
      await this.audit.record(tx, {
        organizationId: a.organizationId,
        brandId: a.brandId,
        actorUserId: p.userId,
        action: `refund.${type.toLowerCase()}`,
        entityType: 'refund',
        entityId: refundId,
        after: data,
      });
      if (type === 'PAID') await this.afterRefundPaid(tx, a, p.userId, now);
      return { ...r, status: type };
    });
  }

  approveRefund(p: OrgPrincipal, id: string, input: z.infer<typeof RefundDecisionSchema>) {
    return this.decide(p, id, 'APPROVED', input);
  }
  rejectRefund(p: OrgPrincipal, id: string, input: z.infer<typeof RefundRejectSchema>) {
    return this.decide(p, id, 'REJECTED', input);
  }
  markRefundPaid(p: OrgPrincipal, id: string, input: z.infer<typeof RefundPaidSchema>) {
    return this.decide(p, id, 'PAID', input);
  }

  /** A-007b: everything paid has been refunded → CANCELLED_REFUNDED, seat released, lead CLOSED_LOST. */
  private async afterRefundPaid(tx: Tx, a: Admission, actorUserId: string, now: Date) {
    const plan = await tx.feePlan.findUniqueOrThrow({ where: { admissionId: a.id } });
    const t = await this.totals(tx, plan);
    if (t.netCollected > 0n || a.status === 'CANCELLED_REFUNDED') return;
    await tx.admission.update({
      where: { id: a.id },
      data: { status: 'CANCELLED_REFUNDED', holdsSeat: false },
    });
    await tx.admissionStatusHistory.create({
      data: {
        organizationId: a.organizationId,
        admissionId: a.id,
        fromStatus: a.status,
        toStatus: 'CANCELLED_REFUNDED',
        reason: 'All payments refunded',
        actorUserId,
        occurredAt: now,
      },
    });
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: a.leadId } });
    await changeLeadStatus(tx, {
      lead,
      to: 'CLOSED_LOST',
      reasonCode: 'REFUNDED',
      notes: 'All payments refunded',
      actorUserId,
      now,
    });
    await this.leadEvent(
      tx,
      a,
      'ADMISSION_STATUS',
      'Admission cancelled — fully refunded',
      actorUserId,
      now,
    );
    await this.audit.record(tx, {
      organizationId: a.organizationId,
      brandId: a.brandId,
      actorUserId,
      action: 'admission.cancelled_refunded',
      entityType: 'admission',
      entityId: a.id,
      before: { status: a.status },
      after: { status: 'CANCELLED_REFUNDED' },
    });
  }

  refunds(p: OrgPrincipal, q: z.infer<typeof RefundListQuerySchema>) {
    const v1 = p.authz.visibleBrandIds('refund.approve');
    const v2 = p.authz.visibleBrandIds('payment.read');
    const all = v1.all || v2.all;
    const ids = [...new Set([...v1.brandIds, ...v2.brandIds])];
    if (!all && !ids.length) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      const rows = await tx.refund.findMany({
        where: q.brandId
          ? {
              brandId: q.brandId,
              ...(all || ids.includes(q.brandId)
                ? {}
                : { id: '00000000-0000-0000-0000-000000000000' }),
            }
          : all
            ? {}
            : { brandId: { in: ids } },
        orderBy: { requestedAt: 'desc' },
        take: 200,
      });
      const events = await tx.refundEvent.findMany({
        where: { refundId: { in: rows.map((r) => r.id) } },
        orderBy: { occurredAt: 'asc' },
      });
      const adm = await tx.admission.findMany({
        where: { id: { in: rows.map((r) => r.admissionId) } },
        select: { id: true, leadId: true, studentId: true, admissionNumber: true },
      });
      const students = await tx.student.findMany({
        where: { id: { in: adm.map((x) => x.studentId) } },
        select: { id: true, legalName: true },
      });
      const am = new Map(adm.map((x) => [x.id, x]));
      const sm = new Map(students.map((x) => [x.id, x.legalName]));
      return rows
        .map((r) => ({
          ...r,
          status: events.filter((e) => e.refundId === r.id).at(-1)?.type ?? 'REQUESTED',
          leadId: am.get(r.admissionId)?.leadId,
          admissionNumber: am.get(r.admissionId)?.admissionNumber ?? null,
          student: sm.get(am.get(r.admissionId)?.studentId ?? '') ?? null,
        }))
        .filter((r) => !q.status || r.status === q.status);
    });
  }

  // ---------------------------------------------------------------- reminders
  private async instalmentDue(job: JobRow): Promise<void> {
    const { planId, seq } = job.payload as { planId: string; seq: number };
    const now = this.clock.now();
    await this.db.tenant(job.organizationId!, async (tx) => {
      const plan = await tx.feePlan.findUnique({ where: { id: planId } });
      if (!plan) return;
      const a = await tx.admission.findUniqueOrThrow({ where: { id: plan.admissionId } });
      if (['CANCELLED', 'CANCELLED_REFUNDED', 'DEFERRED'].includes(a.status)) return;
      const inst = (await this.totals(tx, plan)).schedule.find((s) => s.seq === seq);
      if (!inst || inst.dueMinor <= 0n) return;
      const lead = await tx.lead.findUniqueOrThrow({
        where: { id: a.leadId },
        include: { person: { select: { fullName: true } } },
      });
      if (!lead.ownerId) return;
      const open = await tx.task.count({
        where: { leadId: lead.id, status: 'OPEN', type: 'PAYMENT_FOLLOW_UP' },
      });
      if (open) return;
      await this.tasks.create(tx, {
        lead,
        ownerId: lead.ownerId,
        input: {
          type: 'PAYMENT_FOLLOW_UP',
          title: `Collect instalment ${seq}: ${this.money(inst.dueMinor, plan.currency)}`,
          dueAt: now.toISOString(),
          priority: 'HIGH',
        },
        createdById: null,
        now,
      });
    });
  }

  // -------------------------------------------------------------- settings
  settings(p: OrgPrincipal, brandId: string) {
    const v = p.authz.visibleBrandIds('brand.read');
    if (!v.all && !v.brandIds.includes(brandId)) throw notFound('Brand');
    return this.db.tenant(p.organizationId, (tx) =>
      tx.financeSettings.findUniqueOrThrow({ where: { brandId } }),
    );
  }

  updateSettings(p: OrgPrincipal, brandId: string, input: z.infer<typeof FinanceSettingsSchema>) {
    if (!p.authz.can('settings.manage', { brandId })) throw forbidden();
    return this.db.tenant(p.organizationId, async (tx) => {
      const before = await tx.financeSettings.findUniqueOrThrow({ where: { brandId } });
      const updated = await tx.financeSettings.update({
        where: { brandId },
        data: { ...input, minConfirmAmountMinor: BigInt(input.minConfirmAmountMinor) },
      });
      await this.audit.record(tx, {
        organizationId: p.organizationId,
        brandId,
        actorUserId: p.userId,
        action: 'finance_settings.updated',
        entityType: 'finance_settings',
        entityId: before.id,
        before,
        after: input,
      });
      return updated;
    });
  }

  // ----------------------------------------------------------------- helpers
  private money(minor: bigint, currency: string) {
    const sign = minor < 0n ? '-' : '';
    const abs = minor < 0n ? -minor : minor;
    return `${sign}${currency} ${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
  }

  private leadEvent(
    tx: Tx,
    a: Admission,
    type: string,
    body: string,
    actorUserId: string | null,
    now: Date,
    data: Record<string, unknown> = {},
  ) {
    return tx.leadEvent.create({
      data: {
        organizationId: a.organizationId,
        leadId: a.leadId,
        type,
        actorUserId,
        body,
        data: JSON.parse(JSON.stringify({ admissionId: a.id, ...data })) as Prisma.InputJsonValue,
        occurredAt: now,
      },
    });
  }
}
