'use client';
import { useState } from 'react';
import { Input, Select } from '@/components/ui';
import { formatMoney } from '@/lib/format';
import type { Metrics } from '@/lib/reports';

// ------------------------------------------------------------------ period
export type PeriodKey = 'week' | 'month' | 'lastMonth' | 'custom';
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function periodRange(k: PeriodKey, custom: { from: string; to: string }) {
  const today = new Date();
  if (k === 'week') {
    const start = new Date(today);
    start.setDate(today.getDate() - ((today.getDay() + 6) % 7)); // Monday
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { from: iso(start), to: iso(end) };
  }
  if (k === 'month')
    return {
      from: iso(new Date(today.getFullYear(), today.getMonth(), 1)),
      to: iso(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
    };
  if (k === 'lastMonth')
    return {
      from: iso(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      to: iso(new Date(today.getFullYear(), today.getMonth(), 0)),
    };
  return custom;
}

export function PeriodPicker({
  value,
  onChange,
  custom,
  onCustom,
}: {
  value: PeriodKey;
  onChange: (k: PeriodKey) => void;
  custom: { from: string; to: string };
  onCustom: (c: { from: string; to: string }) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Period"
        className="w-40"
        value={value}
        onChange={(e) => onChange(e.target.value as PeriodKey)}
      >
        <option value="week">This week</option>
        <option value="month">This month</option>
        <option value="lastMonth">Last month</option>
        <option value="custom">Custom…</option>
      </Select>
      {value === 'custom' && (
        <>
          <Input
            aria-label="From"
            type="date"
            className="w-40"
            value={custom.from}
            onChange={(e) => onCustom({ ...custom, from: e.target.value })}
          />
          <Input
            aria-label="To"
            type="date"
            className="w-40"
            value={custom.to}
            onChange={(e) => onCustom({ ...custom, to: e.target.value })}
          />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- tiles
export interface TeamAverage {
  members: number;
  hidden: boolean;
  assigned?: number;
  contacted?: number;
  counselling?: number;
  quotationsAccepted?: number;
  admissionsConfirmed?: number;
  admissionsNet?: number;
  lost?: number;
  overdueTasks?: number;
  openLeads?: number;
  contactRatePct?: number | null;
  firstResponsePct?: number | null;
  avgWorkingMinutes?: number | null;
  revenue?: Array<{ currency: string; netMinor: number }>;
}

/** Change vs the previous period, in words and a sign — never colour alone. */
function Delta({
  now,
  before,
  better = 'up',
  unit = '',
}: {
  now: number | null;
  before: number | null;
  better?: 'up' | 'down';
  unit?: string;
}) {
  if (now == null || before == null) return null;
  const d = Math.round((now - before) * 10) / 10;
  if (d === 0) return <span className="text-slate-500">same as previous period</span>;
  const good = better === 'up' ? d > 0 : d < 0;
  return (
    <span className={good ? 'text-green-700' : 'text-red-700'}>
      {d > 0 ? '▲ +' : '▼ '}
      {d}
      {unit} vs previous period
    </span>
  );
}

export function PerfTile({
  label,
  value,
  now,
  before,
  team,
  better,
  unit,
}: {
  label: string;
  value: React.ReactNode;
  now: number | null;
  before: number | null;
  team?: number | null;
  better?: 'up' | 'down';
  unit?: string;
}) {
  return (
    <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
      <p className="mt-1 text-xs">
        <Delta now={now} before={before} better={better} unit={unit} />
      </p>
      {team != null && (
        <p className="text-xs text-slate-500">
          Team average {team}
          {unit}
        </p>
      )}
    </div>
  );
}

export function PerfTiles({
  m,
  prev,
  team,
}: {
  m: Metrics;
  prev: Metrics;
  team: TeamAverage | null;
}) {
  const t = team && !team.hidden ? team : null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <PerfTile
        label="Leads assigned"
        value={m.assigned}
        now={m.assigned}
        before={prev.assigned}
        team={t?.assigned}
      />
      <PerfTile
        label="Leads contacted"
        value={m.contacted}
        now={m.contacted}
        before={prev.contacted}
        team={t?.contacted}
      />
      <PerfTile
        label="Contact rate"
        value={m.contactRate.pct == null ? '—' : `${m.contactRate.pct}%`}
        now={m.contactRate.pct}
        before={prev.contactRate.pct}
        team={t?.contactRatePct}
        unit="%"
      />
      <PerfTile
        label="First response on time"
        value={m.firstResponse.pct == null ? '—' : `${m.firstResponse.pct}%`}
        now={m.firstResponse.pct}
        before={prev.firstResponse.pct}
        team={t?.firstResponsePct}
        unit="%"
      />
      <PerfTile
        label="Counselling sessions"
        value={m.counselling}
        now={m.counselling}
        before={prev.counselling}
        team={t?.counselling}
      />
      <PerfTile
        label="Admissions confirmed"
        value={m.admissions.confirmed}
        now={m.admissions.confirmed}
        before={prev.admissions.confirmed}
        team={t?.admissionsConfirmed}
      />
      <PerfTile
        label="Lost"
        value={m.lost}
        now={m.lost}
        before={prev.lost}
        team={t?.lost}
        better="down"
      />
      <PerfTile
        label="Overdue tasks (now)"
        value={m.overdueTasks}
        now={null}
        before={null}
        team={t?.overdueTasks}
      />
      {m.revenue.map((r) => {
        const p = prev.revenue.find((x) => x.currency === r.currency);
        const ta = t?.revenue?.find((x) => x.currency === r.currency);
        return (
          <div key={r.currency} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Net revenue ({r.currency})
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatMoney(r.netMinor, r.currency)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Previous period {formatMoney(p?.netMinor ?? 0, r.currency)}
            </p>
            {ta && (
              <p className="text-xs text-slate-500">
                Team average {formatMoney(ta.netMinor, r.currency)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------- trend
export interface TrendPoint {
  date: string;
  assigned: number;
  contacted: number;
  admissions: number;
}
const SERIES: Array<{ key: keyof Omit<TrendPoint, 'date'>; label: string }> = [
  { key: 'assigned', label: 'Leads assigned' },
  { key: 'contacted', label: 'Leads contacted' },
  { key: 'admissions', label: 'Admissions confirmed' },
];
const W = 320;
const H = 96;
const PAD = { l: 28, r: 8, t: 8, b: 18 };
const shortDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/**
 * One small chart per measure (small multiples: each has its own scale, so no dual axis and no colour-only identity).
 * Hover or focus shows the day's value; a table view lists every value.
 */
function MiniTrend({
  data,
  k,
  label,
}: {
  data: TrendPoint[];
  k: keyof Omit<TrendPoint, 'date'>;
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d[k]));
  const x = (i: number) =>
    PAD.l + (data.length < 2 ? 0 : (i * (W - PAD.l - PAD.r)) / (data.length - 1));
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const path = data
    .map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`)
    .join(' ');
  const total = data.reduce((s, d) => s + d[k], 0);
  const h = hover != null ? data[hover] : null;
  return (
    <figure className="rounded-lg bg-white p-3 shadow-sm ring-1 ring-slate-200">
      <figcaption className="flex justify-between text-xs">
        <span className="font-medium text-slate-700">{label}</span>
        <span className="tabular-nums text-slate-600">
          {h ? `${shortDate(h.date)}: ${h[k]}` : `Total ${total}`}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-1 w-full"
        role="img"
        aria-label={`${label} per day, total ${total}, peak ${max}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (data.length - 1));
          setHover(Math.max(0, Math.min(data.length - 1, i)));
        }}
      >
        {/* recessive grid: baseline and peak */}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="#cbd5e1" strokeWidth="1" />
        <line
          x1={PAD.l}
          x2={W - PAD.r}
          y1={y(max)}
          y2={y(max)}
          stroke="#e2e8f0"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
        <text x={PAD.l - 4} y={y(max) + 3} textAnchor="end" fontSize="9" fill="#64748b">
          {max}
        </text>
        <text x={PAD.l - 4} y={y(0) + 3} textAnchor="end" fontSize="9" fill="#64748b">
          0
        </text>
        <text x={PAD.l} y={H - 4} fontSize="9" fill="#64748b">
          {data[0] ? shortDate(data[0].date) : ''}
        </text>
        <text x={W - PAD.r} y={H - 4} fontSize="9" fill="#64748b" textAnchor="end">
          {data.length ? shortDate(data[data.length - 1].date) : ''}
        </text>
        <path
          d={path}
          fill="none"
          stroke="#257de0"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {h && hover != null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.t}
              y2={y(0)}
              stroke="#94a3b8"
              strokeWidth="1"
            />
            <circle
              cx={x(hover)}
              cy={y(h[k])}
              r="4"
              fill="#257de0"
              stroke="#ffffff"
              strokeWidth="2"
            />
          </>
        )}
      </svg>
    </figure>
  );
}

export function TrendCharts({ data }: { data: TrendPoint[] }) {
  return (
    <div>
      <div className="grid gap-3 md:grid-cols-3">
        {SERIES.map((s) => (
          <MiniTrend key={s.key} data={data} k={s.key} label={s.label} />
        ))}
      </div>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-slate-600">Show as a table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-2 py-1">Day</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="px-2 py-1 text-right">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.date} className="border-t border-slate-100">
                  <td className="px-2 py-1">{shortDate(d.date)}</td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="px-2 py-1 text-right tabular-nums">
                      {d[s.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

// ------------------------------------------------------------------ funnel
const STEP_LABEL: Record<string, string> = {
  ASSIGNED: 'Assigned',
  CONTACTED: 'Contacted',
  COUNSELLING_COMPLETED: 'Counselling completed',
  QUOTATION_ACCEPTED: 'Quotation accepted',
  ADMISSION_CONFIRMED: 'Admission confirmed',
};
export function PersonalFunnel({ steps }: { steps: Array<{ step: string; leads: number }> }) {
  const max = Math.max(1, ...steps.map((s) => s.leads));
  return (
    <ol className="space-y-2" aria-label="My funnel">
      {steps.map((s) => (
        <li key={s.step} className="grid grid-cols-[10rem_1fr_3rem] items-center gap-3 text-sm">
          <span className="text-slate-600">{STEP_LABEL[s.step] ?? s.step}</span>
          <span className="h-3 rounded bg-slate-100">
            <span
              className="block h-3 rounded bg-brand-600"
              style={{ width: `${(100 * s.leads) / max}%` }}
            />
          </span>
          <span className="text-right tabular-nums">{s.leads}</span>
        </li>
      ))}
    </ol>
  );
}
