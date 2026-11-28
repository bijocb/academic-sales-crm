'use client';
import Link from 'next/link';
import { useState } from 'react';
import { LEAD_CHANNELS } from '@crm/contracts';
import { AssignLead, Executive } from '@/components/assign-lead';
import { BrandPicker } from '@/components/brand-picker';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  Td,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/lead-format';
import { useSession } from '@/lib/session';
import type { Brand, Course, Team } from '@/lib/types';

interface QueueItem {
  id: string;
  leadNumber: string;
  createdAt: string;
  person: { fullName: string; language: string | null; city: string | null };
  course: { name: string } | null;
  lastAttempt: { outcome: string; createdAt: string } | null;
}
interface Rule {
  id: string;
  name: string;
  position: number;
  active: boolean;
  courseIds: string[];
  channels: string[];
  languages: string[];
  cities: string[];
  teamId: string | null;
  userIds: string[];
  strategy: string;
}
interface Settings {
  enabled: boolean;
  respectWorkingHours: boolean;
  defaultStrategy: string;
  ruleVersion: number;
}

const OUTCOME: Record<string, string> = {
  NO_ELIGIBLE_USER: 'Nobody eligible',
  OUTSIDE_WORKING_HOURS: 'Outside working hours',
  ASSIGNED: 'Assigned',
  DISABLED: 'Auto-allocation off',
};

export default function AllocationPage() {
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [brandId, setBrandId] = useState('');
  return (
    <>
      <PageHeader
        title="Lead allocation"
        description="New leads go automatically to the least-loaded available executive who matches your rules. Every decision is recorded."
      />
      {brands.data && (
        <div className="mb-6">
          <BrandPicker brands={brands.data} value={brandId} onChange={setBrandId} />
        </div>
      )}
      {brandId && (
        <div className="space-y-6" key={brandId}>
          <Queue brandId={brandId} />
          <Executives brandId={brandId} />
          <Rules brandId={brandId} />
          <SettingsCard brandId={brandId} />
        </div>
      )}
    </>
  );
}

function Queue({ brandId }: { brandId: string }) {
  const queue = useLoad(() => api<QueueItem[]>(`/allocation/queue?brandId=${brandId}`), [brandId]);
  const [open, setOpen] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const drain = (ignore: boolean) =>
    run(async () => {
      const r = await api<{ assigned: number; stillQueued: number }>(
        `/allocation/queue/allocate?brandId=${brandId}${ignore ? '&ignoreWorkingHours=true' : ''}`,
        { method: 'POST' },
      );
      setResult(`${r.assigned} assigned, ${r.stillQueued} still waiting.`);
      await queue.reload();
    });
  return (
    <Card
      title={`Unassigned queue (${queue.data?.length ?? 0})`}
      actions={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={busy || !queue.data?.length}
            onClick={() => void drain(false)}
          >
            Allocate queued leads
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !queue.data?.length}
            onClick={() => void drain(true)}
            title="Assign now even outside working hours"
          >
            Allocate now (ignore hours)
          </Button>
        </div>
      }
    >
      {result && <p className="mb-3 text-sm text-slate-600">{result}</p>}
      <ErrorText error={error ?? queue.error} />
      <Table
        head={['Lead', 'Name', 'Course', 'Waiting since', 'Last attempt', '']}
        empty={queue.data?.length === 0}
      >
        {queue.data?.map((q) => (
          <tr key={q.id}>
            <Td>
              <Link
                href={`/leads/${q.id}`}
                className="font-mono text-xs text-brand-700 hover:underline"
              >
                {q.leadNumber}
              </Link>
            </Td>
            <Td>
              {q.person.fullName}
              {q.person.language ? (
                <span className="ml-1 text-xs text-slate-500">({q.person.language})</span>
              ) : null}
            </Td>
            <Td>{q.course?.name ?? '—'}</Td>
            <Td className="whitespace-nowrap">{fmtDateTime(q.createdAt)}</Td>
            <Td>
              {q.lastAttempt ? (
                <Badge tone="amber">
                  {OUTCOME[q.lastAttempt.outcome] ?? q.lastAttempt.outcome}
                </Badge>
              ) : (
                '—'
              )}
            </Td>
            <Td>
              <Button variant="secondary" onClick={() => setOpen(open === q.id ? null : q.id)}>
                {open === q.id ? 'Close' : 'Assign'}
              </Button>
            </Td>
          </tr>
        ))}
      </Table>
      {open && (
        <div className="mt-4 rounded-md bg-slate-50 p-3 ring-1 ring-slate-200">
          <AssignLead
            leadId={open}
            brandId={brandId}
            currentOwnerId={null}
            onDone={() => {
              setOpen(null);
              void queue.reload();
            }}
          />
        </div>
      )}
    </Card>
  );
}

