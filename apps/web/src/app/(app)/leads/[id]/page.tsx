'use client';
import Link from 'next/link';
import { use, useState } from 'react';
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
import { CHANNEL_LABEL, fmtDateTime as fmt, leadStatusTone } from '@/lib/lead-format';
import { useSession } from '@/lib/session';
import type { Brand, Course, LeadAssignmentRow, LeadDetail, TimelineItem } from '@/lib/types';
import { AssignLead } from '@/components/assign-lead';
import { LeadWork } from '@/components/task-panel';
import { EngagePanel } from '@/components/engage-panel';
import { QualificationCard, QuotationsCard, StagePanel } from '@/components/pipeline-panel';

const TYPE_TONE: Record<string, 'blue' | 'slate' | 'amber' | 'green'> = {
  ENQUIRY: 'blue',
  NOTE: 'slate',
  PROFILE_UPDATED: 'amber',
  LEAD_MERGED: 'green',
  PERSON_MERGED: 'green',
  ASSIGNED: 'green',
  REASSIGNED: 'amber',
  TASK_COMPLETED: 'green',
  TASK_CREATED: 'blue',
  SLA_BREACHED: 'amber',
  SLA_ESCALATED: 'amber',
  LEAD_ON_HOLD: 'amber',
  CALL: 'blue',
  WHATSAPP: 'green',
  EMAIL: 'blue',
  OPTED_OUT: 'amber',
  APPOINTMENT_SCHEDULED: 'blue',
  APPOINTMENT_COMPLETED: 'green',
  STAGE_CHANGED: 'blue',
  QUOTATION_ACCEPTED: 'green',
  COUNSELLING_RECORDED: 'green',
};

