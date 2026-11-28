'use client';
import { useState } from 'react';
import { Badge, Button, Card, ErrorText, useAction } from '@/components/ui';
import { api } from '@/lib/api';
import { CATEGORY_LABEL, MESSAGE_CHANNEL_LABEL } from '@/lib/lead-format';

interface PreviewChannel {
  channel: 'WHATSAPP' | 'EMAIL' | 'SMS';
  ready: boolean;
  template: string | null;
  recipient?: string;
  subject?: string | null;
  body?: string;
  reason?: string;
}
interface SendResult {
  channel: string;
  sent: boolean;
  reason?: string;
}

const SITUATIONS = ['COURSE_DETAILS', 'COLLEGE_DETAILS', 'FOLLOW_UP', 'FEE_DETAILS', 'GENERAL'];

/**
 * One click: pick a situation, check the preview, send the approved templates on WhatsApp, e-mail and SMS together
 * (A-049). Each message goes through the normal send rules and appears in the timeline.
 */
export function QuickMessages({ leadId, onChanged }: { leadId: string; onChanged: () => void }) {
  const [category, setCategory] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewChannel[] | null>(null);
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<SendResult[] | null>(null);
  const load = useAction();
  const send = useAction();

  const open = (c: string) =>
    void load.run(async () => {
      setCategory(c);
      setResult(null);
      const r = await api<{ channels: PreviewChannel[] }>(
        `/leads/${leadId}/messages/quick?category=${c}`,
      );
      setPreview(r.channels);
      setPick(Object.fromEntries(r.channels.map((x) => [x.channel, x.ready])));
    });
  const chosen = preview?.filter((x) => x.ready && pick[x.channel]) ?? [];

  return (
    <Card title="Quick messages">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Situations">
        {SITUATIONS.map((c) => (
          <Button
            key={c}
            variant={category === c ? 'primary' : 'secondary'}
            disabled={load.busy || send.busy}
            onClick={() => open(c)}
          >
            {CATEGORY_LABEL[c]}
          </Button>
        ))}
      </div>
      <ErrorText error={load.error} />
      {preview && category && (
        <div className="mt-4 space-y-3">
          {preview.map((x) => (
            <div key={x.channel} className="rounded-md p-3 ring-1 ring-slate-200">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  disabled={!x.ready}
                  checked={!!pick[x.channel] && x.ready}
                  onChange={(e) => setPick({ ...pick, [x.channel]: e.target.checked })}
                />
                {MESSAGE_CHANNEL_LABEL[x.channel]}
                {x.ready ? (
                  <span className="font-normal text-slate-500">to {x.recipient}</span>
                ) : (
                  <Badge tone="amber">not available</Badge>
                )}
              </label>
              {x.ready ? (
                <div className="mt-2 text-sm whitespace-pre-line text-slate-700">
                  {x.subject && <p className="font-medium">{x.subject}</p>}
                  {x.body}
                </div>
              ) : (
                <p className="mt-1 text-xs text-slate-600">
                  {x.reason}
                  {x.template ? ` (template “${x.template}”)` : ''}
                </p>
              )}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={send.busy || chosen.length === 0}
              onClick={() =>
                void send.run(async () => {
                  const r = await api<{ results: SendResult[] }>(
                    `/leads/${leadId}/messages/quick`,
                    {
                      method: 'POST',
                      body: { category, channels: chosen.map((x) => x.channel) },
                    },
                  );
                  setResult(r.results);
                  setPreview(null);
                  onChanged();
                })
              }
            >
              {chosen.length
                ? `Send ${CATEGORY_LABEL[category].toLowerCase()} on ${chosen.map((x) => MESSAGE_CHANNEL_LABEL[x.channel]).join(' + ')}`
                : 'Nothing to send'}
            </Button>
            <Button variant="secondary" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
          <ErrorText error={send.error} />
        </div>
      )}
      {result && (
        <ul className="mt-4 space-y-1 text-sm" aria-label="Sent messages">
          {result.map((r) => (
            <li key={r.channel}>
              {r.sent ? '✓' : '✗'} {MESSAGE_CHANNEL_LABEL[r.channel] ?? r.channel}:{' '}
              {r.sent ? 'queued for delivery — see the timeline' : r.reason}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