function Executives({ brandId }: { brandId: string }) {
  const list = useLoad(
    () => api<Executive[]>(`/allocation/executives?brandId=${brandId}`),
    [brandId],
  );
  return (
    <Card
      title="Executives receiving leads"
      actions={
        <span className="text-xs text-slate-500">
          Capacity and languages are set on the Users page
        </span>
      }
    >
      <ErrorText error={list.error} />
      <Table
        head={['Executive', 'Open leads', 'Capacity', 'Languages', 'Status', 'Last lead']}
        empty={list.data?.length === 0}
      >
        {list.data?.map((e) => {
          const full = e.maxActiveLeads != null && e.activeLeads >= e.maxActiveLeads;
          return (
            <tr key={e.userId}>
              <Td className="font-medium">{e.name}</Td>
              <Td className="tabular-nums">{e.activeLeads}</Td>
              <Td className="tabular-nums">{e.maxActiveLeads ?? 'No limit'}</Td>
              <Td>{e.languages.length ? e.languages.join(', ') : 'Any'}</Td>
              <Td>
                {e.onLeave ? (
                  <Badge tone="amber">On leave</Badge>
                ) : !e.isAvailable ? (
                  <Badge>Not taking leads</Badge>
                ) : full ? (
                  <Badge tone="red">Full</Badge>
                ) : (
                  <Badge tone="green">Receiving</Badge>
                )}
              </Td>
              <Td className="whitespace-nowrap">
                {e.lastAssignedAt ? fmtDateTime(e.lastAssignedAt) : '—'}
              </Td>
            </tr>
          );
        })}
      </Table>
      {list.data?.length === 0 && (
        <p className="mt-2 text-sm text-slate-500">
          Give users the Sales Executive role in this brand (or a team of it) so they can receive
          leads.
        </p>
      )}
    </Card>
  );
}

