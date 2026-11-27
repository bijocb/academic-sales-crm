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
import { RecordCounselling } from '@/components/pipeline-panel';
import { fmtDateTime as fmt } from '@/lib/lead-format';
import { inHours, localInputToIso, OUTCOME_LABEL, toLocalInput } from '@/lib/task-format';

interface Providers {
  sandbox: boolean;
  whatsapp: string | null;
  telephony: string | null;
}
interface Template {
  id: string;
  channel: 'WHATSAPP' | 'EMAIL';
  name: string;
  language: string;
  subject: string | null;
  body: string;
  status: string;
}
interface AppointmentRow {
  id: string;
  startsAt: string;
  endsAt: string;
  mode: string;
  location: string | null;
  status: string;
  summary: string | null;
  counsellorName: string | null;
}

type Panel = 'call' | 'whatsapp' | 'email' | 'appointment' | 'session' | 'optout' | null;
const CALL_OUTCOMES = [
  'CONNECTED',
  'NO_ANSWER',
  'BUSY',
  'SWITCHED_OFF',
  'WRONG_NUMBER',
  'CALL_BACK_REQUESTED',
];
const MODE_LABEL: Record<string, string> = {
  IN_PERSON: 'In person',
  PHONE: 'Phone',
  VIDEO: 'Video',
};
const APPT_TONE: Record<string, 'blue' | 'green' | 'amber' | 'slate'> = {
  SCHEDULED: 'blue',
  COMPLETED: 'green',
  NO_SHOW: 'amber',
  CANCELLED: 'slate',
};

