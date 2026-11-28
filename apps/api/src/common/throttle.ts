import { createHash } from 'node:crypto';
import { ACCESS_COOKIE } from '../auth/cookies';

const short = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 32);

/**
 * Rate-limit key: the signed-in session when there is one (so colleagues behind one office IP do not share a
 * budget), otherwise IP + e-mail for sign-in style requests, otherwise the IP. A forged token only gets a 401.
 */
export function sessionTracker(req: Record<string, unknown>): string {
  const headers = (req.headers ?? {}) as Record<string, string | undefined>;
  const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
  const auth = headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : cookies[ACCESS_COOKIE];
  if (token) return `s:${short(token)}`;
  const ip = String(req.ip ?? 'unknown');
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? `e:${ip}:${short(email.trim().toLowerCase())}` : `i:${ip}`;
}

/** Intake requests per minute per intake key (set from INTAKE_PER_MINUTE at start-up). */
export const intakeLimit = { perMinute: 120 };
