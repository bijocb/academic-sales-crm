/**
 * Management insights (A-051): pure rules over report figures. No database, no clock; every threshold is listed in
 * docs/plans/AI-MANAGEMENT.md (ASSUMED until the owner changes them).
 */

export type Severity = 'HIGH' | 'MEDIUM';
export type InsightKind =
  | 'FIRST_RESPONSE_DROP'
  | 'CONTACT_RATE_DROP'
  | 'ADMISSIONS_DROP'
  | 'EXEC_OVERDUE'
  | 'EXEC_LOW_CONTACT'
  | 'EXEC_SLA_BREACHES'
  | 'SOURCE_COST_SPIKE'
  | 'SOURCE_NO_ADMISSIONS'
  | 'TARGET_AT_RISK'
  | 'STUCK_LEADS';

export interface Insight {
  /** Stable for the same subject and kind (used to de-duplicate). */
  key: string;
  kind: InsightKind;
  severity: Severity;
  subject: {
    type: 'scope' | 'executive' | 'source' | 'campaign' | 'target';
    id: string | null;
    name: string;
  };
  title: string;
  detail: string;
  /** The numbers behind the insight. */
  evidence: Record<string, number | string | null>;
  action: string;
}

/** The subset of the report summary the rules read. */
export interface SummaryFigures {
  firstResponse: { started: number; withinTarget: number };
  contactRate: { cohort: number; connected: number };
  admissions: { confirmed: number };
}
export interface ExecRow {
  key: string;
  label: string;
  assigned: number;
  contacted: number;
  firstResponse: { started: number; withinTarget: number };
  overdueTasks: number;
  openLeads: number;
  avgOpenLeadAgeDays: number | null;
}
export interface SourceRow {
  key: string;
  label: string;
  leadsCreated: number;
  admissions: { confirmed: number };
  spend?: Array<{ currency: string; amountMinor: bigint }>;
}
export interface TargetRow {
  id: string;
  label: string;
  metric: string;
  value: bigint;
  achieved: bigint;
  currency: string | null;
  /** Fraction of the target's period already passed, 0..1. */
  elapsed: number;
}
export interface InsightInput {
  current: SummaryFigures;
  previous: SummaryFigures;
  executives: ExecRow[];
  sources: { current: SourceRow[]; previous: SourceRow[]; kind: 'source' | 'campaign' }[];
  targets: TargetRow[];
}