/** Lead workspace actions (FR-010): log call, click-to-call, WhatsApp, email, appointments, opt-out. */
export function EngagePanel({
  leadId,
  brandId,
  doNotContact,
  canEdit,
  onChanged,
}: {
  leadId: string;
  brandId: string;
  doNotContact: boolean;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const providers = useLoad(() => api<Providers>('/engagement/providers'));
  const templates = useLoad(
    () => api<Template[]>(`/message-templates?brandId=${brandId}`),
    [brandId],
  );
  const appts = useLoad(() => api<AppointmentRow[]>(`/leads/${leadId}/appointments`), [leadId]);
  const [panel, setPanel] = useState<Panel>(null);
  const { busy, error, run } = useAction();
  const [dialRef, setDialRef] = useState<string | null>(null);
  const done = async () => {
    setPanel(null);
    await appts.reload();
    onChanged();
  };
  const approved = (ch: 'WHATSAPP' | 'EMAIL') =>
    templates.data?.filter((t) => t.channel === ch && t.status === 'APPROVED') ?? [];
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));

  return (
    <Card
      title="Engage"
      actions={
        doNotContact ? (
          <Badge tone="red">Do not contact — messages blocked</Badge>
        ) : providers.data?.sandbox ? (
          <Badge tone="amber">Sandbox providers (test only)</Badge>
        ) : null
      }
    >
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant={panel === 'call' ? 'primary' : 'secondary'}
            onClick={() => toggle('call')}
          >
            Log call
          </Button>
          {providers.data?.telephony && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api<{ providerRef: string }>(`/leads/${leadId}/calls/dial`, {
                    method: 'POST',
                  });
                  setDialRef(r.providerRef);
                  setPanel('call');
                })
              }
            >
              Call now
            </Button>
          )}
          <Button
            variant={panel === 'whatsapp' ? 'primary' : 'secondary'}
            disabled={doNotContact || !providers.data?.whatsapp}
            title={!providers.data?.whatsapp ? 'WhatsApp provider not connected yet' : undefined}
            onClick={() => toggle('whatsapp')}
          >
            WhatsApp
          </Button>
          <Button
            variant={panel === 'email' ? 'primary' : 'secondary'}
            disabled={doNotContact}
            onClick={() => toggle('email')}
          >
            Email
          </Button>
          <Button
            variant={panel === 'appointment' ? 'primary' : 'secondary'}
            onClick={() => toggle('appointment')}
          >
            Schedule counselling
          </Button>
          <Button
            variant={panel === 'session' ? 'primary' : 'secondary'}
            onClick={() => toggle('session')}
          >
            Record session
          </Button>
          <Button variant="secondary" onClick={() => toggle('optout')}>
            {doNotContact ? 'Allow contact' : 'Do not contact'}
          </Button>
        </div>
      )}
      {!providers.data?.whatsapp && providers.data && (
        <p className="mt-2 text-xs text-slate-500">
          WhatsApp and click-to-call are not connected yet — log calls manually.
        </p>
      )}
      <div className="mt-3">
        <ErrorText error={error} />
        {panel === 'call' && <LogCall leadId={leadId} providerRef={dialRef} onDone={done} />}
        {panel === 'whatsapp' && (
          <SendMessage
            leadId={leadId}
            channel="WHATSAPP"
            templates={approved('WHATSAPP')}
            onDone={done}
          />
        )}
        {panel === 'email' && (
          <SendMessage
            leadId={leadId}
            channel="EMAIL"
            templates={approved('EMAIL')}
            onDone={done}
          />
        )}
        {panel === 'appointment' && <BookAppointment leadId={leadId} onDone={done} />}
        {panel === 'session' && <RecordCounselling leadId={leadId} onDone={done} />}
        {panel === 'optout' && <OptOut leadId={leadId} doNotContact={doNotContact} onDone={done} />}
      </div>

      {!!appts.data?.length && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Counselling appointments</h3>
          <ul className="space-y-2">
            {appts.data.map((a) => (
              <AppointmentItem key={a.id} a={a} onChanged={() => void done()} />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function LogCall({
  leadId,
  providerRef,
  onDone,
}: {
  leadId: string;
  providerRef: string | null;
  onDone: () => void;
}) {
  const [f, setF] = useState({
    direction: 'OUTBOUND',
    startedAt: toLocalInput(new Date()),
    minutes: '',
    outcome: '',
    notes: '',
  });
  const { busy, error, run } = useAction();
  return (
    <form
      className="space-y-3 rounded-md bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/leads/${leadId}/calls`, {
            method: 'POST',
            body: {
              direction: f.direction,
              startedAt: localInputToIso(f.startedAt),
              durationSec: f.minutes ? Math.round(Number(f.minutes) * 60) : undefined,
              outcome: f.outcome,
              notes: f.notes || undefined,
              providerRef: providerRef ?? undefined,
            },
          });
          onDone();
        });
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-36">
          <Field label="Direction">
            <Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
              <option value="OUTBOUND">Outgoing</option>
              <option value="INBOUND">Incoming</option>
            </Select>
          </Field>
        </div>
        <div className="w-56">
          <Field label="Call started">
            <Input
              type="datetime-local"
              required
              value={f.startedAt}
              onChange={(e) => setF({ ...f, startedAt: e.target.value })}
            />
          </Field>
        </div>
        <div className="w-28">
          <Field label="Minutes">
            <Input
              type="number"
              min={0}
              step="0.5"
              value={f.minutes}
              onChange={(e) => setF({ ...f, minutes: e.target.value })}
            />
          </Field>
        </div>
        <div className="w-60">
          <Field label="Call outcome">
            <Select
              required
              value={f.outcome}
              onChange={(e) => setF({ ...f, outcome: e.target.value })}
            >
              <option value="">Select…</option>
              {CALL_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_LABEL[o]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <Field label="Call notes">
        <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
      {providerRef && (
        <p className="text-xs text-slate-500">Provider call reference: {providerRef}</p>
      )}
      <ErrorText error={error} />
      <Button type="submit" disabled={busy || !f.outcome}>
        Save call
      </Button>
    </form>
  );
}

function SendMessage({
  leadId,
  channel,
  templates,
  onDone,
}: {
  leadId: string;
  channel: 'WHATSAPP' | 'EMAIL';
  templates: Template[];
  onDone: () => void;
}) {
  const [templateId, setTemplateId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const { busy, error, run } = useAction();
  const tpl = templates.find((t) => t.id === templateId);
  return (
    <form
      className="space-y-3 rounded-md bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/leads/${leadId}/messages`, {
            method: 'POST',
            body: {
              channel,
              templateId: templateId || undefined,
              subject: channel === 'EMAIL' && subject ? subject : undefined,
              body: !templateId ? body : undefined,
            },
          });
          onDone();
        });
      }}
    >
      <Field label={channel === 'WHATSAPP' ? 'Approved template' : 'Template (optional)'}>
        <Select
          required={channel === 'WHATSAPP'}
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          <option value="">{channel === 'WHATSAPP' ? 'Select a template…' : 'Write my own'}</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.language})
            </option>
          ))}
        </Select>
      </Field>
      {channel === 'WHATSAPP' && !templates.length && (
        <p className="text-xs text-amber-700">No approved WhatsApp templates for this brand yet.</p>
      )}
      {tpl && (
        <p className="rounded bg-white p-2 text-sm whitespace-pre-line ring-1 ring-slate-200">
          {tpl.body}
        </p>
      )}
      {channel === 'EMAIL' && (
        <Field label="Subject">
          <Input
            value={subject}
            placeholder={tpl?.subject ?? ''}
            required={!tpl?.subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>
      )}
      {channel === 'EMAIL' && !templateId && (
        <Field label="Message">
          <textarea
            className="w-full rounded-md border-0 px-3 py-2 text-sm ring-1 ring-slate-300"
            rows={5}
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
      )}
      <ErrorText error={error} />
      <Button type="submit" disabled={busy}>
        Send {channel === 'WHATSAPP' ? 'WhatsApp' : 'email'}
      </Button>
    </form>
  );
}

