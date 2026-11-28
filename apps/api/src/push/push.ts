export interface PushMessage {
  to: string;
  title: string;
  body?: string;
  data?: Record<string, string>;
}
export interface PushTicket {
  ok: boolean;
  /** Expo's error code, e.g. DeviceNotRegistered (the app was uninstalled or the token expired). */
  error?: string;
}

/** Push delivery to the mobile app. Expo's push service in production; a labelled sandbox elsewhere. */
export abstract class PushProvider {
  abstract readonly name: string;
  abstract send(messages: PushMessage[]): Promise<PushTicket[]>;
}

export const EXPO_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,100}\]$/;

export class ExpoPushProvider extends PushProvider {
  readonly name = 'expo';
  constructor(private readonly accessToken?: string) {
    super();
  }
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(messages.map((m) => ({ ...m, sound: 'default', priority: 'high' }))),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Expo push ${res.status}`);
    const body = (await res.json()) as {
      data?: Array<{ status: string; details?: { error?: string } }>;
    };
    return (body.data ?? []).map((t) => ({ ok: t.status === 'ok', error: t.details?.error }));
  }
}

/** SANDBOX — development and tests only. Records pushes; tokens containing "Gone" act as uninstalled. */
export class SandboxPushProvider extends PushProvider {
  readonly name = 'sandbox-push';
  readonly sent: PushMessage[] = [];
  async send(messages: PushMessage[]) {
    return messages.map((m) => {
      if (m.to.includes('Gone')) return { ok: false, error: 'DeviceNotRegistered' };
      this.sent.push(m);
      return { ok: true };
    });
  }
}

export function buildPushProvider(nodeEnv: string, accessToken?: string): PushProvider {
  return nodeEnv === 'production' ? new ExpoPushProvider(accessToken) : new SandboxPushProvider();
}
