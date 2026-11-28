'use client';
import Link from 'next/link';
import { Badge, Card, ErrorText, useLoad } from '@/components/ui';
import { api } from '@/lib/api';

export interface Insight {
  key: string;
  kind: string;
  severity: 'HIGH' | 'MEDIUM';
  subject: { type: string; id: string | null; name: string };
  title: string;
  detail: string;
  evidence: Record<string, number | string | null>;
  action: string;
}
export interface InsightsResponse {
  period: { from: string; to: string };
  previous: { from: string; to: string };
  counts: { high: number; medium: number };
  insights: Insight[];
  headline: {
    leadsCreated: number;
    contactRatePct: number | null;
    firstResponsePct: number | null;
    admissions: number;
    previousAdmissions: number;
    overdueTasks: number;
  };
}

const EVIDENCE_LABEL: Record<string, string> = {
  current: 'Now',
  previous: 'Before',
  dropPoints: 'Drop (points)',
  currentBase: 'Base now',
  previousBase: 'Base before',
  overdueTasks: 'Overdue',
  teamMedian: 'Team median',
  openLeads: 'Open leads',
  contactRate: 'Contact rate %',
  scopeRate: 'Team rate %',
  assigned: 'Assigned',
  contacted: 'Contacted',
  missed: 'Missed',
  started: 'New leads',
  missedPct: 'Missed %',
  spend: 'Spend',
  leads: 'Leads',
  admissions: 'Admissions',
  cpaNow: 'Cost / admission now',
  cpaBefore: 'Before',
  achieved: 'Achieved',
  target: 'Target',
  elapsedPct: 'Period gone %',
  pacePct: 'Pace %',
  avgAgeDays: 'Average age (days)',
};

/** Insights with their evidence and suggested action (A-051). */
export function InsightList({ items, limit }: { items: Insight[]; limit?: number }) {
  const shown = limit ? items.slice(0, limit) : items;
  if (!items.length)
    return <p className="text-sm text-slate-600">Nothing needs attention in this period.</p>;
  return (
    <ul className="space-y-3" aria-label="Insights">
      {shown.map((i) => (
        <li key={i.key} className="rounded-md p-3 ring-1 ring-slate-200">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={i.severity === 'HIGH' ? 'red' : 'amber'}>
              {i.severity === 'HIGH' ? 'High' : 'Medium'}
            </Badge>
            <span className="text-sm font-medium text-slate-900">{i.title}</span>
          </div>
          <p className="mt-1 text-sm text-slate-700">{i.detail}</p>
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
            {Object.entries(i.evidence).map(([k, v]) => (
              <div key={k} className="flex gap-1">
                <dt>{EVIDENCE_LABEL[k] ?? k}:</dt>
                <dd className="font-medium text-slate-800">{v ?? '–'}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-sm text-slate-800">
            <span className="font-medium">Suggested: </span>
            {i.action}
          </p>
        </li>
      ))}
      {limit && items.length > limit && (
        <li className="text-sm text-slate-600">and {items.length - limit} more…</li>
      )}
    </ul>
  );
}

/** Dashboard card for team leaders and management: the most important insights of the last 7 days. */
export function InsightsCard() {
  const r = useLoad(() => api<InsightsResponse>('/insights'));
  return (
    <Card
      title="Insights — last 7 days"
      actions={
        <Link className="text-sm font-medium text-brand-700 hover:underline" href="/insights">
          All insights and Ask the CRM →
        </Link>
      }
    >
      <ErrorText error={r.error} />
      {r.loading && !r.data && <p className="text-sm text-slate-500">Loading…</p>}
      {r.data && <InsightList items={r.data.insights} limit={4} />}
    </Card>
  );
}
