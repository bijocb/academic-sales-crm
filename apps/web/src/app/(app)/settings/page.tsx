'use client';
import { useEffect, useState } from 'react';
import { STAGE_FIELD_CATALOG } from '@crm/contracts';
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
import {
  formatInZone,
  minutesToTime,
  timeToMinutes,
  WEEKDAYS,
  zonedLocalToIso,
} from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Brand, Holiday, PipelineStage, Shift, SlaPolicy } from '@/lib/types';

export default function SettingsPage() {
  const { me } = useSession();
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [brandId, setBrandId] = useState('');
  const brand = brands.data?.find((b) => b.id === brandId);
  const canEdit = (me.permissions['settings.manage'] ?? []).some(
    (s) => s.scopeType === 'ORGANIZATION' || s.brandId === brandId,
  );

  return (
    <>
      <PageHeader
        title="Brand settings"
        description="Working hours, holidays, SLA timings and pipeline stages. Each brand is configured separately."
      />
      {brands.data && (
        <div className="mb-6 flex flex-wrap items-end gap-4">
          <BrandPicker brands={brands.data} value={brandId} onChange={setBrandId} />
          {brand && <Badge>{brand.timezone}</Badge>}
          {!canEdit && brandId && <Badge tone="amber">Read only</Badge>}
        </div>
      )}
      {brand && (
        <div className="space-y-6" key={brand.id}>
          <WorkingHours brand={brand} canEdit={canEdit} />
          <Preview brand={brand} />
          <Holidays brand={brand} canEdit={canEdit} />
          <Sla brand={brand} canEdit={canEdit} />
          <Stages brand={brand} canEdit={canEdit} />
        </div>
      )}
    </>
  );
}

function WorkingHours({ brand, canEdit }: { brand: Brand; canEdit: boolean }) {
  const data = useLoad(
    () => api<{ shifts: Shift[] }>(`/brands/${brand.id}/working-hours`),
    [brand.id],
  );
  const [shifts, setShifts] = useState<Shift[]>([]);
  useEffect(() => setShifts(data.data?.shifts ?? []), [data.data]);
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const update = (i: number, patch: Partial<Shift>) =>
    setShifts(shifts.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <Card
      title="Working hours"
      actions={<span className="text-xs text-slate-500">Times in {brand.timezone}</span>}
    >
      <div className="space-y-2">
        {WEEKDAYS.map((label, idx) => {
          const weekday = idx + 1;
          const day = shifts.map((s, i) => ({ s, i })).filter(({ s }) => s.weekday === weekday);
          return (
            <div key={weekday} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-12 font-medium text-slate-700">{label}</span>
              {day.length === 0 && <span className="text-slate-400">Closed</span>}
              {day.map(({ s, i }) => (
                <span
                  key={i}
                  className="flex items-center gap-1 rounded-md bg-slate-50 px-2 py-1 ring-1 ring-slate-200"
                >
                  <input
                    aria-label={`${label} start`}
                    type="time"
                    disabled={!canEdit}
                    value={minutesToTime(s.startMinute)}
                    onChange={(e) => update(i, { startMinute: timeToMinutes(e.target.value) })}
                    className="bg-transparent"
                  />
                  –
                  <input
                    aria-label={`${label} end`}
                    type="time"
                    disabled={!canEdit}
                    value={minutesToTime(s.endMinute === 1440 ? 1439 : s.endMinute)}
                    onChange={(e) => update(i, { endMinute: timeToMinutes(e.target.value) })}
                    className="bg-transparent"
                  />
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={`Remove ${label} shift`}
                      className="ml-1 text-slate-400 hover:text-red-600"
                      onClick={() => setShifts(shifts.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {canEdit && (
                <button
                  type="button"
                  className="text-xs text-brand-700 hover:underline"
                  onClick={() =>
                    setShifts([...shifts, { weekday, startMinute: 540, endMinute: 1080 }])
                  }
                >
                  + shift
                </button>
              )}
            </div>
          );
        })}
      </div>
      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(`/brands/${brand.id}/working-hours`, { method: 'PUT', body: { shifts } });
                setSaved(true);
                await data.reload();
              })
            }
          >
            Save working hours
          </Button>
          {saved && <span className="text-sm text-green-700">Saved</span>}
        </div>
      )}
      <div className="mt-3">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}

function Preview({ brand }: { brand: Brand }) {
  const [local, setLocal] = useState('');
  const [minutes, setMinutes] = useState('15');
  const [result, setResult] = useState<{
    calendarDue: string;
    workingDue: string;
    arrivesInWorkingTime: boolean;
  } | null>(null);
  const { busy, error, run } = useAction();
  return (
    <Card
      title="Due-time preview"
      actions={<span className="text-xs text-slate-500">Calendar minutes vs working minutes</span>}
    >
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const start = zonedLocalToIso(local, brand.timezone);
            setResult(
              await api(
                `/brands/${brand.id}/calendar/preview?start=${encodeURIComponent(start)}&minutes=${minutes}`,
              ),
            );
          });
        }}
      >
        <div className="w-60">
          <Field label={`Lead arrives (${brand.timezone})`}>
            <Input
              type="datetime-local"
              required
              value={local}
              onChange={(e) => setLocal(e.target.value)}
            />
          </Field>
        </div>
        <div className="w-32">
          <Field label="SLA minutes">
            <Input
              type="number"
              min={1}
              required
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={busy}>
          Calculate
        </Button>
      </form>
      {result && (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-slate-500">Arrives during working time?</dt>
            <dd className="font-medium">{result.arrivesInWorkingTime ? 'Yes' : 'No'}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Due by calendar clock</dt>
            <dd className="font-medium">{formatInZone(result.calendarDue, brand.timezone)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Due by working clock</dt>
            <dd className="font-medium">{formatInZone(result.workingDue, brand.timezone)}</dd>
          </div>
        </dl>
      )}
      <div className="mt-3">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}

