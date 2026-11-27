'use client';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  Select,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { toLocalInput, localInputToIso } from '@/lib/task-format';
import type { Course } from '@/lib/types';

interface StageView {
  stage: string;
  status: string;
  stages: Array<{
    key: string;
    label: string;
    current: boolean;
    system: boolean;
    canEnter: boolean;
    needsReason: boolean;
    missing: Array<{ stage: string; field: string; label: string }>;
    requiredFields: Array<{ field: string; label: string; ok: boolean; detail?: string }>;
  }>;
}

/** Pipeline stepper with the data each stage needs (FR-011). */
export function StagePanel({ leadId, onChanged }: { leadId: string; onChanged: () => void }) {
  const info = useLoad(() => api<StageView>(`/leads/${leadId}/stage`), [leadId]);
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  const d = info.data;
  if (!d) return <ErrorText error={info.error} />;
  const currentIdx = d.stages.findIndex((s) => s.current);
  const next = d.stages[currentIdx + 1];
  const chosen = d.stages.find((s) => s.key === target);
  const go = (toStage: string, why?: string) =>
    run(async () => {
      await api(`/leads/${leadId}/stage-transitions`, {
        method: 'POST',
        body: { toStage, reason: why || undefined },
      });
      setTarget(null);
      setReason('');
      await info.reload();
      onChanged();
    });

  return (
    <Card title="Pipeline stage">
      <ol className="flex flex-wrap gap-1" aria-label="Stages">
        {d.stages.map((s, i) => (
          <li key={s.key}>
            <button
              type="button"
              onClick={() => setTarget(s.current ? null : s.key)}
              className={`rounded-md px-2 py-1 text-xs ring-1 ${
                s.current
                  ? 'bg-brand-600 font-semibold text-white ring-brand-600'
                  : i < currentIdx
                    ? 'bg-brand-50 text-brand-700 ring-brand-200'
                    : 'bg-white text-slate-600 ring-slate-200'
              } ${target === s.key ? 'outline-2 outline-brand-400' : ''}`}
              aria-current={s.current ? 'step' : undefined}
            >
              {s.label}
            </button>
          </li>
        ))}
      </ol>
      {d.status !== 'OPEN' && (
        <p className="mt-3 text-sm text-amber-700">
          This lead is {d.status.toLowerCase().replace('_', ' ')}: its stage cannot change.
        </p>
      )}
      {next && !target && d.status === 'OPEN' && (
        <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
          <p className="font-medium">Next: {next.label}</p>
          {next.system ? (
            <p className="mt-1 text-slate-600">
              Set automatically when the admission and payment are confirmed.
            </p>
          ) : (
            <>
              <ul className="mt-2 space-y-1">
                {next.requiredFields.map((f) => (
                  <li key={f.field} className="flex items-center gap-2">
                    <span aria-hidden className={f.ok ? 'text-green-600' : 'text-slate-400'}>
                      {f.ok ? '✓' : '○'}
                    </span>
                    <span className={f.ok ? '' : 'text-slate-600'}>{f.label}</span>
                    {f.detail && f.field === 'contactOutcome' && (
                      <span className="text-xs text-slate-500">({f.detail})</span>
                    )}
                  </li>
                ))}
              </ul>
              {next.missing.length > next.requiredFields.filter((f) => !f.ok).length && (
                <p className="mt-2 text-xs text-amber-700">Earlier stages are also missing data.</p>
              )}
              <Button
                className="mt-3"
                disabled={busy || !next.canEnter}
                onClick={() => void go(next.key)}
              >
                Move to {next.label}
              </Button>
            </>
          )}
        </div>
      )}
      {chosen && !chosen.current && (
        <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
          <p className="font-medium">
            {chosen.needsReason ? 'Move back to' : 'Move to'} {chosen.label}
          </p>
          {chosen.system && (
            <p className="mt-1 text-slate-600">Set automatically by the admission workflow.</p>
          )}
          {!chosen.system && !chosen.needsReason && chosen.missing.length > 0 && (
            <p className="mt-1 text-amber-700">
              Still needed: {chosen.missing.map((m) => m.label).join(', ')}
            </p>
          )}
          {chosen.needsReason && (
            <div className="mt-2 max-w-md">
              <Field label="Reason for moving back">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              {!chosen.canEnter && (
                <p className="mt-1 text-xs text-slate-500">
                  Only a team leader or manager can move a lead back.
                </p>
              )}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <Button
              disabled={
                busy || !chosen.canEnter || (chosen.needsReason && reason.trim().length < 3)
              }
              onClick={() => void go(chosen.key, reason)}
            >
              Confirm move
            </Button>
            <Button variant="secondary" onClick={() => setTarget(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <div className="mt-2">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}

interface Qualification {
  highestQualification?: string | null;
  eligibilityNotes?: string | null;
  requirement?: string | null;
  interestLevel?: string | null;
  preferredCourseIds?: string[];
  intake?: string | null;
  feeReadiness?: string | null;
  objections?: string | null;
}

export function QualificationCard({
  leadId,
  brandId,
  canEdit,
  onChanged,
}: {
  leadId: string;
  brandId: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const q = useLoad(() => api<Qualification>(`/leads/${leadId}/qualification`), [leadId]);
  const courses = useLoad(() => api<Course[]>(`/courses?brandId=${brandId}`), [brandId]);
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Qualification>({});
  const { busy, error, run } = useAction();
  const d = q.data;
  const text = (k: keyof Qualification, label: string, area = false) => (
    <Field label={label}>
      {area ? (
        <textarea
          className="w-full rounded-md border-0 px-3 py-2 text-sm ring-1 ring-slate-300"
          rows={2}
          value={(f[k] as string) ?? ''}
          onChange={(e) => setF({ ...f, [k]: e.target.value })}
        />
      ) : (
        <Input
          value={(f[k] as string) ?? ''}
          onChange={(e) => setF({ ...f, [k]: e.target.value })}
        />
      )}
    </Field>
  );
  const courseName = (id: string) => courses.data?.find((c) => c.id === id)?.name ?? '…';
  return (
    <Card
      title="Qualification"
      actions={
        canEdit && !editing && d ? (
          <Button
            variant="secondary"
            onClick={() => {
              setF({ ...d, preferredCourseIds: d.preferredCourseIds ?? [] });
              setEditing(true);
            }}
          >
            Edit
          </Button>
        ) : null
      }
    >
      <ErrorText error={q.error} />
      {!editing && d && (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {(
            [
              ['Highest qualification', d.highestQualification],
              ['Eligibility', d.eligibilityNotes],
              ['Goal / requirement', d.requirement],
              ['Interest', d.interestLevel?.toLowerCase()],
              ['Preferred courses', d.preferredCourseIds?.map(courseName).join(', ')],
              ['Intake', d.intake],
              ['Fee readiness', d.feeReadiness],
              ['Objections', d.objections],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-slate-500">{k}</dt>
              <dd>{v || '—'}</dd>
            </div>
          ))}
        </dl>
      )}
      {editing && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`/leads/${leadId}/qualification`, {
                method: 'PUT',
                body: {
                  highestQualification: f.highestQualification || null,
                  eligibilityNotes: f.eligibilityNotes || null,
                  requirement: f.requirement || null,
                  interestLevel: f.interestLevel || null,
                  preferredCourseIds: f.preferredCourseIds ?? [],
                  intake: f.intake || null,
                  feeReadiness: f.feeReadiness || null,
                  objections: f.objections || null,
                },
              });
              setEditing(false);
              await q.reload();
              onChanged();
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {text('highestQualification', 'Highest qualification')}
            <Field label="Interest level">
              <Select
                value={f.interestLevel ?? ''}
                onChange={(e) => setF({ ...f, interestLevel: e.target.value })}
              >
                <option value="">—</option>
                <option value="HOT">Hot</option>
                <option value="WARM">Warm</option>
                <option value="COLD">Cold</option>
              </Select>
            </Field>
            {text('eligibilityNotes', 'Eligibility notes', true)}
            {text('requirement', 'Goal / requirement', true)}
            <Field label="Preferred course">
              <Select
                value={f.preferredCourseIds?.[0] ?? ''}
                onChange={(e) =>
                  setF({ ...f, preferredCourseIds: e.target.value ? [e.target.value] : [] })
                }
              >
                <option value="">—</option>
                {courses.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            {text('intake', 'Intake (e.g. 2027-01)')}
            {text('feeReadiness', 'Fee readiness')}
            {text('objections', 'Objections', true)}
          </div>
          <ErrorText error={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              Save qualification
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

interface QuotationRow {
  id: string;
  number: string;
  courseName: string | null;
  batch: { name: string; startDate: string } | null;
  currency: string;
  listFeeMinor: number;
  discountMinor: number;
  totalMinor: number;
  discountReason: string | null;
  validUntil: string;
  status: string;
  decisionReason: string | null;
}
interface BatchRow {
  id: string;
  name: string;
  startDate: string;
  status: string;
  courseId: string;
}
const Q_TONE: Record<string, 'blue' | 'green' | 'red' | 'slate' | 'amber'> = {
  OPEN: 'blue',
  ACCEPTED: 'green',
  REJECTED: 'red',
  SUPERSEDED: 'slate',
  EXPIRED: 'amber',
};

export function QuotationsCard({
  leadId,
  brandId,
  canEdit,
  onChanged,
}: {
  leadId: string;
  brandId: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const quotes = useLoad(() => api<QuotationRow[]>(`/leads/${leadId}/quotations`), [leadId]);
  const courses = useLoad(() => api<Course[]>(`/courses?brandId=${brandId}`), [brandId]);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({
    courseId: '',
    batchId: '',
    discount: '',
    discountReason: '',
    validDays: '14',
  });
  const batches = useLoad(
    () =>
      f.courseId
        ? api<BatchRow[]>(`/batches?courseId=${f.courseId}`)
        : Promise.resolve([] as BatchRow[]),
    [f.courseId],
  );
  const { busy, error, run } = useAction();
  const course = courses.data?.find((c) => c.id === f.courseId);
  const refresh = async () => {
    await quotes.reload();
    onChanged();
  };
  return (
    <Card
      title="Quotations"
      actions={
        canEdit ? (
          <Button variant="secondary" onClick={() => setAdding((x) => !x)}>
            {adding ? 'Close' : 'New quotation'}
          </Button>
        ) : null
      }
    >
      {adding && (
        <form
          className="mb-4 space-y-3 rounded-md bg-slate-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const discountMinor = f.discount ? Math.round(Number(f.discount) * 100) : 0;
              await api(`/leads/${leadId}/quotations`, {
                method: 'POST',
                body: {
                  courseId: f.courseId,
                  batchId: f.batchId || undefined,
                  discountMinor,
                  discountReason: discountMinor ? f.discountReason : undefined,
                  validDays: Number(f.validDays),
                },
              });
              setAdding(false);
              setF({
                courseId: '',
                batchId: '',
                discount: '',
                discountReason: '',
                validDays: '14',
              });
              await refresh();
            });
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-56">
              <Field label="Quote course">
                <Select
                  required
                  value={f.courseId}
                  onChange={(e) => setF({ ...f, courseId: e.target.value, batchId: '' })}
                >
                  <option value="">Select…</option>
                  {courses.data
                    ?.filter((c) => c.status === 'ACTIVE')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <div className="w-56">
              <Field label="Batch">
                <Select value={f.batchId} onChange={(e) => setF({ ...f, batchId: e.target.value })}>
                  <option value="">Not chosen yet</option>
                  {batches.data
                    ?.filter((b) => b.status === 'PLANNED' || b.status === 'OPEN')
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.startDate.slice(0, 10)})
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <div className="w-36">
              <Field label={`Discount (${course?.currency ?? ''})`}>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={f.discount}
                  onChange={(e) => setF({ ...f, discount: e.target.value })}
                />
              </Field>
            </div>
            <div className="w-28">
              <Field label="Valid (days)">
                <Input
                  type="number"
                  min={1}
                  max={90}
                  value={f.validDays}
                  onChange={(e) => setF({ ...f, validDays: e.target.value })}
                />
              </Field>
            </div>
          </div>
          {course && (
            <p className="text-sm text-slate-600">
              List fee{' '}
              {course.listFeeMinor != null
                ? formatMoney(Number(course.listFeeMinor), course.currency)
                : '— (no fee set)'}
            </p>
          )}
          {Number(f.discount) > 0 && (
            <Field label="Discount reason">
              <Input
                required
                minLength={3}
                value={f.discountReason}
                onChange={(e) => setF({ ...f, discountReason: e.target.value })}
              />
            </Field>
          )}
          <ErrorText error={error} />
          <Button type="submit" disabled={busy}>
            Issue quotation
          </Button>
        </form>
      )}
      <ErrorText error={quotes.error ?? (!adding ? error : null)} />
      {quotes.data?.length === 0 && <p className="text-sm text-slate-500">No quotations yet.</p>}
      <ul className="space-y-2">
        {quotes.data?.map((x) => (
          <li key={x.id} className="rounded-md p-3 text-sm ring-1 ring-slate-200">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{x.number}</span>
              <span className="font-medium">{x.courseName}</span>
              {x.batch && <span className="text-slate-600">· {x.batch.name}</span>}
              <Badge tone={Q_TONE[x.status]}>{x.status.toLowerCase()}</Badge>
              <span className="ml-auto font-semibold tabular-nums">
                {formatMoney(x.totalMinor, x.currency)}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              List {formatMoney(x.listFeeMinor, x.currency)}
              {x.discountMinor
                ? ` − ${formatMoney(x.discountMinor, x.currency)} (${x.discountReason})`
                : ''}{' '}
              · valid until {x.validUntil.slice(0, 10)}
              {x.decisionReason ? ` · ${x.decisionReason}` : ''}
            </p>
            {x.status === 'OPEN' && canEdit && (
              <div className="mt-2 flex gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/quotations/${x.id}/accept`, { method: 'POST', body: {} });
                      await refresh();
                    })
                  }
                >
                  Student accepted
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('Why was it declined?');
                    if (reason && reason.trim().length >= 3)
                      void run(async () => {
                        await api(`/quotations/${x.id}/reject`, {
                          method: 'POST',
                          body: { reason },
                        });
                        await refresh();
                      });
                  }}
                >
                  Declined
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Record a counselling session that already happened (walk-in). */
export function RecordCounselling({ leadId, onDone }: { leadId: string; onDone: () => void }) {
  const people = useLoad(
    () => api<Array<{ id: string; name: string }>>(`/leads/${leadId}/counsellors`),
    [leadId],
  );
  const [f, setF] = useState({
    counsellorId: '',
    heldAt: toLocalInput(new Date()),
    mode: 'IN_PERSON',
    attended: true,
    summary: '',
  });
  const { busy, error, run } = useAction();
  return (
    <form
      className="space-y-3 rounded-md bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/leads/${leadId}/counselling`, {
            method: 'POST',
            body: { ...f, heldAt: localInputToIso(f.heldAt) },
          });
          onDone();
        });
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Field label="Session counsellor">
            <Select
              required
              value={f.counsellorId}
              onChange={(e) => setF({ ...f, counsellorId: e.target.value })}
            >
              <option value="">Select…</option>
              {people.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-56">
          <Field label="Held at">
            <Input
              type="datetime-local"
              required
              value={f.heldAt}
              onChange={(e) => setF({ ...f, heldAt: e.target.value })}
            />
          </Field>
        </div>
        <div className="w-36">
          <Field label="Session mode">
            <Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
              <option value="IN_PERSON">In person</option>
              <option value="PHONE">Phone</option>
              <option value="VIDEO">Video</option>
            </Select>
          </Field>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={f.attended}
            onChange={(e) => setF({ ...f, attended: e.target.checked })}
          />
          Attended
        </label>
      </div>
      <Field label="Session summary">
        <Input
          required
          minLength={3}
          value={f.summary}
          onChange={(e) => setF({ ...f, summary: e.target.value })}
        />
      </Field>
      <ErrorText error={error} />
      <Button type="submit" disabled={busy}>
        Save session
      </Button>
    </form>
  );
}
