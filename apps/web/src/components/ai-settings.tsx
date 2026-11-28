'use client';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorText, Field, Input, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/lead-format';

interface AiSettings {
  enabled: boolean;
  scoringEnabled: boolean;
  nextActionsEnabled: boolean;
  highThresholdBp: number;
  mediumThresholdBp: number;
  minTrainingSize: number;
  model: {
    version: string;
    sampleSize: number;
    conversions: number;
    usable: boolean;
    trainedAt: string;
  } | null;
}

/** Brand settings: AI assistance switches, thresholds and model status (A-045). */
export function AiSettingsCard({ brandId, canEdit }: { brandId: string; canEdit: boolean }) {
  const data = useLoad(() => api<AiSettings>(`/ai-settings?brandId=${brandId}`), [brandId]);
  const [v, setV] = useState<AiSettings | null>(null);
  useEffect(() => setV(data.data ?? null), [data.data]);
  const save = useAction();
  const train = useAction();
  if (data.error) return null;
  if (!v) return null;
  const toggle = (k: 'enabled' | 'scoringEnabled' | 'nextActionsEnabled', label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={v[k]}
        disabled={!canEdit}
        onChange={(e) => setV({ ...v, [k]: e.target.checked })}
      />
      {label}
    </label>
  );
  const pct = (bp: number) => String(bp / 100);
  return (
    <Card
      title="AI assistance"
      actions={<Badge tone={v.enabled ? 'green' : 'slate'}>{v.enabled ? 'On' : 'Off'}</Badge>}
    >
      <p className="mb-4 text-xs text-slate-500">
        Advisory priority scores and next-action suggestions, computed inside the CRM from this
        brand&apos;s own outcomes. No personal data is sent to any outside AI service. Scores never
        use name, contact details, location, language or other personal attributes.
      </p>
      <form
        className="grid gap-4 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run(async () => {
            const { model: _model, ...body } = v;
            void _model;
            await api(`/ai-settings?brandId=${brandId}`, { method: 'PUT', body });
            await data.reload();
          });
        }}
      >
        <div className="space-y-2 sm:col-span-3">
          {toggle('enabled', 'Use AI assistance for this brand')}
          {toggle('scoringEnabled', 'Lead priority scores')}
          {toggle('nextActionsEnabled', 'Next-action suggestions')}
        </div>
        <Field label="High from (estimated chance, %)">
          <Input
            inputMode="decimal"
            disabled={!canEdit}
            value={pct(v.highThresholdBp)}
            onChange={(e) =>
              setV({ ...v, highThresholdBp: Math.round(Number(e.target.value) * 100) })
            }
          />
        </Field>
        <Field label="Medium from (%)">
          <Input
            inputMode="decimal"
            disabled={!canEdit}
            value={pct(v.mediumThresholdBp)}
            onChange={(e) =>
              setV({ ...v, mediumThresholdBp: Math.round(Number(e.target.value) * 100) })
            }
          />
        </Field>
        <Field label="Decided leads needed to train">
          <Input
            inputMode="numeric"
            disabled={!canEdit}
            value={String(v.minTrainingSize)}
            onChange={(e) => setV({ ...v, minTrainingSize: Number(e.target.value) })}
          />
        </Field>
        {canEdit && (
          <div className="sm:col-span-3">
            <Button disabled={save.busy}>Save AI settings</Button>
          </div>
        )}
        <div className="sm:col-span-3">
          <ErrorText error={save.error} />
        </div>
      </form>
      <div className="mt-6 border-t border-slate-200 pt-4 text-sm">
        {v.model ? (
          <p>
            Model <strong>{v.model.version}</strong> trained {fmtDateTime(v.model.trainedAt)} on{' '}
            {v.model.sampleSize} decided leads ({v.model.conversions} joined).{' '}
            {v.model.usable ? (
              <Badge tone="green">In use</Badge>
            ) : (
              <Badge tone="amber">Not enough history — simple rules are used</Badge>
            )}
          </p>
        ) : (
          <p className="text-slate-500">No model trained yet — simple rules are used.</p>
        )}
        <p className="mt-1 text-xs text-slate-500">
          Retrained daily while AI assistance is on; open leads are rescored every hour.
        </p>
        {canEdit && (
          <Button
            className="mt-3"
            variant="secondary"
            disabled={train.busy}
            onClick={() =>
              void train.run(async () => {
                await api(`/ai-settings/${brandId}/train`, { method: 'POST' });
                await data.reload();
              })
            }
          >
            Train now
          </Button>
        )}
        <ErrorText error={train.error} />
      </div>
    </Card>
  );
}
