import { randomBytes } from 'node:crypto';
import { SecretBox } from './secret-box';

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32).toString('hex'));
  it('round-trips and never stores the plain text', () => {
    const sealed = box.seal('EAAB-page-token');
    expect(sealed).not.toContain('EAAB');
    expect(box.open(sealed)).toBe('EAAB-page-token');
    expect(box.seal('same')).not.toBe(box.seal('same')); // random IV
  });
  it('rejects tampering, wrong keys and short keys', () => {
    const sealed = box.seal('secret');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('xxxxxx').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
    expect(() => new SecretBox(randomBytes(32).toString('base64')).open(sealed)).toThrow();
    expect(() => new SecretBox('short')).toThrow(/32 bytes/);
  });
});