export default function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const lead = useLoad(() => api<LeadDetail>(`/leads/${id}`), [id]);
  const timeline = useLoad(() => api<TimelineItem[]>(`/leads/${id}/timeline`), [id]);
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [editing, setEditing] = useState(false);
  const assignments = useLoad(() => api<LeadAssignmentRow[]>(`/leads/${id}/assignments`), [id]);
  const [assigning, setAssigning] = useState(false);
  /** Bumped whenever lead data changes, so panels that derive from it (stage readiness) reload. */
  const [rev, setRev] = useState(0);
  const changed = () => {
    setRev((r) => r + 1);
    void Promise.all([lead.reload(), timeline.reload()]);
  };
  const refresh = async () => {
    await Promise.all([lead.reload(), timeline.reload(), assignments.reload()]);
  };
  const l = lead.data;
  if (!l) return <ErrorText error={lead.error} />;
  const brand = brands.data?.find((b) => b.id === l.brandId);
  const a = l.originalAttribution;

  return (
    <>
      <div className="mb-4 text-sm">
        <Link href="/leads" className="text-brand-700 hover:underline">
          ← All leads
        </Link>
      </div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-slate-500">
            {l.leadNumber} · {brand?.name}
          </p>
          <h1 className="text-xl font-semibold">{l.person.fullName}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge tone={leadStatusTone(l.status)}>{l.status}</Badge>
            <Badge>{l.stage.replace(/_/g, ' ').toLowerCase()}</Badge>
            {l.course && <Badge tone="blue">{l.course.name}</Badge>}
            {l.person.doNotContact && <Badge tone="red">Do not contact</Badge>}
          </div>
        </div>
        {l.canEdit && l.status !== 'MERGED' && (
          <Button variant="secondary" onClick={() => setEditing((e) => !e)}>
            {editing ? 'Close' : 'Edit details'}
          </Button>
        )}
      </div>

      {l.mergedInto && (
        <p className="mb-4 rounded-md bg-slate-100 px-3 py-2 text-sm">
          This lead was merged into{' '}
          <Link
            className="font-medium text-brand-700 hover:underline"
            href={`/leads/${l.mergedInto.id}`}
          >
            {l.mergedInto.leadNumber}
          </Link>
          .
        </p>
      )}
      {l.openDuplicateSuggestions > 0 && (
        <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          This person may be a duplicate of someone else.{' '}
          {can('lead.merge') ? (
            <Link className="font-medium underline" href="/leads/duplicates">
              Review possible duplicates
            </Link>
          ) : (
            'A manager can review it.'
          )}
        </p>
      )}

      {editing && (
        <div className="mb-6">
          <EditProfile
            lead={l}
            onDone={async () => {
              setEditing(false);
              await refresh();
            }}
          />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6">
          <Card title="Owner">
            <p className="text-sm">
              {l.owner ? (
                <span className="font-medium">{l.owner.name}</span>
              ) : (
                <span className="text-amber-700">Unassigned — waiting in the allocation queue</span>
              )}
            </p>
            {l.status !== 'MERGED' && (l.owner ? can('lead.reassign') : can('lead.assign')) && (
              <div className="mt-3">
                {assigning ? (
                  <AssignLead
                    leadId={l.id}
                    brandId={l.brandId}
                    currentOwnerId={l.ownerId}
                    onDone={async () => {
                      setAssigning(false);
                      await refresh();
                    }}
                  />
                ) : (
                  <Button variant="secondary" onClick={() => setAssigning(true)}>
                    {l.owner ? 'Reassign' : 'Assign'}
                  </Button>
                )}
              </div>
            )}
            {!!assignments.data?.length && (
              <ol className="mt-4 space-y-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
                {assignments.data.map((r) => (
                  <li key={r.id}>
                    <span className="font-medium text-slate-800">{r.toName ?? 'Unknown'}</span>
                    {r.fromName ? ` (from ${r.fromName})` : ''} ·{' '}
                    {r.type.replace(/_/g, ' ').toLowerCase()} · {fmt(r.assignedAt)}
                    {r.byName ? ` · by ${r.byName}` : ''}
                    {r.overCapacity ? ' · over capacity' : ''}
                    {r.reason ? <span className="block text-slate-500">“{r.reason}”</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Card title="Contact">
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-slate-500">Mobile</dt>
                <dd className="font-mono">{l.person.phone ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Email</dt>
                <dd>{l.person.email ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-slate-500">City</dt>
                <dd>{l.person.city ?? '—'}</dd>
              </div>
            </dl>
            {l.person.piiMasked && (
              <p className="mt-3 text-xs text-amber-700">
                Contact details are masked for your role.
              </p>
            )}
          </Card>
          <Card title="Original source">
            {a ? (
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-slate-500">First enquiry</dt>
                  <dd>{fmt(a.receivedAt)}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Source</dt>
                  <dd>
                    {a.source?.name ?? CHANNEL_LABEL[a.channel]}{' '}
                    {a.isPaid && <Badge tone="amber">Paid</Badge>}
                  </dd>
                </div>
                {(a.campaign || a.utmCampaign) && (
                  <div>
                    <dt className="text-slate-500">Campaign</dt>
                    <dd>{a.campaign?.name ?? a.utmCampaign}</dd>
                  </div>
                )}
                {a.utmSource && (
                  <div>
                    <dt className="text-slate-500">UTM</dt>
                    <dd>{[a.utmSource, a.utmMedium].filter(Boolean).join(' / ')}</dd>
                  </div>
                )}
                {a.landingPage && (
                  <div>
                    <dt className="text-slate-500">Landing page</dt>
                    <dd className="break-all">{a.landingPage}</dd>
                  </div>
                )}
              </dl>
            ) : (
              '—'
            )}
            <p className="mt-3 text-xs text-slate-500">
              Kept permanently — later enquiries and merges never change it.
            </p>
          </Card>
          {l.mergedLeads.length > 0 && (
            <Card title="Merged leads">
              <ul className="text-sm">
                {l.mergedLeads.map((m) => (
                  <li key={m.id}>
                    <Link
                      className="font-mono text-brand-700 hover:underline"
                      href={`/leads/${m.id}`}
                    >
                      {m.leadNumber}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6 lg:col-span-2">
          {l.status !== 'MERGED' && (
            <StagePanel
              key={`stage:${l.stage}:${l.status}:${rev}`}
              leadId={l.id}
              onChanged={changed}
            />
          )}
          {l.status !== 'MERGED' && (
            <EngagePanel
              leadId={l.id}
              brandId={l.brandId}
              doNotContact={l.person.doNotContact}
              canEdit={l.canEdit}
              onChanged={changed}
            />
          )}
          {l.status !== 'MERGED' && (
            <LeadWork
              key={`${l.ownerId ?? 'none'}:${l.status}`}
              leadId={l.id}
              leadStatus={l.status}
              canEdit={l.canEdit}
              onChanged={changed}
            />
          )}
          {l.status !== 'MERGED' && (
            <div className="grid gap-6 xl:grid-cols-2">
              <QualificationCard
                leadId={l.id}
                brandId={l.brandId}
                canEdit={l.canEdit}
                onChanged={changed}
              />
              <QuotationsCard
                leadId={l.id}
                brandId={l.brandId}
                canEdit={l.canEdit && l.status === 'OPEN'}
                onChanged={changed}
              />
            </div>
          )}
          <Card
            title={`Timeline · ${l.enquiries.length} enquir${l.enquiries.length === 1 ? 'y' : 'ies'}`}
          >
            {l.canEdit && l.status !== 'MERGED' && (
              <NoteBox leadId={l.id} onAdded={() => void timeline.reload()} />
            )}
            <ErrorText error={timeline.error} />
            <ol className="mt-4 space-y-3">
              {timeline.data?.map((item) => (
                <li key={item.id} className="rounded-md p-3 ring-1 ring-slate-200">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={TYPE_TONE[item.type] ?? 'slate'}>
                      {item.type === 'ENQUIRY' ? 'Enquiry' : item.title}
                    </Badge>
                    <span className="text-slate-600">{fmt(item.at)}</span>
                    {item.actor && <span className="text-slate-500">· {item.actor}</span>}
                    {item.leadId !== l.id && (
                      <span className="text-xs text-slate-400">(from merged lead)</span>
                    )}
                  </div>
                  {item.type === 'ENQUIRY' && (
                    <p className="mt-1 text-sm capitalize">
                      {item.title}
                      {item.data?.courseText ? ` · ${String(item.data.courseText)}` : ''}
                      {item.data?.utmCampaign ? ` · ${String(item.data.utmCampaign)}` : ''}
                    </p>
                  )}
                  {item.data?.messageStatus === 'FAILED' && (
                    <p className="mt-1 text-xs text-red-700">
                      Not delivered{item.data.error ? `: ${String(item.data.error)}` : ''}
                    </p>
                  )}
                  {item.body && (
                    <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{item.body}</p>
                  )}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}

function NoteBox({ leadId, onAdded }: { leadId: string; onAdded: () => void }) {
  const [body, setBody] = useState('');
  const { busy, error, run } = useAction();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/leads/${leadId}/notes`, { method: 'POST', body: { body } });
          setBody('');
          onAdded();
        });
      }}
    >
      <div className="min-w-64 flex-1">
        <Field label="Add a note">
          <Input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="e.g. Prefers evening calls"
          />
        </Field>
      </div>
      <Button type="submit" variant="secondary" disabled={busy || !body.trim()}>
        Add note
      </Button>
      <div className="w-full">
        <ErrorText error={error} />
      </div>
    </form>
  );
}

function EditProfile({ lead, onDone }: { lead: LeadDetail; onDone: () => void }) {
  const masked = lead.person.piiMasked;
  const [f, setF] = useState({
    fullName: lead.person.fullName,
    phone: masked ? '' : (lead.person.phone ?? ''),
    email: masked ? '' : (lead.person.email ?? ''),
    city: lead.person.city ?? '',
    courseId: lead.course?.id ?? '',
  });
  const courses = useLoad(
    () => api<Course[]>(`/courses?brandId=${lead.brandId}&status=ACTIVE`),
    [lead.brandId],
  );
  const { busy, error, run } = useAction();
  return (
    <Card title="Edit details">
      <form
        className="grid gap-4 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const body: Record<string, unknown> = {
              fullName: f.fullName,
              city: f.city || null,
              courseId: f.courseId || null,
            };
            if (!masked) {
              body.phone = f.phone || null;
              body.email = f.email || null;
            }
            await api(`/leads/${lead.id}/profile`, { method: 'PATCH', body });
            onDone();
          });
        }}
      >
        <Field label="Full name">
          <Input
            required
            value={f.fullName}
            onChange={(e) => setF({ ...f, fullName: e.target.value })}
          />
        </Field>
        {!masked && (
          <Field label="Mobile">
            <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
        )}
        {!masked && (
          <Field label="Email">
            <Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
        )}
        <Field label="City">
          <Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        </Field>
        <Field label="Course of interest">
          <Select value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })}>
            <option value="">—</option>
            {courses.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-3">
          <ErrorText error={error} />
        </div>
        <div className="sm:col-span-3">
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}
