import { randomUUID } from 'node:crypto';

/** Payload sent to the LMS / batch system on confirmation — see docs/LMS-CONTRACT.md. */
export interface LmsHandoverPayload {
  version: 1;
  admissionId: string;
  admissionNumber: string;
  confirmedAt: string;
  brand: { id: string; code: string; name: string };
  course: { id: string; code: string; name: string };
  batch: { id: string; code: string; name: string; startDate: string } | null;
  student: {
    id: string;
    legalName: string;
    email: string | null;
    phone: string | null;
    dateOfBirth: string | null;
  };
}

export abstract class LmsProvider {
  abstract readonly name: string;
  abstract send(payload: LmsHandoverPayload): Promise<{ providerRef: string }>;
}

/** SANDBOX — DEVELOPMENT AND TESTS ONLY. Never registered when NODE_ENV=production (rule 10). */
export class SandboxLmsProvider extends LmsProvider {
  readonly name = 'sandbox-lms';
  failNext = 0;
  readonly received: LmsHandoverPayload[] = [];
  async send(payload: LmsHandoverPayload) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Sandbox LMS unavailable');
    }
    this.received.push(payload);
    return { providerRef: `sbx-lms-${randomUUID()}` };
  }
}

/** `null` = no LMS connected: handovers stay pending for manual handover (O-08). */
export abstract class LmsRegistry {
  abstract readonly provider: LmsProvider | null;
}

export function buildLmsRegistry(nodeEnv: string): LmsRegistry {
  return { provider: nodeEnv === 'production' ? null : new SandboxLmsProvider() };
}