function Rules({ brandId }: { brandId: string }) {
  const { can } = useSession();
  const canEdit = can('allocation.manage');
  const rules = useLoad(() => api<Rule[]>(`/allocation/rules?brandId=${brandId}`), [brandId]);
  const teams = useLoad(() => api<Team[]>(`/teams?brandId=${brandId}`), [brandId]);
  const courses = useLoad(() => api<Course[]>(`/courses?brandId=${brandId}`), [brandId]);
  const execs = useLoad(
    () => api<Executive[]>(`/allocation/executives?brandId=${brandId}`),
    [brandId],
  );
  const [f, setF] = useState({
    name: '',
    courseId: '',
    channel: '',
    language: '',
    city: '',
    teamId: '',
    userId: '',
    strategy: 'LEAST_LOADED',
  });
  const { busy, error, run } = useAction();
  const nameOf = (ids: string[], list?: Array<{ id?: string; userId?: string; name: string }>) =>
    ids.map((i) => list?.find((x) => (x.id ?? x.userId) === i)?.name ?? '?').join(', ');
  const move = (i: number, d: -1 | 1) =>
    run(async () => {
      const ids = rules.data!.map((r) => r.id);
      [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
      await api('/allocation/rules/order', { method: 'PUT', body: { brandId, ruleIds: ids } });
      await rules.reload();
    });
  return (
    <Card
      title="Rules (first match wins)"
      actions={<span className="text-xs text-slate-500">No match → whole brand pool</span>}
    >
      <ErrorText error={error ?? rules.error} />
      <Table
        head={['#', 'Rule', 'When', 'Goes to', 'Strategy', '']}
        empty={rules.data?.length === 0}
      >
        {rules.data?.map((r, i) => (
          <tr key={r.id} className={r.active ? '' : 'text-slate-500'}>
            <Td>{r.position}</Td>
            <Td className="font-medium">{r.name}</Td>
            <Td className="text-xs">
              {[
                r.courseIds.length && `Course: ${nameOf(r.courseIds, courses.data)}`,
                r.channels.length && `Channel: ${r.channels.join(', ')}`,
                r.languages.length && `Language: ${r.languages.join(', ')}`,
                r.cities.length && `City: ${r.cities.join(', ')}`,
              ]
                .filter(Boolean)
                .join(' · ') || 'Any lead'}
            </Td>
            <Td className="text-xs">
              {[
                r.teamId && `Team: ${teams.data?.find((t) => t.id === r.teamId)?.name ?? '?'}`,
                r.userIds.length && nameOf(r.userIds, execs.data),
              ]
                .filter(Boolean)
                .join(' + ')}
            </Td>
            <Td className="text-xs">
              {r.strategy === 'LEAST_LOADED' ? 'Least loaded' : 'Round robin'}
            </Td>
            <Td>
              {canEdit && (
                <div className="flex gap-1">
                  <Button
                    variant="secondary"
                    disabled={busy || i === 0}
                    onClick={() => void move(i, -1)}
                    aria-label="Move up"
                  >
                    ↑
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || i === rules.data!.length - 1}
                    onClick={() => void move(i, 1)}
                    aria-label="Move down"
                  >
                    ↓
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api(`/allocation/rules/${r.id}`, {
                          method: 'PATCH',
                          body: { active: !r.active },
                        });
                        await rules.reload();
                      })
                    }
                  >
                    {r.active ? 'Pause' : 'Resume'}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api(`/allocation/rules/${r.id}`, { method: 'DELETE' });
                        await rules.reload();
                      })
                    }
                  >
                    Delete
                  </Button>
                </div>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {canEdit && (
        <form
          className="mt-4 grid gap-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/allocation/rules', {
                method: 'POST',
                body: {
                  brandId,
                  name: f.name,
                  courseIds: f.courseId ? [f.courseId] : [],
                  channels: f.channel ? [f.channel] : [],
                  languages: f.language ? [f.language] : [],
                  cities: f.city ? [f.city] : [],
                  teamId: f.teamId || null,
                  userIds: f.userId ? [f.userId] : [],
                  strategy: f.strategy,
                },
              });
              setF({
                name: '',
                courseId: '',
                channel: '',
                language: '',
                city: '',
                teamId: '',
                userId: '',
                strategy: 'LEAST_LOADED',
              });
              await rules.reload();
            });
          }}
        >
          <Field label="Rule name">
            <Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="If course is">
            <Select value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })}>
              <option value="">Any</option>
              {courses.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="If channel is">
            <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
              <option value="">Any</option>
              {LEAD_CHANNELS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="If language is" hint="e.g. ml, hi, ar">
            <Input value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} />
          </Field>
          <Field label="If city is">
            <Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
          </Field>
          <Field label="Send to team">
            <Select value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}>
              <option value="">—</option>
              {teams.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="…or executive">
            <Select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>
              <option value="">—</option>
              {execs.data?.map((x) => (
                <option key={x.userId} value={x.userId}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Strategy">
            <Select value={f.strategy} onChange={(e) => setF({ ...f, strategy: e.target.value })}>
              <option value="LEAST_LOADED">Least loaded</option>
              <option value="ROUND_ROBIN">Round robin</option>
            </Select>
          </Field>
          <div className="sm:col-span-4">
            <Button type="submit" variant="secondary" disabled={busy || (!f.teamId && !f.userId)}>
              Add rule
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function SettingsCard({ brandId }: { brandId: string }) {
  const { can } = useSession();
  const s = useLoad(() => api<Settings>(`/allocation/settings?brandId=${brandId}`), [brandId]);
  const { busy, error, run } = useAction();
  const save = (patch: Partial<Settings>) =>
    run(async () => {
      await api(`/allocation/settings?brandId=${brandId}`, { method: 'PATCH', body: patch });
      await s.reload();
    });
  if (!s.data) return <ErrorText error={s.error} />;
  const editable = can('allocation.manage');
  return (
    <Card
      title="Settings"
      actions={<span className="text-xs text-slate-500">Rule version {s.data.ruleVersion}</span>}
    >
      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            disabled={!editable || busy}
            checked={s.data.enabled}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />{' '}
          Allocate new leads automatically
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            disabled={!editable || busy}
            checked={s.data.respectWorkingHours}
            onChange={(e) => void save({ respectWorkingHours: e.target.checked })}
          />{' '}
          Only during the brand's working hours (otherwise leads wait in the queue)
        </label>
        <div className="w-56">
          <Field label="Default strategy">
            <Select
              disabled={!editable || busy}
              value={s.data.defaultStrategy}
              onChange={(e) => void save({ defaultStrategy: e.target.value })}
            >
              <option value="LEAST_LOADED">Least loaded</option>
              <option value="ROUND_ROBIN">Round robin</option>
            </Select>
          </Field>
        </div>
      </div>
      <div className="mt-2">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}
