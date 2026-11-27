import { randomUUID } from 'node:crypto';

/** A provider call failed. `permanent` = retrying will not help (invalid number, rejected template…). */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly permanent: boolean,
  ) {
    super(message);
  }
}

export interface WhatsAppSend {
  to: string; // E.164
  templateName: string;
  language: string;
  body: string; // rendered text (providers that need parameters derive them from the template)
  clientRef: string; // our message id — idempotency key where the provider supports one
}

/** Official WhatsApp Business provider (Meta Cloud API or a BSP). Real adapters arrive with O-06. */
export abstract class WhatsAppProvider {
  abstract readonly name: string;
  abstract send(m: WhatsAppSend): Promise<{ providerRef: string }>;
}

/** Click-to-call: the provider rings the agent, then bridges to the customer. */
export abstract class TelephonyProvider {
  abstract readonly name: string;
  abstract dial(c: {
    agentPhone: string | null;
    customerPhone: string;
    clientRef: string;
  }): Promise<{
    providerRef: string;
  }>;
}

/**
 * SANDBOX — DEVELOPMENT AND TESTS ONLY. Never registered when NODE_ENV=production (rule 10).
 * Simulates a WhatsApp provider: numbers ending in 0000 are rejected permanently;
 * `failNext` makes the next N sends fail temporarily (used by provider-failure tests).
 */
export class SandboxWhatsAppProvider extends WhatsAppProvider {
  readonly name = 'sandbox-whatsapp';
  failNext = 0;
  readonly sent: WhatsAppSend[] = [];
  async send(m: WhatsAppSend) {
    if (m.to.endsWith('0000')) throw new ProviderError('Recipient is not a WhatsApp user', true);
    if (this.failNext > 0) {
      this.failNext--;
      throw new ProviderError('Sandbox provider temporarily unavailable', false);
    }
    this.sent.push(m);
    return { providerRef: `sbx-wa-${randomUUID()}` };
  }
}

/** SANDBOX — DEVELOPMENT AND TESTS ONLY. Pretends to place a call and returns a reference. */
export class SandboxTelephonyProvider extends TelephonyProvider {
  readonly name = 'sandbox-telephony';
  async dial() {
    return { providerRef: `sbx-call-${randomUUID()}` };
  }
}

/** Which channels are live. `null` = not configured (manual logging still works). */
export abstract class ProviderRegistry {
  abstract readonly whatsapp: WhatsAppProvider | null;
  abstract readonly telephony: TelephonyProvider | null;
  abstract readonly sandbox: boolean;
}

export function buildProviderRegistry(nodeEnv: string): ProviderRegistry {
  const sandbox = nodeEnv !== 'production';
  return {
    sandbox,
    whatsapp: sandbox ? new SandboxWhatsAppProvider() : null,
    telephony: sandbox ? new SandboxTelephonyProvider() : null,
  };
}
