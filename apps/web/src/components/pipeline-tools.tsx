'use client';
import { useState } from 'react';
import { Button, ErrorText, Field, Input, Select, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';

export const DEFAULT_STAGES: Array<[string, string]> = [
  ['NEW_ENQUIRY', 'New Enquiry'],
  ['CONTACTED', 'Contacted'],
  ['QUALIFIED', 'Qualified'],
  ['INTERESTED', 'Interested'],
  ['COUNSELLING_COMPLETED', 'Counselling Completed'],
  ['COURSE_SELECTED', 'Course Selected'],
  ['PAYMENT_PENDING', 'Payment Pending'],
  ['ADMISSION_CONFIRMED', 'Admission Confirmed'],
];
export const STAGE_LABEL: Record<string, string> = Object.fromEntries(DEFAULT_STAGES);

interface View {
  id: string;
  name: string;
  filters: Record<string, string>;
}

/** Per-user saved filters for a page. */
export function SavedViews({
  page,
  current,
  onApply,
}: {
  page: 'leads' | 'pipeline';
  current: Record<string, string>;
  onApply: (f: Record<string, string>) => void;
}) {
  const views = useLoad(() => api<View[]>(`/saved-views?page=${page}`), [page]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const { busy, error, run } = useAction();
  const filters = Object.fromEntries(Object.entries(current).filter(([, v]) => v));
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-slate-500">Saved views:</span>
      {views.data?.length === 0 && <span className="text-slate-500">none yet</span>}
      {views.data?.map((v) => (
        <span
          key={v.id}
          className="inline-flex items-center rounded-md bg-white ring-1 ring-slate-200"
        >
          <button
            type="button"
            className="px-2 py-1 hover:bg-slate-50"
            onClick={() => onApply(v.filters)}
          >
            {v.name}
          </button>
          <button
            type="button"
            aria-label={`Delete view ${v.name}`}
            className="px-1.5 py-1 text-slate-500 hover:text-red-600"
            onClick={() =>
              void run(async () => {
                await api(`/saved-views/${v.id}`, { method: 'DELETE' });
                await views.reload();
              })
            }
          >
            ×
          </button>
        </span>
      ))}
      {!saving ? (
        <Button variant="secondary" onClick={() => setSaving(true)}>
          Save current view
        </Button>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/saved-views', { method: 'POST', body: { page, name, filters } });
              setSaving(false);
              setName('');
              await views.reload();
            });
          }}
        >
          <Input
            aria-label="View name"
            required
            placeholder="View name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-44"
          />
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </form>
      )}
      <ErrorText error={error} />
    </div>
  );
}

interface BulkResult {
  moved: number;
  refused: number;
  results: Array<{ leadId: string; ok: boolean; message?: string }>;
}

export function BulkMove({ leadIds, onDone }: { leadIds: string[]; onDone: () => void }) {
  const [toStage, setToStage] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<BulkResult | null>(null);
  const { busy, error, run } = useAction();
  return (
    <div className="mb-4 rounded-md bg-brand-50 p-3 ring-1 ring-brand-200">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api<BulkResult>('/leads/bulk-transition', {
              method: 'POST',
              body: { leadIds, toStage, reason: reason || undefined },
            });
            setResult(r);
            if (!r.refused) onDone();
          });
        }}
      >
        <p className="text-sm font-medium">{leadIds.length} selected</p>
        <div className="w-52">
          <Field label="Move selected to">
            <Select required value={toStage} onChange={(e) => setToStage(e.target.value)}>
              <option value="">Stage…</option>
              {DEFAULT_STAGES.filter(([k]) => k !== 'ADMISSION_CONFIRMED').map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-64">
          <Field label="Reason (needed to move back)">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" disabled={busy}>
          Move
        </Button>
      </form>
      <ErrorText error={error} />
      {result && (
        <div className="mt-2 text-sm">
          <p>
            Moved {result.moved}, refused {result.refused}.
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">
            {result.results
              .filter((x) => !x.ok)
              .map((x) => (
                <li key={x.leadId}>{x.message}</li>
              ))}
          </ul>
          {result.refused > 0 && (
            <Button className="mt-2" variant="secondary" onClick={onDone}>
              Done
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
