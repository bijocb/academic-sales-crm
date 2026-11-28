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
import { fmtDateTime } from '@/lib/lead-format';

type Band = 'HIGH' | 'MEDIUM' | 'LOW';
interface Factor {
  factor: string;
  label: string;
  value: string;
  weight: number;
}
interface Suggestion {
  kind: string;
  title: string;
  reason: string;
  needsApproval: boolean;
}
type AiView =
  | { enabled: false }
  | {
      enabled: true;
      advisory: string;
      unavailable: string | null;
      score: {
        method: 'MODEL' | 'RULES';
        modelVersion: string;
        score: number;
        band: Band;
        probabilityBp: number | null;
        confidence: 'LOW' | 'MEDIUM' | 'HIGH';
        prior: number | null;
        factors: Factor[];
        basis: { sampleSize: number; conversions: number; trainedAt: string } | null;
        fallbackReason: string | null;
        degraded: boolean;
      } | null;
      override: { band: Band; reason: string; by: string | null; at: string } | null;
      effectiveBand: Band | null;
      canOverride: boolean;
      suggestions: Suggestion[];
    };

export const bandTone = (b: string | null | undefined) =>
  b === 'HIGH' ? 'green' : b === 'MEDIUM' ? 'amber' : 'slate';

const VALUE_LABEL: Record<string, string> = {
  yes: 'yes',
  no: 'no',
  on_time: 'on time',
  late: 'late',
  none: 'not yet',
};

/** Advisory AI assistance (FR-021). Loads on its own so an AI problem never breaks the lead page. */
export function AiPanel({ leadId, onChanged }: { leadId: string; onChanged: () => void }) {
  const view = useLoad(() => api<AiView>(`/leads/${leadId}/ai`), [leadId]);
  const [overriding, setOverriding] = useState(false);
  const [band, setBand] = useState<Band>('HIGH');
  const [reason, setReason] = useState('');
  const act = useAction();

  if (view.error)
    return (
      <Card title="AI assistance">
        <p className="text-sm text-slate-500">
          AI assistance could not be loaded. Work the lead as usual.
        </p>
      </Card>
    );
  const v = view.data;
  if (!v || !v.enabled) return null;
  const s = v.score;
  const done = async () => {
    await view.reload();
    onChanged();
  };

  return (
    <Card
      title="AI assistance"
      actions={
        v.effectiveBand ? (
          <span className="flex items-center gap-2 text-sm">
            Priority <Badge tone={bandTone(v.effectiveBand)}>{v.effectiveBand}</Badge>
            {v.override && <span className="text-xs text-slate-500">(set by a person)</span>}
          </span>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-slate-500">{v.advisory}</p>
        {v.unavailable && <p className="text-sm text-amber-700">{v.unavailable}</p>}
        {s && (
          <div>
            <p className="text-sm">
              <span className="font-medium">
                {s.probabilityBp != null
                  ? `Estimated chance of joining: ${(s.probabilityBp / 100).toFixed(1)}%`
                  : `Rule score ${s.score} / 100`}
              </span>{' '}
              <Badge tone={bandTone(s.band)}>{s.band}</Badge>{' '}
              <span className="text-xs text-slate-500">
                confidence {s.confidence.toLowerCase()} · {s.modelVersion}
                {s.basis
                  ? ` · from ${s.basis.sampleSize} decided leads (${s.basis.conversions} joined), trained ${fmtDateTime(s.basis.trainedAt)}`
                  : ''}
              </span>
            </p>
            {s.fallbackReason && (
              <p className="mt-1 text-xs text-amber-700">Using simple rules: {s.fallbackReason}.</p>
            )}
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2" aria-label="Score factors">
              {s.factors.map((f) => (
                <li
                  key={f.factor}
                  className="flex justify-between gap-2 rounded bg-slate-50 px-2 py-1"
                >
                  <span>
                    {f.label}:{' '}
                    <span className="text-slate-600">{VALUE_LABEL[f.value] ?? f.value}</span>
                  </span>
                  <span
                    className={`tabular-nums ${f.weight > 0 ? 'text-green-700' : f.weight < 0 ? 'text-red-700' : 'text-slate-400'}`}
                  >
                    {f.weight > 0 ? '+' : ''}
                    {f.weight}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {v.override && (
          <p className="text-sm text-slate-600">
            Priority set to <strong>{v.override.band}</strong> by {v.override.by ?? 'someone'} on{' '}
            {fmtDateTime(v.override.at)}: “{v.override.reason}”
          </p>
        )}
        {v.canOverride &&
          (overriding ? (
            <form
              className="grid gap-3 sm:grid-cols-[8rem_1fr_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                void act.run(async () => {
                  await api(`/leads/${leadId}/ai/override`, {
                    method: 'POST',
                    body: { band, reason },
                  });
                  setOverriding(false);
                  setReason('');
                  await done();
                });
              }}
            >
              <Field label="Priority">
                <Select
                  aria-label="Priority band"
                  value={band}
                  onChange={(e) => setBand(e.target.value as Band)}
                >
                  <option value="HIGH">High</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="LOW">Low</option>
                </Select>
              </Field>
              <Field label="Reason">
                <Input
                  aria-label="Override reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                  minLength={5}
                />
              </Field>
              <div className="flex items-end gap-2">
                <Button disabled={act.busy}>Save priority</Button>
                <Button type="button" variant="secondary" onClick={() => setOverriding(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="secondary" onClick={() => setOverriding(true)}>
              Change priority
            </Button>
          ))}
        {v.suggestions.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Suggested next actions</h3>
            <ul className="mt-2 space-y-2">
              {v.suggestions.map((x) => (
                <li
                  key={x.kind}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md ring-1 ring-slate-200 px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium">{x.title}</p>
                    <p className="text-xs text-slate-500">{x.reason}</p>
                  </div>
                  {v.canOverride && (
                    <div className="flex gap-2">
                      <Button
                        disabled={act.busy}
                        onClick={() =>
                          void act.run(async () => {
                            await api(`/leads/${leadId}/ai/suggestions/${x.kind}/accept`, {
                              method: 'POST',
                            });
                            await done();
                          })
                        }
                      >
                        {x.needsApproval ? 'Approve' : 'Create task'}
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={act.busy}
                        onClick={() =>
                          void act.run(async () => {
                            await api(`/leads/${leadId}/ai/suggestions/${x.kind}/dismiss`, {
                              method: 'POST',
                              body: {},
                            });
                            await view.reload();
                          })
                        }
                      >
                        Dismiss
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ErrorText error={act.error} />
      </div>
    </Card>
  );
}
