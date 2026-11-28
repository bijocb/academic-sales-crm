'use client';
import { formatMoney } from '@/lib/format';
import { Metrics, pct, STAGE_LABEL, Summary, TargetRow } from '@/lib/reports';

/** A KPI tile; when `onDrill` is given the number opens its underlying records. */
function Tile({
  label,
  value,
  hint,
  onDrill,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  onDrill?: () => void;
}) {
  return (
    <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      {onDrill ? (
        <button
          type="button"
          onClick={onDrill}
          className="mt-1 text-2xl font-semibold tabular-nums text-brand-700 hover:underline"
          aria-label={`${label} ${String(value)}: show records`}
        >
          {value}
        </button>
      ) : (
        <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
      )}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function KpiTiles({
  m,
  onDrill,
}: {
  m: Metrics;
  onDrill?: (metric: string, label: string) => void;
}) {
  const d = (metric: string, label: string) => (onDrill ? () => onDrill(metric, label) : undefined);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Leads created"
          value={m.leadsCreated}
          onDrill={d('leadsCreated', 'Leads created')}
        />
        <Tile label="Assigned" value={m.assigned} onDrill={d('assigned', 'Assigned leads')} />
        <Tile
          label="Contacted"
          value={m.contacted}
          hint={`Contact rate ${pct(m.contactRate.pct)} of ${m.contactRate.cohort} assigned`}
          onDrill={d('contacted', 'Contacted leads')}
        />
        <Tile
          label="First response on time"
          value={pct(m.firstResponse.pct)}
          hint={`${m.firstResponse.withinTarget} of ${m.firstResponse.started} · avg ${
            m.firstResponse.avgWorkingMinutes ?? '—'
          } working min`}
        />
        <Tile
          label="Admissions confirmed"
          value={m.admissions.confirmed}
          hint={`${m.admissions.cancelled} cancelled · net ${m.admissions.net} · ${m.admissions.firstContact} first-contact`}
          onDrill={d('admissionsConfirmed', 'Admissions confirmed')}
        />
        <Tile label="Lost" value={m.lost} onDrill={d('lost', 'Lost leads')} />
        <Tile label="Recovered" value={m.recovered} onDrill={d('recovered', 'Recovered leads')} />
        <Tile
          label="Overdue tasks (now)"
          value={m.overdueTasks}
          hint={`${m.openTasks} open · ${m.openLeads} open leads`}
          onDrill={d('overdueTasks', 'Overdue tasks')}
        />
        <Tile label="Counselling sessions" value={m.counselling} />
        <Tile label="Quotations accepted" value={m.quotationsAccepted} />
        <Tile label="Reassigned" value={m.reassigned} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Revenue (net of refunds paid)
          </p>
          {m.revenue.length === 0 ? (
            <p className="mt-1 text-2xl font-semibold text-slate-900">—</p>
          ) : (
            m.revenue.map((r) => (
              <div key={r.currency} className="mt-1">
                {onDrill ? (
                  <button
                    type="button"
                    className="text-2xl font-semibold tabular-nums text-brand-700 hover:underline"
                    onClick={() => onDrill('payments', 'Payments')}
                  >
                    {formatMoney(r.netMinor, r.currency)}
                  </button>
                ) : (
                  <p className="text-2xl font-semibold tabular-nums">
                    {formatMoney(r.netMinor, r.currency)}
                  </p>
                )}
                <p className="text-xs text-slate-500">
                  {formatMoney(r.collectedMinor, r.currency)} collected ·{' '}
                  {formatMoney(r.refundedMinor, r.currency)} refunded
                </p>
              </div>
            ))
          )}
        </div>
        {m.outstanding.length > 0 && (
          <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Outstanding fees (now)
            </p>
            {m.outstanding.map((o) => (
              <p key={o.currency} className="mt-1 text-2xl font-semibold tabular-nums">
                {formatMoney(o.outstandingMinor, o.currency)}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Funnel({ funnel }: { funnel: Summary['funnel'] }) {
  const max = Math.max(1, ...funnel.map((f) => f.leads));
  return (
    <ol className="space-y-2" aria-label="Funnel">
      {funnel.map((f) => (
        <li key={f.stage} className="grid grid-cols-[10rem_1fr_3rem] items-center gap-3 text-sm">
          <span className="text-slate-600">{STAGE_LABEL[f.stage] ?? f.stage}</span>
          <span className="h-3 rounded bg-slate-100">
            <span
              className="block h-3 rounded bg-brand-600"
              style={{ width: `${(100 * f.leads) / max}%` }}
            />
          </span>
          <span className="text-right tabular-nums">{f.leads}</span>
        </li>
      ))}
    </ol>
  );
}

export function Disclosure({ s }: { s: Summary | { from: string; to: string; timezone: string } }) {
  return (
    <p className="text-xs text-slate-500">
      {s.from} to {s.to} ({s.timezone}). Admissions are counted when confirmed or cancelled; revenue
      when received or refunded; sources and campaigns by first touch; currencies are never added
      together.
    </p>
  );
}

export function TargetProgress({ t }: { t: TargetRow }) {
  const ratio = t.value ? Math.min(1, t.achieved / t.value) : 0;
  const show = (v: number) => (t.currency ? formatMoney(v, t.currency) : String(v));
  return (
    <div className="min-w-40">
      <div className="flex justify-between text-xs tabular-nums text-slate-600">
        <span>{show(t.achieved)}</span>
        <span>of {show(t.value)}</span>
      </div>
      <div className="mt-1 h-2 rounded bg-slate-100">
        <div
          className={`h-2 rounded ${ratio >= 1 ? 'bg-green-600' : 'bg-brand-600'}`}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}
