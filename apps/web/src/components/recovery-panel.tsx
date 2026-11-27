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
import { fmtDateTime as fmt } from '@/lib/lead-format';
import { inHours, localInputToIso } from '@/lib/task-format';
import type { Course } from '@/lib/types';

export interface LossReason {
  id: string;
  code: string;
  label: string;
  recoverable: boolean;
  active: boolean;
}
interface Attempt {
  id: string;
  attemptNo: number;
  channel: string;
  outcome: string;
  notes: string | null;
  occurredAt: string;
  nextAttemptAt: string | null;
}
interface Case {
  id: string;
  status: 'SCHEDULED' | 'ACTIVE' | 'RECOVERED' | 'CLOSED' | 'CANCELLED';
  lossReason: string | null;
  lossNotes: string;
  lostAt: string;
  startsAt: string;
  ownerId: string | null;
  ownerName: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  closeReason: string | null;
  attemptsLog: Attempt[];
}
interface RecoveryView {
  canManage: boolean;
  canWork: boolean;
  cases: Case[];
  statusHistory: Array<{
    id: string;
    fromStatus: string;
    toStatus: string;
    reasonCode: string | null;
    notes: string | null;
    occurredAt: string;
  }>;
}

const OUTCOME_LABEL: Record<string, string> = {
  NO_RESPONSE: 'No response',
  CALL_BACK_LATER: 'Asked to call back later',
  NOT_INTERESTED: 'Still not interested',
  INTERESTED: 'Interested again — reopen the lead',
  OPTED_OUT: 'Asked not to be contacted',
};
const CASE_TONE = {
  SCHEDULED: 'slate',
  ACTIVE: 'blue',
  RECOVERED: 'green',
  CLOSED: 'red',
  CANCELLED: 'slate',
} as const;

