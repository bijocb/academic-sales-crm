import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config';

export interface LinkClaims {
  f: string; // file id
  o: string; // organization id
  u: string; // user id (audited on download)
  e: number; // expiry (epoch ms)
}

/** Short-lived signed download links for student documents (SRS §9: expiring signed URLs). */
@Injectable()
export class DownloadLinks {
  static readonly TTL_MS = 5 * 60_000;
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = createHmac('sha256', config.JWT_ACCESS_SECRET)
      .update('crm:document-links:v1')
      .digest();
  }

  sign(claims: LinkClaims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  /** Returns the claims if the token is authentic and not expired at `nowMs`. */
  verify(token: string, nowMs: number): LinkClaims | null {
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as LinkClaims;
      return claims.e > nowMs ? claims : null;
    } catch {
      return null;
    }
  }

  private mac(body: string) {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}
