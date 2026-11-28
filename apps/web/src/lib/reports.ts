/** Shapes returned by /reports/* (see docs/KPI.md for definitions and date basis). */
export interface Money {
  currency: string;
  collectedMinor: number;
  refundedMinor: number;
  netMinor: number;
}
export interface Metrics {
  leadsCreated: number;
  assigned: number;
  contacted: number;
  contactRate: { cohort: number; connected: number; pct: number | null };
  firstResponse: {
    started: number;
    withinTarget: number;
    breached: number;
    pct: number | null;
    avgWorkingMinutes: number | null;
    avgCalendarMinutes: number | null;
  };
  openTasks: number;
  overdueTasks: number;
  openLeads: number;
  reassigned: number;
  lost: number;
  recovered: number;
  counselling: number;
  quotationsAccepted: number;
  admissions: { confirmed: number; cancelled: number; net: number; firstContact: number };
  revenue: Money[];
  outstanding: Array<{ currency: string; outstandingMinor: number }>;
}
export interface Disclosure {
  from: string;
  to: string;
  timezone: string;
  dateBasis: Record<string, string>;
  attribution: string;
  merged: string;
  currencies: string;
}
export interface Summary extends Disclosure {
  metrics: Metrics;
  funnel: Array<{ stage: string; leads: number }>;
}
export interface BreakdownRow {
  key: string;
  label: string;
  leadsCreated: number;
  assigned: number;
  contacted: number;
  firstResponse: { started: number; withinTarget: number };
  openLeads: number;
  avgOpenLeadAgeDays: number | null;
  overdueTasks: number;
  lost: number;
  recovered: number;
  counselling: number;
  admissions: { confirmed: number; cancelled: number; firstContact: number };
  revenue: Array<{ currency: string; netMinor: number }>;
  spend?: Array<{ currency: string; amountMinor: number }>;
  cpl?: Array<{ currency: string; minor: number | null }>;
  cpa?: Array<{ currency: string; minor: number | null }>;
}
export interface DrillRow {
  id: string;
  leadId: string;
  leadNumber?: string;
  name?: string;
  at: string | null;
  user: string | null;
  amountMinor: number | null;
  currency: string | null;
}
export interface TargetRow {
  id: string;
  scope: 'ORGANIZATION' | 'BRAND' | 'TEAM' | 'USER';
  brandId: string | null;
  teamId: string | null;
  userId: string | null;
  courseId: string | null;
  metric: string;
  periodStart: string;
  periodEnd: string;
  value: number;
  currency: string | null;
  achieved: number;
}

export const TARGET_LABEL: Record<string, string> = {
  ASSIGNED: 'Assigned leads',
  CONTACTED: 'Contacted leads',
  COUNSELLING: 'Counselling sessions',
  ADMISSIONS: 'Net admissions',
  REVENUE: 'Net revenue',
  COLLECTIONS: 'Collections',
};
export const STAGE_LABEL: Record<string, string> = {
  NEW_ENQUIRY: 'New enquiry',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  INTERESTED: 'Interested',
  COUNSELLING_COMPLETED: 'Counselling completed',
  COURSE_SELECTED: 'Course selected',
  PAYMENT_PENDING: 'Payment pending',
  ADMISSION_CONFIRMED: 'Admission confirmed',
};

/** ISO date (YYYY-MM-DD) of the first and last day of the current month, in the browser's zone. */
export function thisMonth(): { from: string; to: string } {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const ym = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  return { from: `${ym}-01`, to: `${ym}-${pad(last)}` };
}

export const pct = (v: number | null) => (v == null ? '—' : `${v}%`);

export function query(f: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  return p.toString();
}