/** "Mark lost" form (FR-012): reason + notes, then recover after the cooldown or close. */
export function MarkLost({
  leadId,
  brandId,
  canManage,
  onDone,
}: {
  leadId: string;
  brandId: string;
  canManage: boolean;
  onDone: () => void;
}) {
  const reasons = useLoad(() => api<LossReason[]>(`/loss-reasons?brandId=${brandId}`), [brandId]);
  const [f, setF] = useState({ lossReasonId: '', notes: '', plan: 'RECOVER' });
  const { busy, error, run } = useAction();
  const chosen = reasons.data?.find((r) => r.id === f.lossReasonId);
  const plan = chosen && !chosen.recoverable ? 'CLOSE' : f.plan;
  return (
    <form
      className="space-y-3 rounded-md bg-red-50 p-3 ring-1 ring-red-200"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/leads/${leadId}/lost`, { method: 'POST', body: { ...f, plan } });
          onDone();
        });
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Field label="Loss reason">
            <Select
              required
              value={f.lossReasonId}
              onChange={(e) => setF({ ...f, lossReasonId: e.target.value })}
            >
              <option value="">Select…</option>
              {reasons.data
                ?.filter((r) => r.active)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <div className="w-72">
          <Field label="Then">
            <Select
              value={plan}
              disabled={!!chosen && !chosen.recoverable}
              onChange={(e) => setF({ ...f, plan: e.target.value })}
            >
              <option value="RECOVER">Try to recover after the cooldown</option>
              <option value="CLOSE" disabled={!!chosen?.recoverable && !canManage}>
                Close now{chosen?.recoverable && !canManage ? ' (manager only)' : ''}
              </option>
            </Select>
          </Field>
        </div>
      </div>
      <Field label="Loss notes">
        <Input
          required
          minLength={3}
          value={f.notes}
          onChange={(e) => setF({ ...f, notes: e.target.value })}
        />
      </Field>
      <ErrorText error={error ?? reasons.error} />
      <Button type="submit" variant="danger" disabled={busy}>
        Mark lost
      </Button>
    </form>
  );
}

export function RecoveryPanel({
  leadId,
  brandId,
  onChanged,
}: {
  leadId: string;
  brandId: string;
  onChanged: () => void;
}) {
  const view = useLoad(() => api<RecoveryView>(`/leads/${leadId}/recovery`), [leadId]);
  const { busy, error, run } = useAction();
  const v = view.data;
  if (!v || !v.cases.length) return null;
  const refresh = async () => {
    await view.reload();
    onChanged();
  };
  return (
    <Card title="Recovery">
      <ErrorText error={error ?? view.error} />
      <ul className="space-y-3">
        {v.cases.map((c) => (
          <li key={c.id} className="rounded-md p-3 text-sm ring-1 ring-slate-200">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={CASE_TONE[c.status]}>{c.status.toLowerCase()}</Badge>
              <span className="font-medium">{c.lossReason}</span>
              <span className="text-slate-600">— {c.lossNotes}</span>
              <span className="ml-auto text-xs text-slate-500">
                attempts {c.attempts}/{c.maxAttempts}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Lost {fmt(c.lostAt)}
              {c.status === 'SCHEDULED' && ` · recovery starts ${fmt(c.startsAt)}`}
              {c.status === 'ACTIVE' && ` · owner ${c.ownerName ?? 'not assigned yet'}`}
              {c.nextAttemptAt &&
                c.status === 'ACTIVE' &&
                ` · next attempt ${fmt(c.nextAttemptAt)}`}
              {c.closeReason && ` · ${c.closeReason}`}
            </p>
            {!!c.attemptsLog.length && (
              <ol className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600">
                {c.attemptsLog.map((x) => (
                  <li key={x.id}>
                    {x.attemptNo}. {x.channel.toLowerCase()} ·{' '}
                    {OUTCOME_LABEL[x.outcome] ?? x.outcome} · {fmt(x.occurredAt)}
                    {x.notes ? ` — ${x.notes}` : ''}
                  </li>
                ))}
              </ol>
            )}
            {c.status === 'ACTIVE' && v.canWork && (
              <LogAttempt caseId={c.id} brandId={brandId} onDone={() => void refresh()} />
            )}
            {v.canManage && (c.status === 'SCHEDULED' || c.status === 'ACTIVE') && (
              <div className="mt-2 flex flex-wrap gap-2">
                {c.status === 'SCHEDULED' && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api(`/recovery/${c.id}/start`, { method: 'POST' });
                        await refresh();
                      })
                    }
                  >
                    Start recovery now
                  </Button>
                )}
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('Why close this lead for good?');
                    if (reason && reason.trim().length >= 3)
                      void run(async () => {
                        await api(`/recovery/${c.id}/close`, { method: 'POST', body: { reason } });
                        await refresh();
                      });
                  }}
                >
                  Close as lost
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function LogAttempt({
  caseId,
  brandId,
  onDone,
}: {
  caseId: string;
  brandId: string;
  onDone: () => void;
}) {
  const courses = useLoad(
    () => api<Course[]>(`/courses?brandId=${brandId}&status=ACTIVE`),
    [brandId],
  );
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    channel: 'CALL',
    outcome: '',
    notes: '',
    offeredCourseId: '',
    nextDue: inHours(24),
  });
  const { busy, error, run } = useAction();
  if (!open)
    return (
      <Button className="mt-2" onClick={() => setOpen(true)}>
        Log recovery attempt
      </Button>
    );
  return (
    <form
      className="mt-3 space-y-3 rounded-md bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/recovery/${caseId}/attempts`, {
            method: 'POST',
            body: {
              channel: f.channel,
              outcome: f.outcome,
              notes: f.notes || undefined,
              offeredCourseId: f.offeredCourseId || undefined,
              nextTask:
                f.outcome === 'INTERESTED'
                  ? { type: 'COUNSELLING', dueAt: localInputToIso(f.nextDue) }
                  : undefined,
            },
          });
          setOpen(false);
          onDone();
        });
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-36">
          <Field label="Channel">
            <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
              <option value="CALL">Call</option>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="EMAIL">Email</option>
            </Select>
          </Field>
        </div>
        <div className="w-72">
          <Field label="Result">
            <Select
              required
              value={f.outcome}
              onChange={(e) => setF({ ...f, outcome: e.target.value })}
            >
              <option value="">Select…</option>
              {Object.entries(OUTCOME_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-56">
          <Field label="Alternative course offered">
            <Select
              value={f.offeredCourseId}
              onChange={(e) => setF({ ...f, offeredCourseId: e.target.value })}
            >
              <option value="">—</option>
              {courses.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <Field label="Attempt notes">
        <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
      {f.outcome === 'INTERESTED' && (
        <div className="w-56">
          <Field label="Counselling task due">
            <Input
              type="datetime-local"
              required
              value={f.nextDue}
              onChange={(e) => setF({ ...f, nextDue: e.target.value })}
            />
          </Field>
        </div>
      )}
      <ErrorText error={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !f.outcome}>
          Save attempt
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
