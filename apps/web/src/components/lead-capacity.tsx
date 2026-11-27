'use client';
import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  Table,
  Td,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import type { User } from '@/lib/types';

interface Leave {
  id: string;
  startDate: string;
  endDate: string;
  reason: string | null;
}

const day = (d: string) => d.slice(0, 10);

/** Allocation settings for one user: capacity, languages and leave (Phase 6). */
export function LeadCapacity({ userId, onChanged }: { userId: string; onChanged?: () => void }) {
  const user = useLoad(() => api<User>(`/users/${userId}`), [userId]);
  const leaves = useLoad(() => api<Leave[]>(`/users/${userId}/leaves`), [userId]);
  const [cap, setCap] = useState('');
  const [langs, setLangs] = useState('');
  const [leave, setLeave] = useState({ startDate: '', endDate: '', reason: '' });
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!user.data) return;
    setCap(user.data.maxActiveLeads != null ? String(user.data.maxActiveLeads) : '');
    setLangs(user.data.languages.join(', '));
  }, [user.data]);

  return (
    <Card title="Lead allocation">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api(`/users/${userId}`, {
              method: 'PATCH',
              body: {
                maxActiveLeads: cap.trim() === '' ? null : Number(cap),
                languages: langs
                  .split(',')
                  .map((s) => s.trim().toLowerCase())
                  .filter(Boolean),
              },
            });
            await user.reload();
            onChanged?.();
          });
        }}
      >
        <div className="w-44">
          <Field label="Max open leads">
            <Input
              type="number"
              min={0}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="No limit"
            />
          </Field>
        </div>
        <div className="w-64">
          <Field label="Languages (comma separated)">
            <Input value={langs} onChange={(e) => setLangs(e.target.value)} placeholder="en, ml" />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={busy}>
          Save capacity
        </Button>
      </form>

      <h3 className="mt-6 mb-2 text-sm font-semibold text-slate-700">Leave</h3>
      <Table head={['From', 'To', 'Reason', '']} empty={leaves.data?.length === 0}>
        {leaves.data?.map((l) => (
          <tr key={l.id}>
            <Td>{day(l.startDate)}</Td>
            <Td>{day(l.endDate)}</Td>
            <Td>{l.reason ?? '—'}</Td>
            <Td>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/leaves/${l.id}`, { method: 'DELETE' });
                    await leaves.reload();
                  })
                }
              >
                Cancel
              </Button>
            </Td>
          </tr>
        ))}
      </Table>
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api(`/users/${userId}/leaves`, {
              method: 'POST',
              body: { ...leave, reason: leave.reason || undefined },
            });
            setLeave({ startDate: '', endDate: '', reason: '' });
            await leaves.reload();
          });
        }}
      >
        <Field label="Leave from">
          <Input
            type="date"
            required
            value={leave.startDate}
            onChange={(e) => setLeave({ ...leave, startDate: e.target.value })}
          />
        </Field>
        <Field label="Leave to">
          <Input
            type="date"
            required
            value={leave.endDate}
            onChange={(e) => setLeave({ ...leave, endDate: e.target.value })}
          />
        </Field>
        <div className="w-56">
          <Field label="Leave reason">
            <Input
              value={leave.reason}
              onChange={(e) => setLeave({ ...leave, reason: e.target.value })}
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={busy}>
          Add leave
        </Button>
      </form>
      <ErrorText error={error ?? leaves.error ?? user.error} />
    </Card>
  );
}
