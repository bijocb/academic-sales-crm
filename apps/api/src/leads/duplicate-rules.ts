/**
 * Pure duplicate-suggestion rules (FR-005). Suggestions only — merging is always a human decision.
 * See docs/plans/PHASE-05.md for the scoring table.
 */

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'smt', 'sri', 'kumari']);

/** Lower-case letters only (any script), honorifics removed, words sorted: "Dr. Kumar  Rahul" → "kumar rahul". */
export function nameKey(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  const words = fullName
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !HONORIFICS.has(w));
  return words.length ? words.sort().join(' ') : null;
}

/** True when two E.164 numbers of equal length differ by one digit or one adjacent swap. */
export function phoneNearMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b || a === b || a.length !== b.length) return false;
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  if (diff.length === 1) return true;
  return (
    diff.length === 2 &&
    diff[1] === diff[0] + 1 &&
    a[diff[0]] === b[diff[1]] &&
    a[diff[1]] === b[diff[0]]
  );
}

export interface PersonLike {
  fullName: string;
  nameKey?: string | null;
  phoneE164: string | null;
  email: string | null;
  city: string | null;
}

export const SUGGESTION_THRESHOLD = 0.6;

export function scorePair(a: PersonLike, b: PersonLike): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const ka = a.nameKey ?? nameKey(a.fullName);
  const kb = b.nameKey ?? nameKey(b.fullName);
  if (a.email && b.email && a.email === b.email) {
    score += 0.6;
    reasons.push('SAME_EMAIL');
  }
  if (phoneNearMatch(a.phoneE164, b.phoneE164)) {
    score += 0.5;
    reasons.push('PHONE_NEAR_MATCH');
  }
  if (ka && kb && ka === kb) {
    score += 0.3;
    reasons.push('SAME_NAME');
    if (a.city && b.city && a.city.trim().toLowerCase() === b.city.trim().toLowerCase()) {
      score += 0.1;
      reasons.push('SAME_CITY');
    }
  } else if (ka && kb) {
    const wa = new Set(ka.split(' ').filter((w) => w.length > 2));
    if (kb.split(' ').some((w) => wa.has(w))) {
      score += 0.15;
      reasons.push('NAME_WORD_OVERLAP');
    }
  }
  return { score: Math.round(score * 100) / 100, reasons };
}