function Holidays({ brand, canEdit }: { brand: Brand; canEdit: boolean }) {
  const list = useLoad(() => api<Holiday[]>(`/brands/${brand.id}/holidays`), [brand.id]);
  const [f, setF] = useState({ date: '', name: '' });
  const { busy, error, run } = useAction();
  return (
    <Card
      title="Holidays"
      actions={<span className="text-xs text-slate-500">No working time on these dates</span>}
    >
      <Table head={['Date', 'Name', '']} empty={list.data?.length === 0}>
        {list.data?.map((h) => (
          <tr key={h.id}>
            <Td>{h.date}</Td>
            <Td>{h.name}</Td>
            <Td>
              {canEdit && (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/holidays/${h.id}`, { method: 'DELETE' });
                      await list.reload();
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {canEdit && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`/brands/${brand.id}/holidays`, { method: 'POST', body: f });
              setF({ date: '', name: '' });
              await list.reload();
            });
          }}
        >
          <div className="w-44">
            <Field label="Date">
              <Input
                type="date"
                required
                value={f.date}
                onChange={(e) => setF({ ...f, date: e.target.value })}
              />
            </Field>
          </div>
          <div className="w-64">
            <Field label="Name">
              <Input
                required
                value={f.name}
                onChange={(e) => setF({ ...f, name: e.target.value })}
              />
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={busy}>
            Add holiday
          </Button>
        </form>
      )}
      <div className="mt-3">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}

const ACTION_LABEL: Record<string, string> = {
  REMIND_OWNER: 'Remind executive',
  ALERT_TEAM_LEADER: 'Alert team leader',
  REASSIGN: 'Reassign lead',
  ESCALATE_MANAGER: 'Escalate to sales manager',
};

function Sla({ brand, canEdit }: { brand: Brand; canEdit: boolean }) {
  const data = useLoad(() => api<SlaPolicy>(`/brands/${brand.id}/sla-policy`), [brand.id]);
  const [p, setP] = useState<SlaPolicy | null>(null);
  useEffect(() => setP(data.data ?? null), [data.data]);
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  if (!p) return <ErrorText error={data.error} />;
  const setCp = (i: number, patch: Partial<SlaPolicy['checkpoints'][number]>) =>
    setP({ ...p, checkpoints: p.checkpoints.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    <Card
      title="SLA and escalation"
      actions={
        <span className="text-xs text-slate-500">
          Timers start when a lead is assigned (Phase 7)
        </span>
      }
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="First response target (min)">
          <Input
            type="number"
            min={1}
            disabled={!canEdit}
            value={p.firstResponseMinutes}
            onChange={(e) => setP({ ...p, firstResponseMinutes: Number(e.target.value) })}
          />
        </Field>
        <Field label="Measured in">
          <Select
            disabled={!canEdit}
            value={p.firstResponseBasis}
            onChange={(e) => setP({ ...p, firstResponseBasis: e.target.value as 'WORKING' })}
          >
            <option value="WORKING">Working minutes</option>
            <option value="CALENDAR">Calendar minutes</option>
          </Select>
        </Field>
        <Field label="Max automatic reassignments">
          <Input
            type="number"
            min={0}
            disabled={!canEdit}
            value={p.maxReassignAttempts}
            onChange={(e) => setP({ ...p, maxReassignAttempts: Number(e.target.value) })}
          />
        </Field>
        <Field
          label="Reassignment cooldown (min)"
          hint="Same executive can't get the lead back within this time"
        >
          <Input
            type="number"
            min={0}
            disabled={!canEdit}
            value={p.reassignCooldownMinutes}
            onChange={(e) => setP({ ...p, reassignCooldownMinutes: Number(e.target.value) })}
          />
        </Field>
      </div>
      <h3 className="mt-6 mb-2 text-sm font-semibold text-slate-700">
        Checkpoints (if the lead is still untouched…)
      </h3>
      <Table head={['After', 'Clock', 'Action', '']}>
        {p.checkpoints.map((c, i) => (
          <tr key={i}>
            <Td>
              <Input
                aria-label={`Checkpoint ${i + 1} minutes`}
                type="number"
                min={1}
                className="w-28"
                disabled={!canEdit}
                value={c.afterMinutes}
                onChange={(e) => setCp(i, { afterMinutes: Number(e.target.value) })}
              />
            </Td>
            <Td>
              <Select
                disabled={!canEdit}
                value={c.basis}
                onChange={(e) => setCp(i, { basis: e.target.value as 'WORKING' })}
                className="w-44"
              >
                <option value="WORKING">working minutes</option>
                <option value="CALENDAR">calendar minutes</option>
              </Select>
            </Td>
            <Td>
              <Select
                disabled={!canEdit}
                value={c.action}
                onChange={(e) => setCp(i, { action: e.target.value })}
                className="w-56"
              >
                {Object.entries(ACTION_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Td>
            <Td>
              {canEdit && p.checkpoints.length > 1 && (
                <Button
                  variant="danger"
                  onClick={() =>
                    setP({ ...p, checkpoints: p.checkpoints.filter((_, j) => j !== i) })
                  }
                >
                  Remove
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() =>
              setP({
                ...p,
                checkpoints: [
                  ...p.checkpoints,
                  {
                    action: 'ESCALATE_MANAGER',
                    afterMinutes: (p.checkpoints.at(-1)?.afterMinutes ?? 0) + 30,
                    basis: 'WORKING',
                  },
                ],
              })
            }
          >
            Add checkpoint
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const {
                  firstResponseMinutes,
                  firstResponseBasis,
                  maxReassignAttempts,
                  reassignCooldownMinutes,
                  checkpoints,
                } = p;
                await api(`/brands/${brand.id}/sla-policy`, {
                  method: 'PUT',
                  body: {
                    firstResponseMinutes,
                    firstResponseBasis,
                    maxReassignAttempts,
                    reassignCooldownMinutes,
                    checkpoints: checkpoints.map(({ action, afterMinutes, basis }) => ({
                      action,
                      afterMinutes,
                      basis,
                    })),
                  },
                });
                setSaved(true);
                await data.reload();
              })
            }
          >
            Save SLA policy
          </Button>
          {saved && <span className="text-sm text-green-700">Saved</span>}
        </div>
      )}
      <div className="mt-3">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}

function Stages({ brand, canEdit }: { brand: Brand; canEdit: boolean }) {
  const stages = useLoad(
    () => api<PipelineStage[]>(`/brands/${brand.id}/pipeline-stages`),
    [brand.id],
  );
  const [editing, setEditing] = useState<PipelineStage | null>(null);
  const { busy, error, run } = useAction();
  return (
    <Card
      title="Sales pipeline stages"
      actions={
        <span className="text-xs text-slate-500">
          Order follows the workflow; required fields are enforced from Phase 9
        </span>
      }
    >
      <Table head={['#', 'Stage', 'Required before entering', '']}>
        {stages.data?.map((s) => (
          <tr key={s.id}>
            <Td>{s.position}</Td>
            <Td className="font-medium">{s.label}</Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                {s.requiredFields.map((f) => (
                  <Badge key={f}>
                    {STAGE_FIELD_CATALOG[f as keyof typeof STAGE_FIELD_CATALOG] ?? f}
                  </Badge>
                ))}
              </div>
            </Td>
            <Td>
              {canEdit && (
                <Button variant="secondary" onClick={() => setEditing({ ...s })}>
                  Edit
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {editing && (
        <form
          className="mt-4 space-y-3 rounded-md bg-slate-50 p-4 ring-1 ring-slate-200"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`/pipeline-stages/${editing.id}`, {
                method: 'PATCH',
                body: { label: editing.label, requiredFields: editing.requiredFields },
              });
              setEditing(null);
              await stages.reload();
            });
          }}
        >
          <div className="w-72">
            <Field label="Label">
              <Input
                required
                value={editing.label}
                onChange={(e) => setEditing({ ...editing, label: e.target.value })}
              />
            </Field>
          </div>
          <fieldset className="grid gap-1 text-sm sm:grid-cols-3">
            <legend className="mb-1 font-medium text-slate-700">Required fields</legend>
            {Object.entries(STAGE_FIELD_CATALOG).map(([k, v]) => (
              <label key={k} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={editing.requiredFields.includes(k)}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      requiredFields: e.target.checked
                        ? [...editing.requiredFields, k]
                        : editing.requiredFields.filter((x) => x !== k),
                    })
                  }
                />
                {v}
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              Save stage
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <div className="mt-3">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}
