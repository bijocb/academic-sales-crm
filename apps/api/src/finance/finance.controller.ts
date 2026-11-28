import {
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  FeeAdjustmentSchema,
  FinanceSettingsSchema,
  ManualPaymentSchema,
  PaymentLinkSchema,
  RefundDecisionSchema,
  RefundListQuerySchema,
  RefundPaidSchema,
  RefundRejectSchema,
  RefundRequestSchema,
  ScheduleSchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal, Public } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { FinanceService } from './finance.service';
import { GatewayRegistry, SandboxGateway } from './gateway';

const BrandQ = z.object({ brandId: z.uuid() });
const OptBrandQ = z.object({ brandId: z.uuid().optional() });
const OutcomeQ = z.object({ outcome: z.enum(['SUCCEEDED', 'FAILED']) });
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

@ApiTags('finance')
@Controller()
export class FinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly gateways: GatewayRegistry,
  ) {}

  @Get('admissions/:id/finance')
  view(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.finance.finance(requireOrg(p), id);
  }

  @Post('admissions/:id/confirm')
  confirm(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.finance.confirm(requireOrg(p), id);
  }

  @Put('fee-plans/:id/schedule')
  @ApiZodBody(ScheduleSchema)
  schedule(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(ScheduleSchema) body: z.infer<typeof ScheduleSchema>,
  ) {
    return this.finance.setSchedule(requireOrg(p), id, body);
  }

  @Post('fee-plans/:id/adjustments')
  @ApiZodBody(FeeAdjustmentSchema)
  adjust(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(FeeAdjustmentSchema) body: z.infer<typeof FeeAdjustmentSchema>,
  ) {
    return this.finance.adjust(requireOrg(p), id, body);
  }

  @Post('fee-plans/:id/payment-links')
  @ApiZodBody(PaymentLinkSchema)
  link(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(PaymentLinkSchema) body: z.infer<typeof PaymentLinkSchema>,
  ) {
    return this.finance.paymentLink(requireOrg(p), id, body);
  }

  @Post('fee-plans/:id/payments')
  @ApiZodBody(ManualPaymentSchema)
  manual(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(ManualPaymentSchema) body: z.infer<typeof ManualPaymentSchema>,
  ) {
    return this.finance.recordManual(requireOrg(p), id, body);
  }

  @Get('payment-attempts/:id')
  attempt(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.finance.attempt(requireOrg(p), id);
  }

  @Post('payment-attempts/:id/check')
  check(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.finance.checkAttempt(requireOrg(p), id);
  }

  @Get('payments/:id/receipt')
  receipt(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.finance.receipt(requireOrg(p), id);
  }

  @Post('payments/:id/refunds')
  @ApiZodBody(RefundRequestSchema)
  requestRefund(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(RefundRequestSchema) body: z.infer<typeof RefundRequestSchema>,
  ) {
    return this.finance.requestRefund(requireOrg(p), id, body);
  }

  @Post('refunds/:id/approve')
  @ApiZodBody(RefundDecisionSchema)
  approve(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(RefundDecisionSchema) body: z.infer<typeof RefundDecisionSchema>,
  ) {
    return this.finance.approveRefund(requireOrg(p), id, body);
  }

  @Post('refunds/:id/reject')
  @ApiZodBody(RefundRejectSchema)
  rejectRefund(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(RefundRejectSchema) body: z.infer<typeof RefundRejectSchema>,
  ) {
    return this.finance.rejectRefund(requireOrg(p), id, body);
  }

  @Post('refunds/:id/paid')
  @ApiZodBody(RefundPaidSchema)
  paid(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(RefundPaidSchema) body: z.infer<typeof RefundPaidSchema>,
  ) {
    return this.finance.markRefundPaid(requireOrg(p), id, body);
  }

  @Get('finance/refunds')
  refunds(
    @CurrentPrincipal() p: Principal,
    @ZQuery(RefundListQuerySchema) q: z.infer<typeof RefundListQuerySchema>,
  ) {
    return this.finance.refunds(requireOrg(p), q);
  }

  @Get('finance/reconciliation')
  reconciliation(
    @CurrentPrincipal() p: Principal,
    @ZQuery(OptBrandQ) q: z.infer<typeof OptBrandQ>,
  ) {
    return this.finance.reconciliation(requireOrg(p), q.brandId);
  }

  @Get('finance-settings')
  settings(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.finance.settings(requireOrg(p), q.brandId);
  }

  @Put('finance-settings')
  @ApiZodBody(FinanceSettingsSchema)
  updateSettings(
    @CurrentPrincipal() p: Principal,
    @ZQuery(BrandQ) q: z.infer<typeof BrandQ>,
    @ZBody(FinanceSettingsSchema) body: z.infer<typeof FinanceSettingsSchema>,
  ) {
    return this.finance.updateSettings(requireOrg(p), q.brandId, body);
  }

  /** Gateway webhooks: the signature over the raw body is the only authentication. */
  @Public()
  @ApiExcludeEndpoint()
  @Post('webhooks/payments/:provider')
  @HttpCode(200)
  webhook(@Param('provider') provider: string, @Req() req: RawBodyRequest<Request>) {
    return this.finance.webhook(provider, req.rawBody, req.headers);
  }

  // ------------------------------------------------- SANDBOX (dev/test only)
  private sandbox(): SandboxGateway {
    const g = this.gateways.get('sandbox');
    if (!(g instanceof SandboxGateway)) throw new NotFoundException();
    return g;
  }

  /** SANDBOX checkout page — plays the gateway's hosted page. 404 in production. */
  @Public()
  @ApiExcludeEndpoint()
  @Get('sandbox/checkout/:orderId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async checkout(@Param('orderId') orderId: string) {
    const o = await this.sandbox()
      .fetchOrder(orderId)
      .catch(() => {
        throw new NotFoundException();
      });
    const amount = `${o.currency} ${(Number(o.amountMinor) / 100).toFixed(2)}`;
    const id = escape(orderId);
    return `<!doctype html><meta charset="utf-8"><title>Sandbox checkout</title>
<body style="font-family:system-ui;max-width:28rem;margin:3rem auto">
<p style="background:#fef3c7;padding:.5rem">SANDBOX — test payments only, no real money.</p>
<h1>Pay ${escape(amount)}</h1><p>Status: ${escape(o.status)}</p>
<form method="post" action="/api/v1/sandbox/checkout/${id}/complete?outcome=SUCCEEDED"><button>Pay (success)</button></form>
<form method="post" action="/api/v1/sandbox/checkout/${id}/complete?outcome=FAILED"><button>Fail payment</button></form>
</body>`;
  }

  /** SANDBOX: the customer pays; the sandbox delivers the signed webhook like a real gateway would. */
  @Public()
  @ApiExcludeEndpoint()
  @Post('sandbox/checkout/:orderId/complete')
  @HttpCode(200)
  @Header('Content-Type', 'text/html; charset=utf-8')
  async complete(@Param('orderId') orderId: string, @ZQuery(OutcomeQ) q: z.infer<typeof OutcomeQ>) {
    const g = this.sandbox();
    let hook: { body: string; signature: string };
    try {
      hook = g.complete(orderId, q.outcome);
    } catch {
      throw new NotFoundException();
    }
    await this.finance.webhook('sandbox', Buffer.from(hook.body), {
      'x-sandbox-signature': hook.signature,
    });
    return `<!doctype html><meta charset="utf-8"><title>Sandbox checkout</title><body style="font-family:system-ui;max-width:28rem;margin:3rem auto"><p>SANDBOX — payment ${q.outcome === 'SUCCEEDED' ? 'completed' : 'failed'}. You can close this page.</p></body>`;
  }
}