const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const money = (minor: bigint, currency: string) =>
  `${currency} ${(Number(minor) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

function rateDrop(
  kind: 'FIRST_RESPONSE_DROP' | 'CONTACT_RATE_DROP',
  now: { n: number; d: number },
  before: { n: number; d: number },
): Insight | null {
  if (now.d < 10 || before.d < 10) return null;
  const a = pct(now.n, now.d)!;
  const b = pct(before.n, before.d)!;
  const drop = Math.round((b - a) * 10) / 10;
  if (drop < 10) return null;
  const fr = kind === 'FIRST_RESPONSE_DROP';
  return {
    key: kind,
    kind,
    severity: drop >= 20 ? 'HIGH' : 'MEDIUM',
    subject: { type: 'scope', id: null, name: 'All in scope' },
    title: fr
      ? `First response on time fell to ${a}% (from ${b}%)`
      : `Contact rate fell to ${a}% (from ${b}%)`,
    detail: fr
      ? `${now.n} of ${now.d} new leads were answered within the SLA target, against ${before.n} of ${before.d} in the previous period.`
      : `${now.n} of ${now.d} assigned leads were reached, against ${before.n} of ${before.d} in the previous period.`,
    evidence: {
      current: a,
      previous: b,
      dropPoints: drop,
      currentBase: now.d,
      previousBase: before.d,
    },
    action: fr
      ? 'Check who is short of time for new leads (see the executives below) and rebalance allocation or working hours.'
      : 'Review call attempts on new leads; check wrong numbers by source and call-back follow-ups.',
  };
}

export function computeInsights(input: InsightInput): Insight[] {
  const out: Insight[] = [];
  const { current: c, previous: p } = input;

  const fr = rateDrop(
    'FIRST_RESPONSE_DROP',
    { n: c.firstResponse.withinTarget, d: c.firstResponse.started },
    { n: p.firstResponse.withinTarget, d: p.firstResponse.started },
  );
  if (fr) out.push(fr);
  const cr = rateDrop(
    'CONTACT_RATE_DROP',
    { n: c.contactRate.connected, d: c.contactRate.cohort },
    { n: p.contactRate.connected, d: p.contactRate.cohort },
  );
  if (cr) out.push(cr);

  if (p.admissions.confirmed >= 4) {
    const fall = (p.admissions.confirmed - c.admissions.confirmed) / p.admissions.confirmed;
    if (fall >= 0.25)
      out.push({
        key: 'ADMISSIONS_DROP',
        kind: 'ADMISSIONS_DROP',
        severity: fall >= 0.5 ? 'HIGH' : 'MEDIUM',
        subject: { type: 'scope', id: null, name: 'All in scope' },
        title: `Admissions down ${Math.round(fall * 100)}% (${c.admissions.confirmed} vs ${p.admissions.confirmed})`,
        detail: `Confirmed admissions fell from ${p.admissions.confirmed} to ${c.admissions.confirmed} compared with the previous period of the same length.`,
        evidence: { current: c.admissions.confirmed, previous: p.admissions.confirmed },
        action:
          'Look at counselling and quotation follow-ups in the pipeline, and at which sources and executives fell most.',
      });
  }

  // Executives (people with leads; "Unassigned" is not a person).
  const people = input.executives.filter((e) => e.key !== 'none');
  const med = median(people.map((e) => e.overdueTasks));
  const totalAssigned = people.reduce((s, e) => s + e.assigned, 0);
  const totalContacted = people.reduce((s, e) => s + e.contacted, 0);
  const scopeRate = pct(totalContacted, totalAssigned);
  for (const e of people) {
    if (e.overdueTasks >= 5 && e.overdueTasks >= 2 * med)
      out.push({
        key: `EXEC_OVERDUE:${e.key}`,
        kind: 'EXEC_OVERDUE',
        severity:
          e.overdueTasks >= 20 || (med > 0 && e.overdueTasks >= 4 * med) ? 'HIGH' : 'MEDIUM',
        subject: { type: 'executive', id: e.key, name: e.label },
        title: `${e.label} has ${e.overdueTasks} overdue tasks`,
        detail: `The team median is ${med}. ${e.label} holds ${e.openLeads} open leads.`,
        evidence: { overdueTasks: e.overdueTasks, teamMedian: med, openLeads: e.openLeads },
        action: `Talk to ${e.label} today; move some open leads to colleagues with capacity.`,
      });
    const rate = pct(e.contacted, e.assigned);
    if (e.assigned >= 10 && rate !== null && scopeRate !== null && scopeRate - rate >= 15)
      out.push({
        key: `EXEC_LOW_CONTACT:${e.key}`,
        kind: 'EXEC_LOW_CONTACT',
        severity: 'MEDIUM',
        subject: { type: 'executive', id: e.key, name: e.label },
        title: `${e.label} reached ${rate}% of assigned leads (team ${scopeRate}%)`,
        detail: `${e.contacted} of ${e.assigned} leads assigned in the period were contacted.`,
        evidence: { contactRate: rate, scopeRate, assigned: e.assigned, contacted: e.contacted },
        action: `Review ${e.label}'s call attempts and timing; pair with a stronger caller for a few days.`,
      });
    const started = e.firstResponse.started;
    if (started >= 5) {
      const missed = started - e.firstResponse.withinTarget;
      const share = missed / started;
      if (share >= 0.3)
        out.push({
          key: `EXEC_SLA_BREACHES:${e.key}`,
          kind: 'EXEC_SLA_BREACHES',
          severity: share >= 0.5 ? 'HIGH' : 'MEDIUM',
          subject: { type: 'executive', id: e.key, name: e.label },
          title: `${e.label} missed the first-response target on ${Math.round(share * 100)}% of new leads`,
          detail: `${missed} of ${started} new leads were not answered in time.`,
          evidence: { missed, started, missedPct: Math.round(share * 1000) / 10 },
          action: `Check ${e.label}'s availability and allocation weight; consider pausing new allocation until caught up.`,
        });
    }
  }

  // Sources and campaigns with spend (per currency, never converted).
  for (const group of input.sources) {
    const before = new Map(group.previous.map((r) => [r.key, r]));
    for (const r of group.current) {
      if (r.key === 'none' || !r.spend?.length) continue;
      for (const s of r.spend) {
        if (s.amountMinor <= 0n) continue;
        if (r.admissions.confirmed === 0 && r.leadsCreated >= 20) {
          out.push({
            key: `SOURCE_NO_ADMISSIONS:${group.kind}:${r.key}:${s.currency}`,
            kind: 'SOURCE_NO_ADMISSIONS',
            severity: 'MEDIUM',
            subject: { type: group.kind, id: r.key, name: r.label },
            title: `${r.label}: ${money(s.amountMinor, s.currency)} spent, ${r.leadsCreated} leads, no admission`,
            detail: `No confirmed admission came from this ${group.kind} in the period.`,
            evidence: {
              spend: money(s.amountMinor, s.currency),
              leads: r.leadsCreated,
              admissions: 0,
            },
            action: 'Check lead quality and course match with marketing before adding budget.',
          });
          continue;
        }
        const prev = before.get(r.key);
        const ps = prev?.spend?.find((x) => x.currency === s.currency);
        if (!prev || !ps || r.admissions.confirmed < 2 || prev.admissions.confirmed < 2) continue;
        const cpaNow = s.amountMinor / BigInt(r.admissions.confirmed);
        const cpaBefore = ps.amountMinor / BigInt(prev.admissions.confirmed);
        if (cpaBefore > 0n && cpaNow * 2n >= cpaBefore * 3n)
          out.push({
            key: `SOURCE_COST_SPIKE:${group.kind}:${r.key}:${s.currency}`,
            kind: 'SOURCE_COST_SPIKE',
            severity: 'MEDIUM',
            subject: { type: group.kind, id: r.key, name: r.label },
            title: `${r.label}: cost per admission ${money(cpaNow, s.currency)} (was ${money(cpaBefore, s.currency)})`,
            detail: `${r.admissions.confirmed} admissions for ${money(s.amountMinor, s.currency)} against ${prev.admissions.confirmed} for ${money(ps.amountMinor, s.currency)} before.`,
            evidence: {
              cpaNow: money(cpaNow, s.currency),
              cpaBefore: money(cpaBefore, s.currency),
              admissions: r.admissions.confirmed,
            },
            action:
              'Review targeting and creatives with marketing; shift budget to better sources.',
          });
      }
    }
  }

  for (const t of input.targets) {
    if (t.elapsed < 0.25 || t.value <= 0n) continue;
    const expected = Number(t.value) * Math.min(1, t.elapsed);
    const ratio = expected > 0 ? Number(t.achieved) / expected : 1;
    if (ratio >= 0.8) continue;
    const fmt = (v: bigint) => (t.currency ? money(v, t.currency) : String(v));
    out.push({
      key: `TARGET_AT_RISK:${t.id}`,
      kind: 'TARGET_AT_RISK',
      severity: ratio < 0.5 ? 'HIGH' : 'MEDIUM',
      subject: { type: 'target', id: t.id, name: t.label },
      title: `${t.label}: ${fmt(t.achieved)} of ${fmt(t.value)} with ${Math.round(t.elapsed * 100)}% of the period gone`,
      detail: `At the current pace the target ends at about ${Math.round(ratio * 100)}% of plan.`,
      evidence: {
        achieved: fmt(t.achieved),
        target: fmt(t.value),
        elapsedPct: Math.round(t.elapsed * 100),
        pacePct: Math.round(ratio * 100),
      },
      action:
        'Agree a recovery plan: priority leads, counselling slots and follow-up blitz for the rest of the period.',
    });
  }

  const open = people.reduce((s, e) => s + e.openLeads, 0);
  if (open >= 10) {
    const ageSum = people.reduce((s, e) => s + (e.avgOpenLeadAgeDays ?? 0) * e.openLeads, 0);
    const avg = Math.round(ageSum / open);
    if (avg >= 14)
      out.push({
        key: 'STUCK_LEADS',
        kind: 'STUCK_LEADS',
        severity: 'MEDIUM',
        subject: { type: 'scope', id: null, name: 'All in scope' },
        title: `Open leads are on average ${avg} days old`,
        detail: `${open} open leads in scope; old leads rarely convert without a clear next step.`,
        evidence: { openLeads: open, avgAgeDays: avg },
        action: 'Close or move old leads to recovery, and set a dated next action on the rest.',
      });
  }

  const rank = { HIGH: 0, MEDIUM: 1 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
