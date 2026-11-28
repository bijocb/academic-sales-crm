import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LeadInput } from '@crm/contracts';

/** One Lead Ads submission as returned by the Graph API (`GET /<leadgen_id>`). */
export interface MetaLead {
  id: string;
  created_time?: string;
  field_data: Array<{ name: string; values?: string[] }>;
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
  platform?: string;
  is_organic?: boolean;
}

export const META_LEAD_FIELDS =
  'id,created_time,field_data,ad_id,adset_id,campaign_id,campaign_name,form_id,platform,is_organic';

/** Graph API access. The real client in production; a labelled sandbox in development and tests (A-047). */
export abstract class MetaClient {
  abstract readonly name: 'graph' | 'sandbox';
  abstract fetchLead(leadgenId: string, pageToken: string): Promise<MetaLead>;
  /** Subscribes the page to the app's `leadgen` webhook. */
  abstract subscribePage(pageId: string, pageToken: string): Promise<void>;
}

export class GraphMetaClient extends MetaClient {
  readonly name = 'graph' as const;
  constructor(
    private readonly version: string,
    private readonly appSecret: string,
  ) {
    super();
  }

  /** appsecret_proof binds the token to this app (recommended by Meta for server calls). */
  private proof(token: string) {
    return createHmac('sha256', this.appSecret).update(token).digest('hex');
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    params: Record<string, string> = {},
  ) {
    const q = new URLSearchParams({
      ...params,
      access_token: token,
      appsecret_proof: this.proof(token),
    });
    const res = await fetch(`https://graph.facebook.com/${this.version}/${path}?${q}`, {
      method,
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number };
    };
    if (!res.ok || body.error)
      throw new Error(
        `Graph API ${res.status}: ${body.error?.message ?? 'request failed'} (code ${body.error?.code ?? '-'})`,
      );
    return body;
  }

  async fetchLead(leadgenId: string, pageToken: string) {
    if (!/^\d+$/.test(leadgenId)) throw new Error('Invalid lead id');
    return (await this.call('GET', leadgenId, pageToken, {
      fields: META_LEAD_FIELDS,
    })) as unknown as MetaLead;
  }

  async subscribePage(pageId: string, pageToken: string) {
    await this.call('POST', `${pageId}/subscribed_apps`, pageToken, {
      subscribed_fields: 'leadgen',
    });
  }
}

/**
 * SANDBOX — development and tests only, never in production. Holds fake leads in memory so the whole flow
 * (webhook → job → intake) can be exercised without Meta.
 */
export class SandboxMetaClient extends MetaClient {
  readonly name = 'sandbox' as const;
  readonly leads = new Map<string, MetaLead>();
  readonly subscribed = new Set<string>();
  failures = 0;

  async fetchLead(leadgenId: string, pageToken: string) {
    if (pageToken !== 'sandbox-page-token')
      throw new Error('Graph API 190: Invalid OAuth access token (sandbox)');
    if (this.failures > 0) {
      this.failures--;
      throw new Error('Graph API 500: temporary error (sandbox)');
    }
    const lead = this.leads.get(leadgenId);
    if (!lead) throw new Error('Graph API 100: lead not found (sandbox)');
    return lead;
  }

  async subscribePage(pageId: string, pageToken: string) {
    if (pageToken !== 'sandbox-page-token')
      throw new Error('Graph API 190: Invalid OAuth access token (sandbox)');
    this.subscribed.add(pageId);
  }
}

export function buildMetaClient(
  nodeEnv: string,
  version: string,
  appSecret?: string,
): MetaClient | null {
  if (nodeEnv !== 'production') return new SandboxMetaClient();
  return appSecret ? new GraphMetaClient(version, appSecret) : null;
}

/** `X-Hub-Signature-256: sha256=<hex HMAC of the raw body with the app secret>`. */
export function validMetaSignature(
  raw: Buffer | undefined,
  header: string | undefined,
  appSecret: string,
) {
  if (!raw || !header?.startsWith('sha256=')) return false;
  const want = createHmac('sha256', appSecret).update(raw).digest();
  const got = Buffer.from(header.slice(7), 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

const KNOWN = new Set([
  'full_name',
  'first_name',
  'last_name',
  'phone_number',
  'phone',
  'email',
  'city',
]);

/** Maps Lead Ads form fields to the common intake shape; custom questions go into the message. */
export function metaToLead(m: MetaLead): LeadInput {
  const v = (n: string) =>
    m.field_data.find((f) => f.name.toLowerCase() === n)?.values?.[0]?.trim() || undefined;
  const name =
    v('full_name') ?? ([v('first_name'), v('last_name')].filter(Boolean).join(' ') || undefined);
  const answers = m.field_data
    .filter((f) => !KNOWN.has(f.name.toLowerCase()))
    .map((f) => `${f.name.replace(/_/g, ' ')}: ${(f.values ?? []).join(', ')}`)
    .join('\n');
  return {
    name,
    phone: v('phone_number') ?? v('phone'),
    email: v('email'),
    city: v('city'),
    message: answers || undefined,
    externalId: m.id,
    formId: m.form_id,
    adId: m.ad_id,
    adsetId: m.adset_id,
    utm_source: m.platform === 'ig' ? 'instagram' : 'facebook',
    utm_medium: m.is_organic ? 'organic' : 'paid_social',
    // Matched against the campaign's external id first, then its UTM name (see intake).
    utm_campaign: m.campaign_id ?? m.campaign_name,
    // Meta sends `2026-11-28T10:00:00+0000`; ISO 8601 needs `+00:00`.
    ...(m.created_time ? { receivedAt: m.created_time.replace(/([+-]\d\d)(\d\d)$/, '$1:$2') } : {}),
  };
}
