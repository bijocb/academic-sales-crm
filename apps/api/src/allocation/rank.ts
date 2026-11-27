/**
 * Pure allocation decision (FR-007): eligibility filters + deterministic ranking. No I/O.
 */
export type Strategy = 'LEAST_LOADED' | 'ROUND_ROBIN';

export type Exclusion =
  | 'UNAVAILABLE'
  | 'ON_LEAVE'
  | 'AT_CAPACITY'
  | 'LANGUAGE_MISMATCH'
  | 'EXCLUDED'
  | 'NOT_IN_RULE_POOL';

export interface CandidateInput {
  userId: string;
  name: string;
  isAvailable: boolean;
  onLeave: boolean;
  activeLeads: number;
  maxActiveLeads: number | null;
  languages: string[];
  lastAssignedAt: Date | null;
}

export interface CandidateResult {
  userId: string;
  name: string;
  activeLeads: number;
  maxActiveLeads: number | null;
  lastAssignedAt: string | null;
  excluded: Exclusion[];
  rank?: number;
}

export interface Decision {
  chosen: string | null;
  candidates: CandidateResult[];
}

/** Lower is better. Unlimited capacity is treated as a soft limit of 1000 for the ratio. */
const loadRatio = (c: CandidateInput) =>
  c.activeLeads / (c.maxActiveLeads && c.maxActiveLeads > 0 ? c.maxActiveLeads : 1000);
/** Never-assigned users sort first (0 is earlier than any real timestamp). */
const lastTime = (c: CandidateInput) => (c.lastAssignedAt ? c.lastAssignedAt.getTime() : 0);

export function decide(
  candidates: CandidateInput[],
  opts: {
    strategy: Strategy;
    leadLanguage?: string | null;
    pool?: Set<string> | null;
    exclude?: Set<string>;
  },
): Decision {
  const results: CandidateResult[] = [];
  const eligible: CandidateInput[] = [];
  for (const c of candidates) {
    const excluded: Exclusion[] = [];
    if (opts.pool && !opts.pool.has(c.userId)) excluded.push('NOT_IN_RULE_POOL');
    if (opts.exclude?.has(c.userId)) excluded.push('EXCLUDED');
    if (!c.isAvailable) excluded.push('UNAVAILABLE');
    if (c.onLeave) excluded.push('ON_LEAVE');
    if (c.maxActiveLeads !== null && c.activeLeads >= c.maxActiveLeads)
      excluded.push('AT_CAPACITY');
    const lang = opts.leadLanguage?.trim().toLowerCase();
    if (lang && c.languages.length > 0 && !c.languages.map((l) => l.toLowerCase()).includes(lang))
      excluded.push('LANGUAGE_MISMATCH');
    results.push({
      userId: c.userId,
      name: c.name,
      activeLeads: c.activeLeads,
      maxActiveLeads: c.maxActiveLeads,
      lastAssignedAt: c.lastAssignedAt?.toISOString() ?? null,
      excluded,
    });
    if (!excluded.length) eligible.push(c);
  }
  const ordered = [...eligible].sort((a, b) => {
    if (opts.strategy === 'LEAST_LOADED') {
      const d = loadRatio(a) - loadRatio(b);
      if (d !== 0) return d;
    }
    const t = lastTime(a) - lastTime(b); // least recently assigned first
    if (t !== 0) return t;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0; // final deterministic tie-break
  });
  ordered.forEach((c, i) => {
    const r = results.find((x) => x.userId === c.userId)!;
    r.rank = i + 1;
  });
  return { chosen: ordered[0]?.userId ?? null, candidates: results };
}

export interface RuleLike {
  id: string;
  active: boolean;
  courseIds: string[];
  channels: string[];
  languages: string[];
  cities: string[];
}

/** First active rule whose every non-empty condition matches the lead. */
export function matchRule<R extends RuleLike>(
  rules: R[],
  lead: { courseId: string | null; channel: string; language: string | null; city: string | null },
): R | null {
  const norm = (s: string | null) => s?.trim().toLowerCase() ?? null;
  for (const r of rules) {
    if (!r.active) continue;
    if (r.courseIds.length && (!lead.courseId || !r.courseIds.includes(lead.courseId))) continue;
    if (r.channels.length && !r.channels.includes(lead.channel)) continue;
    if (
      r.languages.length &&
      (!lead.language || !r.languages.map((x) => x.toLowerCase()).includes(norm(lead.language)!))
    )
      continue;
    if (
      r.cities.length &&
      (!lead.city || !r.cities.map((x) => x.toLowerCase()).includes(norm(lead.city)!))
    )
      continue;
    return r;
  }
  return null;
}
