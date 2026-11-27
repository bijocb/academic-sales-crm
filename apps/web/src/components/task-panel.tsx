'use client';
import Link from 'next/link';
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
import {
  fmtMinutes,
  inHours,
  localInputToIso,
  OUTCOME_LABEL,
  SLA_LABEL,
  slaTone,
  TASK_TYPE_LABEL,
} from '@/lib/task-format';
import type { LeadSla, TaskRow } from '@/lib/types';

export interface NextTaskDraft {
  type: string;
  dueAt: string; // datetime-local value
  title: string;
}
export const emptyNext = (): NextTaskDraft => ({
  type: 'CALL_BACK',
  dueAt: inHours(24),
  title: '',
});
const toBody = (d: NextTaskDraft) => ({
  type: d.type,
  dueAt: localInputToIso(d.dueAt),
  ...(d.title.trim() ? { title: d.title.trim() } : {}),
});

export function NextTaskFields({
  value,
  onChange,
  label = 'Next action',
}: {
  value: NextTaskDraft;
  onChange: (v: NextTaskDraft) => void;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-48">
        <Field label={`${label} type`}>
          <Select value={value.type} onChange={(e) => onChange({ ...value, type: e.target.value })}>
            {Object.entries(TASK_TYPE_LABEL)
              .filter(([k]) => k !== 'FIRST_CALL')
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      <div className="w-56">
        <Field label={`${label} due`}>
          <Input
            type="datetime-local"
            required
            value={value.dueAt}
            onChange={(e) => onChange({ ...value, dueAt: e.target.value })}
          />
        </Field>
      </div>
      <div className="min-w-48 flex-1">
        <Field label={`${label} note (optional)`}>
          <Input
            value={value.title}
            onChange={(e) => onChange({ ...value, title: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}

type Mode = 'complete' | 'reschedule' | 'cancel' | null;

function TaskItem({
  task,
  onChanged,
  showLead,
}: {
  task: TaskRow;
  onChanged: () => void;
  showLead?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [withNext, setWithNext] = useState(true);
  const [next, setNext] = useState<NextTaskDraft>(emptyNext());
  const [due, setDue] = useState(inHours(2));
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  const open = task.status === 'OPEN';
  const submit = () =>
    run(async () => {
      if (mode === 'complete')
        await api(`/tasks/${task.id}/complete`, {
          method: 'POST',
          body: {
            outcome,
            notes: notes || undefined,
            nextTask: withNext ? toBody(next) : undefined,
          },
        });
      if (mode === 'reschedule')
        await api(`/tasks/${task.id}/reschedule`, {
          method: 'POST',
          body: { dueAt: localInputToIso(due), reason: reason || undefined },
        });
      if (mode === 'cancel')
        await api(`/tasks/${task.id}/cancel`, {
          method: 'POST',
          body: { reason, nextTask: withNext ? toBody(next) : undefined },
        });
      setMode(null);
      onChanged();
    });

  return (
    <li className="rounded-md p-3 ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{task.title}</span>
        <Badge tone="blue">{TASK_TYPE_LABEL[task.type] ?? task.type}</Badge>
        {task.priority !== 'NORMAL' && (
          <Badge tone={task.priority === 'LOW' ? 'slate' : 'amber'}>
            {task.priority.toLowerCase()}
          </Badge>
        )}
        {task.overdue && <Badge tone="red">Overdue</Badge>}
        {task.status === 'COMPLETED' && (
          <Badge tone="green">{OUTCOME_LABEL[task.outcome ?? ''] ?? 'Completed'}</Badge>
        )}
        {task.status === 'CANCELLED' && <Badge>Cancelled</Badge>}
        <span className="text-slate-600">due {fmt(task.dueAt)}</span>
        {task.ownerName && <span className="text-slate-500">· {task.ownerName}</span>}
        {showLead && task.lead && (
          <Link href={`/leads/${task.leadId}`} className="text-brand-700 hover:underline">
            {task.lead.person.fullName} ({task.lead.leadNumber})
          </Link>
        )}
      </div>
      {(task.notes || task.cancelReason) && (
        <p className="mt-1 text-xs whitespace-pre-line text-slate-600">
          {task.cancelReason ?? task.notes}
        </p>
      )}
      {open && !mode && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button onClick={() => setMode('complete')}>Complete</Button>
          <Button variant="secondary" onClick={() => setMode('reschedule')}>
            Reschedule
          </Button>
          <Button variant="secondary" onClick={() => setMode('cancel')}>
            Cancel task
          </Button>
        </div>
      )}
      {open && mode && (
        <form
          className="mt-3 space-y-3 rounded-md bg-slate-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {mode === 'complete' && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-64">
                <Field label="Outcome">
                  <Select required value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                    <option value="">Select the outcome…</option>
                    {task.allowedOutcomes.map((o) => (
                      <option key={o} value={o}>
                        {OUTCOME_LABEL[o] ?? o}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="min-w-56 flex-1">
                <Field label="Notes">
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
              </div>
            </div>
          )}
          {mode === 'reschedule' && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-56">
                <Field label="New due time">
                  <Input
                    type="datetime-local"
                    required
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                  />
                </Field>
              </div>
              <div className="min-w-56 flex-1">
                <Field label="Reason (optional)">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              </div>
            </div>
          )}
          {mode === 'cancel' && (
            <Field label="Why cancel? (required)">
              <Input
                required
                minLength={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          )}
          {mode !== 'reschedule' && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={withNext}
                  onChange={(e) => setWithNext(e.target.checked)}
                />
                Schedule the next action
              </label>
              {withNext && <NextTaskFields value={next} onChange={setNext} />}
            </>
          )}
          <ErrorText error={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || (mode === 'complete' && !outcome)}>
              {mode === 'complete'
                ? 'Save outcome'
                : mode === 'reschedule'
                  ? 'Save new time'
                  : 'Cancel task'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setMode(null)}>
              Back
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

export function TaskList({
  tasks,
  onChanged,
  showLead,
  empty = 'No tasks.',
}: {
  tasks: TaskRow[] | undefined;
  onChanged: () => void;
  showLead?: boolean;
  empty?: string;
}) {
  if (tasks && !tasks.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="space-y-2">
      {tasks?.map((t) => (
        <TaskItem key={t.id} task={t} onChanged={onChanged} showLead={showLead} />
      ))}
    </ul>
  );
}

/** Lead workspace: SLA status, tasks, new task, hold / resume. */
export function LeadWork({
  leadId,
  leadStatus,
  canEdit,
  onChanged,
}: {
  leadId: string;
  leadStatus: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const tasks = useLoad(() => api<TaskRow[]>(`/leads/${leadId}/tasks`), [leadId]);
  const sla = useLoad(() => api<{ current: LeadSla | null }>(`/leads/${leadId}/sla`), [leadId]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<NextTaskDraft>(emptyNext());
  const [holdReason, setHoldReason] = useState('');
  const [holding, setHolding] = useState(false);
  const { busy, error, run } = useAction();
  const refresh = async () => {
    await Promise.all([tasks.reload(), sla.reload()]);
    onChanged();
  };
  const open = tasks.data?.filter((t) => t.status === 'OPEN') ?? [];
  const closed = tasks.data?.filter((t) => t.status !== 'OPEN') ?? [];
  const s = sla.data?.current;
  const active = ['OPEN', 'ON_HOLD', 'IN_RECOVERY'].includes(leadStatus);

  return (
    <Card
      title={`Tasks · ${open.length} open`}
      actions={
        canEdit &&
        active && (
          <div className="flex gap-2">
            {leadStatus === 'OPEN' && (
              <Button variant="secondary" onClick={() => setHolding((h) => !h)}>
                Put on hold
              </Button>
            )}
            {leadStatus === 'ON_HOLD' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/leads/${leadId}/resume`, {
                      method: 'POST',
                      body: open.length ? {} : { nextTask: toBody(emptyNext()) },
                    });
                    await refresh();
                  })
                }
              >
                Resume
              </Button>
            )}
            <Button onClick={() => setAdding((x) => !x)}>{adding ? 'Close' : 'New task'}</Button>
          </div>
        )
      }
    >
      {s && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm">
          <span className="font-medium">First response</span>
          <Badge tone={slaTone(s.state)}>{SLA_LABEL[s.state]}</Badge>
          {s.escalatedAt && <Badge tone="red">Escalated</Badge>}
          <span className="text-slate-600">
            target {s.targetMinutes} {s.basis === 'WORKING' ? 'working' : 'calendar'} min
            {s.dueAt && !s.resolvedAt ? ` · due ${fmt(s.dueAt)}` : ''}
          </span>
          <span className="text-slate-600">
            · working {fmtMinutes(s.elapsed.working)} · calendar {fmtMinutes(s.elapsed.calendar)}
          </span>
        </div>
      )}
      {holding && (
        <form
          className="mb-4 flex flex-wrap items-end gap-3 rounded-md bg-slate-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`/leads/${leadId}/hold`, { method: 'POST', body: { reason: holdReason } });
              setHolding(false);
              setHoldReason('');
              await refresh();
            });
          }}
        >
          <div className="min-w-64 flex-1">
            <Field label="Hold reason (required)">
              <Input
                required
                minLength={3}
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" disabled={busy}>
            Put on hold
          </Button>
        </form>
      )}
      {adding && (
        <form
          className="mb-4 space-y-3 rounded-md bg-slate-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`/leads/${leadId}/tasks`, { method: 'POST', body: toBody(draft) });
              setAdding(false);
              setDraft(emptyNext());
              await refresh();
            });
          }}
        >
          <NextTaskFields value={draft} onChange={setDraft} label="Task" />
          <Button type="submit" disabled={busy}>
            Add task
          </Button>
        </form>
      )}
      <ErrorText error={error ?? tasks.error} />
      <TaskList
        tasks={tasks.data ? open : undefined}
        onChanged={() => void refresh()}
        empty={leadStatus === 'ON_HOLD' ? 'On hold — no open tasks.' : 'No open tasks.'}
      />
      {closed.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-slate-600">
            {closed.length} closed task(s)
          </summary>
          <div className="mt-2">
            <TaskList tasks={closed} onChanged={() => void refresh()} />
          </div>
        </details>
      )}
    </Card>
  );
}