function BookAppointment({ leadId, onDone }: { leadId: string; onDone: () => void }) {
  const people = useLoad(
    () => api<Array<{ id: string; name: string }>>(`/leads/${leadId}/counsellors`),
    [leadId],
  );
  const [f, setF] = useState({
    counsellorId: '',
    startsAt: inHours(24),
    duration: '30',
    mode: 'PHONE',
    location: '',
  });
  const { busy, error, run } = useAction();
  return (
    <form
      className="space-y-3 rounded-md bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/leads/${leadId}/appointments`, {
            method: 'POST',
            body: {
              counsellorId: f.counsellorId,
              startsAt: localInputToIso(f.startsAt),
              durationMinutes: Number(f.duration),
              mode: f.mode,
              location: f.location || undefined,
            },
          });
          onDone();
        });
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Field label="Counsellor">
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
          <Field label="Starts">
            <Input
              type="datetime-local"
              required
              value={f.startsAt}
              onChange={(e) => setF({ ...f, startsAt: e.target.value })}
            />
          </Field>
        </div>
        <div className="w-28">
          <Field label="Minutes">
            <Input
              type="number"
              min={5}
              max={480}
              value={f.duration}
              onChange={(e) => setF({ ...f, duration: e.target.value })}
            />
          </Field>
        </div>
        <div className="w-36">
          <Field label="Mode">
            <Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
              {Object.entries(MODE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <Field label="Place or meeting link (optional)">
        <Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
      </Field>
      <ErrorText error={error ?? people.error} />
      <Button type="submit" disabled={busy}>
        Book appointment
      </Button>
    </form>
  );
}

function OptOut({
  leadId,
  doNotContact,
  onDone,
}: {
  leadId: string;
  doNotContact: boolean;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-md bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/leads/${leadId}/contact-preference`, {
            method: 'POST',
            body: { doNotContact: !doNotContact, reason },
          });
          onDone();
        });
      }}
    >
      <div className="min-w-64 flex-1">
        <Field
          label={
            doNotContact ? 'Why may we contact them again?' : 'Why must we stop contacting them?'
          }
        >
          <Input
            required
            minLength={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </div>
      <ErrorText error={error} />
      <Button type="submit" variant={doNotContact ? 'primary' : 'danger'} disabled={busy}>
        {doNotContact ? 'Allow contact' : 'Mark do not contact'}
      </Button>
    </form>
  );
}

function AppointmentItem({ a, onChanged }: { a: AppointmentRow; onChanged: () => void }) {
  const [mode, setMode] = useState<'complete' | 'cancel' | null>(null);
  const [attended, setAttended] = useState(true);
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  return (
    <li className="rounded-md p-3 ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{fmt(a.startsAt)}</span>
        <Badge tone={APPT_TONE[a.status]}>{a.status.replace('_', ' ').toLowerCase()}</Badge>
        <span className="text-slate-600">
          {MODE_LABEL[a.mode]} · {a.counsellorName}
        </span>
        {a.location && <span className="text-slate-500">· {a.location}</span>}
      </div>
      {a.summary && <p className="mt-1 text-xs text-slate-600">{a.summary}</p>}
      {a.status === 'SCHEDULED' && !mode && (
        <div className="mt-2 flex gap-2">
          <Button variant="secondary" onClick={() => setMode('complete')}>
            Record outcome
          </Button>
          <Button variant="secondary" onClick={() => setMode('cancel')}>
            Cancel
          </Button>
        </div>
      )}
      {mode && (
        <form
          className="mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (mode === 'complete')
                await api(`/appointments/${a.id}/complete`, {
                  method: 'POST',
                  body: { attended, summary: text },
                });
              else
                await api(`/appointments/${a.id}/cancel`, {
                  method: 'POST',
                  body: { reason: text },
                });
              setMode(null);
              onChanged();
            });
          }}
        >
          {mode === 'complete' && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={attended}
                onChange={(e) => setAttended(e.target.checked)}
              />
              The student attended
            </label>
          )}
          <Field label={mode === 'complete' ? 'Summary' : 'Reason'}>
            <Input required minLength={3} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <ErrorText error={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              Save
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
