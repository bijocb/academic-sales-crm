import { sessionTracker } from './throttle';

describe('rate-limit key', () => {
  const ip = '203.0.113.7';
  it('separates colleagues behind one office IP by their session', () => {
    const a = sessionTracker({ ip, headers: { authorization: 'Bearer token-a' } });
    const b = sessionTracker({ ip, headers: {}, cookies: { crm_at: 'token-b' } });
    expect(a).toMatch(/^s:/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('token-a');
  });
  it('keys sign-in requests by IP and e-mail (case-insensitive), others by IP', () => {
    const x = sessionTracker({ ip, headers: {}, body: { email: 'Asha@Example.com ' } });
    expect(x).toBe(sessionTracker({ ip, headers: {}, body: { email: 'asha@example.com' } }));
    expect(x).not.toBe(sessionTracker({ ip, headers: {}, body: { email: 'bala@example.com' } }));
    expect(x).not.toContain('asha');
    expect(sessionTracker({ ip, headers: {} })).toBe(`i:${ip}`);
  });
});
