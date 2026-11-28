/**
 * Explainable lead-priority scoring (FR-006, FR-021, A-045). Pure functions — no I/O, no clock.
 *
 * Only the factors in FACTORS are ever used. They describe the enquiry and the first 3 days of engagement, never the
 * person (see docs/AI-REVIEW.md). `Features` deliberately has no field that could carry personal data.
 */

export interface Features {
  channel: string;
  paidCampaign: 'yes' | 'no';
  courseChosen: 'yes' | 'no';
  repeatEnquiry: '1' | '2' | '3+';
  firstResponse: 'on_time' | 'late' | 'none';
  connected3d: 'yes' | 'no';
}
export type FactorKey = keyof Features;

export const FACTORS: Record<FactorKey, string> = {
  channel: 'Source channel',
  paidCampaign: 'Paid campaign',
  courseChosen: 'Course chosen at enquiry',
  repeatEnquiry: 'Enquiries received',
  firstResponse: 'First response',
  connected3d: 'Connected within 3 days',
};
export const FACTOR_KEYS = Object.keys(FACTORS) as FactorKey[];

/** Attributes that must never become scoring factors (bias review, docs/AI-REVIEW.md). */
export const PROHIBITED = [
  'name',
  'fullName',
  'phone',
  'phoneE164',
  'email',
  'countryCode',
  'city',
  'location',
  'language',
  'age',
  'dateOfBirth',
  'gender',
  'nationality',
  'religion',
  'qualification',
  'notes',
  'ownerId',
  'counsellorId',
] as const;

export type Band = 'HIGH' | 'MEDIUM' | 'LOW';
export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface Contribution {
  factor: FactorKey;
  label: string;
  value: string;
  /** Log-odds contribution (model) or points (rules); positive raises priority. */
  weight: number;
}

export interface ModelStats {
  n: number;
  positives: number;
  /** factor → value → [conversions, non-conversions] */
  counts: Record<FactorKey, Record<string, [number, number]>>;
}

export interface Sample {
  features: Features;
  converted: boolean;
}

export const MODEL_RULES_VERSION = 'rules-v1';
export const modelVersion = (v: number) => `nb-v${v}`;

export function train(samples: Sample[]): ModelStats {
  const counts = Object.fromEntries(FACTOR_KEYS.map((k) => [k, {}])) as ModelStats['counts'];
  let positives = 0;
  for (const s of samples) {
    if (s.converted) positives++;
    for (const k of FACTOR_KEYS) {
      const v = s.features[k];
      const c = (counts[k][v] ??= [0, 0]);
      c[s.converted ? 0 : 1]++;
    }
  }
  return { n: samples.length, positives, counts };
}

/** Enough history to calibrate: a minimum size and both outcomes present. */
export function usable(stats: ModelStats, minSize: number): boolean {
  return stats.n >= minSize && stats.positives >= 5 && stats.n - stats.positives >= 5;
}

export function confidenceFor(n: number): Confidence {
  return n >= 500 ? 'HIGH' : n >= 150 ? 'MEDIUM' : 'LOW';
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Naive Bayes with Laplace smoothing: logit = ln(prior odds) + Σ ln(P(v|converted) / P(v|not converted)).
 * Each term is one factor's contribution, so the explanation adds up exactly to the prediction.
 */
export function predict(stats: ModelStats, f: Features) {
  const pos = stats.positives;
  const neg = stats.n - stats.positives;
  const prior = Math.log((pos + 1) / (neg + 1));
  const exact = FACTOR_KEYS.map((k) => {
    const values = Object.keys(stats.counts[k]);
    const levels = Math.max(values.length + (values.includes(f[k]) ? 0 : 1), 2);
    const [p, q] = stats.counts[k][f[k]] ?? [0, 0];
    return Math.log((p + 1) / (pos + levels)) - Math.log((q + 1) / (neg + levels));
  });
  // The prediction uses exact weights; only the displayed weights are rounded.
  const logit = prior + exact.reduce((s, w) => s + w, 0);
  const contributions: Contribution[] = FACTOR_KEYS.map((k, i) => ({
    factor: k,
    label: FACTORS[k],
    value: f[k],
    weight: round(exact[i]),
  }));
  const probability = 1 / (1 + Math.exp(-logit));
  return { prior: round(prior), logit: round(logit), probability, contributions };
}

/** Transparent fallback when there is no usable model (labelled `rules-v1`). */
export const RULE_POINTS: Record<FactorKey, Record<string, number>> = {
  channel: { REFERRAL: 10, WEBSITE: 5, CALL: 5, WHATSAPP: 5, EVENT: 5 },
  paidCampaign: { yes: 5 },
  courseChosen: { yes: 15 },
  repeatEnquiry: { '2': 10, '3+': 15 },
  firstResponse: { on_time: 10 },
  connected3d: { yes: 30 },
};
export const RULE_BASE = 15;

export function rules(f: Features) {
  const contributions: Contribution[] = FACTOR_KEYS.map((k) => ({
    factor: k,
    label: FACTORS[k],
    value: f[k],
    weight: RULE_POINTS[k][f[k]] ?? 0,
  }));
  const score = Math.min(100, RULE_BASE + contributions.reduce((s, c) => s + c.weight, 0));
  return { score, contributions };
}

export function bandForProbability(p: number, highBp: number, mediumBp: number): Band {
  const bp = p * 10000;
  return bp >= highBp ? 'HIGH' : bp >= mediumBp ? 'MEDIUM' : 'LOW';
}
export const bandForRules = (score: number): Band =>
  score >= 60 ? 'HIGH' : score >= 35 ? 'MEDIUM' : 'LOW';

export const repeatBucket = (n: number): Features['repeatEnquiry'] =>
  n >= 3 ? '3+' : n === 2 ? '2' : '1';
