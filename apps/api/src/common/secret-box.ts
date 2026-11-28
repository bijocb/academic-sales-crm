import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts third-party tokens at rest (AES-256-GCM). Sealed format: `v1.<iv>.<tag>.<ciphertext>` (base64url).
 * The key comes from SECRETS_KEY (32 bytes, base64 or hex) and never from the database.
 */
export class SecretBox {
  private readonly key: Buffer;
  constructor(secret: string) {
    const k = /^[0-9a-f]{64}$/i.test(secret)
      ? Buffer.from(secret, 'hex')
      : Buffer.from(secret, 'base64');
    if (k.length !== 32)
      throw new Error('SECRETS_KEY must be 32 bytes (64 hex characters or base64)');
    this.key = k;
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv, c.getAuthTag(), data]
      .map((x) => (typeof x === 'string' ? x : x.toString('base64url')))
      .join('.');
  }

  open(sealed: string): string {
    const [v, iv, tag, data] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised sealed secret');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  }
}
