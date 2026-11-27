import { createHash } from 'node:crypto';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { z } from '@crm/contracts';
import type { LeadInput } from '@crm/contracts';

export interface FieldIssue {
  field: string;
  message: string;
}

/** Normalizes to E.164 using the brand country as default for local numbers (e.g. 98765 43210 → +919876543210). */
export function normalizePhone(
  raw: string | undefined,
  defaultCountry: 'IN' | 'AE',
): { e164?: string; issue?: FieldIssue } {
  if (!raw || !raw.trim()) return {};
  const cleaned = raw.trim().replace(/^00/, '+');
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry as CountryCode);
  if (!parsed || !parsed.isValid())
    return { issue: { field: 'phone', message: `"${raw}" is not a valid phone number` } };
  return { e164: parsed.number };
}

const emailSchema = z.email();
export function normalizeEmail(raw: string | undefined): { email?: string; issue?: FieldIssue } {
  if (!raw || !raw.trim()) return {};
  const email = raw.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success)
    return { issue: { field: 'email', message: `"${raw}" is not a valid email address` } };
  return { email };
}

/** +919876543210 → +91••••••••10 */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  return e164.length <= 6
    ? '••••'
    : `${e164.slice(0, 3)}${'•'.repeat(e164.length - 5)}${e164.slice(-2)}`;
}

/** rahul.k@gmail.com → r••••••@gmail.com */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [user, domain] = email.split('@');
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(user.length - 1, 3))}@${domain}`;
}

/**
 * Idempotency key for an inbound lead:
 * - provider/external ID when present (replays of the same provider event collapse),
 * - otherwise a hash of the canonical submission plus its calendar day (identical
 *   resubmissions on the same day collapse; a genuine repeat enquiry on a later day does not).
 */
export function dedupKeyFor(channel: string, input: LeadInput, receivedAt: Date): string {
  if (input.externalId) return `ext:${channel}:${input.externalId}`;
  const canonical = Object.keys(input)
    .filter(
      (k) =>
        k !== 'receivedAt' &&
        input[k as keyof LeadInput] !== undefined &&
        input[k as keyof LeadInput] !== '',
    )
    .sort()
    .map((k) => [
      k,
      String(input[k as keyof LeadInput])
        .trim()
        .toLowerCase(),
    ]);
  const day = receivedAt.toISOString().slice(0, 10);
  return `hash:${createHash('sha256')
    .update(JSON.stringify([channel, day, canonical]))
    .digest('hex')}`;
}
