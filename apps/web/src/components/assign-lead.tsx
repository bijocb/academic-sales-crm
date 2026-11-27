'use client';
import { useState } from 'react';
import { Button, ErrorText, Field, Input, Select, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';

export interface Executive {
  userId: string;
  name: string;
  isAvailable: boolean;
  onLeave: boolean;
  activeLeads: number;
  maxActiveLeads: number | null;
  languages: string[];
  lastAssignedAt: string | null;
}

export const execLabel = (e: Executive) =>
  `${e.name} — ${e.activeLeads}${e.maxActiveLeads != null ? `/${e.maxActiveLeads}` : ''} open${!e.isAvailable ? ' · not taking leads' : ''}${e.onLeave ? ' · on leave' : ''}`;

/** Manual (re)assignment with a mandatory reason. */
export function AssignLead({
  leadId,
  brandId,
  currentOwnerId,
  onDone,
}: {
  leadId: string;
  brandId: string;
  currentOwnerId: string | null;
  onDone: () => void;
}) {
  const execs = useLoad(
    () => api<Executive[]>(`/allocation/executives?brandId=${brandId}`),
    [brandId],
  );
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/leads/${leadId}/assign`, { method: 'POST', body: { userId, reason } });
          setReason('');
          onDone();
        });
      }}
    >
      <div className="w-72">
        <Field label={currentOwnerId ? 'Reassign to' : 'Assign to'}>
          <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Select an executive…</option>
            {execs.data
              ?.filter((x) => x.userId !== currentOwnerId)
              .map((x) => (
                <option key={x.userId} value={x.userId}>
                  {execLabel(x)}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      <div className="min-w-56 flex-1">
        <Field label="Reason (required)">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Speaks Malayalam"
          />
        </Field>
      </div>
      <Button type="submit" disabled={busy || !userId || reason.trim().length < 3}>
        {currentOwnerId ? 'Reassign' : 'Assign'}
      </Button>
      <div className="w-full">
        <ErrorText error={error ?? execs.error} />
      </div>
    </form>
  );
}
