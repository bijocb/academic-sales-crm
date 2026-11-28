import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type GatewayStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'DISPUTED';

export interface GatewayOrderState {
  orderId: string;
  status: GatewayStatus;
  amountMinor: bigint;
  currency: string;
  paymentRef: string | null;
}

export interface GatewayEvent extends GatewayOrderState {
  eventId: string;
  type: string;
}

/**
 * A payment gateway (Razorpay, Cashfree, PayU, Telr, Network International, Stripe, Checkout.com… — O-09).
 * The CRM trusts only two things: webhooks whose signature verifies over the raw body,
 * and order look-ups it makes itself (`fetchOrder`). Browser redirects are never trusted.
 */
export abstract class PaymentGateway {
  abstract readonly name: string;
  abstract createOrder(o: { amountMinor: bigint; currency: string; reference: string }): Promise<{
    orderId: string;
    checkoutUrl: string;
  }>;
  abstract verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): boolean;
  abstract parseEvent(rawBody: Buffer): GatewayEvent;
  abstract fetchOrder(orderId: string): Promise<GatewayOrderState>;
}

/**
 * SANDBOX — DEVELOPMENT AND TESTS ONLY. Never registered when NODE_ENV=production (rule 10).
 * Keeps orders in memory; `complete()` plays the customer paying and returns the signed webhook
 * the real gateway would send. Signature: hex HMAC-SHA256 of the raw body in `x-sandbox-signature`.
 */
export class SandboxGateway extends PaymentGateway {
  readonly name = 'sandbox';
  private readonly orders = new Map<string, GatewayOrderState>();

  constructor(private readonly secret: string) {
    super();
  }

  async createOrder(o: { amountMinor: bigint; currency: string; reference: string }) {
    const orderId = `sbx_order_${randomUUID()}`;
    this.orders.set(orderId, {
      orderId,
      status: 'PENDING',
      amountMinor: o.amountMinor,
      currency: o.currency,
      paymentRef: null,
    });
    return { orderId, checkoutUrl: `/api/v1/sandbox/checkout/${orderId}` };
  }

  sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('hex');
  }

  verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const given = headers['x-sandbox-signature'];
    if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false;
    const expected = Buffer.from(createHmac('sha256', this.secret).update(rawBody).digest('hex'));
    return timingSafeEqual(expected, Buffer.from(given));
  }

  parseEvent(rawBody: Buffer): GatewayEvent {
    const e = JSON.parse(rawBody.toString('utf8')) as {
      id: string;
      type: string;
      orderId: string;
      status: GatewayStatus;
      amountMinor: string | number;
      currency: string;
      paymentRef?: string | null;
    };
    return {
      eventId: e.id,
      type: e.type,
      orderId: e.orderId,
      status: e.status,
      amountMinor: BigInt(e.amountMinor),
      currency: e.currency,
      paymentRef: e.paymentRef ?? null,
    };
  }

  async fetchOrder(orderId: string): Promise<GatewayOrderState> {
    const o = this.orders.get(orderId);
    if (!o) throw new Error('Unknown sandbox order');
    return { ...o };
  }

  /** The customer finishes checkout. Returns the webhook body + signature (the caller may or may not deliver it). */
  complete(orderId: string, outcome: 'SUCCEEDED' | 'FAILED' | 'DISPUTED', amountMinor?: bigint) {
    const o = this.orders.get(orderId);
    if (!o) throw new Error('Unknown sandbox order');
    o.status = outcome;
    if (outcome === 'SUCCEEDED') o.paymentRef = `sbx_pay_${randomUUID()}`;
    const body = JSON.stringify({
      id: `sbx_evt_${randomUUID()}`,
      type: `payment.${outcome.toLowerCase()}`,
      orderId,
      status: outcome,
      amountMinor: String(amountMinor ?? o.amountMinor),
      currency: o.currency,
      paymentRef: o.paymentRef,
    });
    return { body, signature: this.sign(body) };
  }
}

export abstract class GatewayRegistry {
  abstract get(name: string): PaymentGateway | null;
  /** The gateway used for new payment links (null = none configured). */
  abstract readonly primary: PaymentGateway | null;
}

export function buildGatewayRegistry(nodeEnv: string, sandboxSecret: string): GatewayRegistry {
  const sandbox = nodeEnv === 'production' ? null : new SandboxGateway(sandboxSecret);
  return {
    primary: sandbox,
    get: (name: string) => (sandbox && name === sandbox.name ? sandbox : null),
  };
}
