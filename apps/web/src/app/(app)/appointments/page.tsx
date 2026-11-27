'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, ErrorText, PageHeader, Select, Table, Td, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDateTime as fmt } from '@/lib/lead-format';
import { useSession } from '@/lib/session';

interface Row {
  id: string;
  leadId: string;
  startsAt: string;
  mode: string;
  location: string | null;
  status: string;
  counsellorName: string | null;
  lead: { leadNumber: string; person: { fullName: string } } | null;
}
const TONE: Record<string, 'blue' | 'green' | 'amber' | 'slate'> = {
  SCHEDULED: 'blue',
  COMPLETED: 'green',
  NO_SHOW: 'amber',
  CANCELLED: 'slate',
};

export default function AppointmentsPage() {
  const { can } = useSession();
  const [mine, setMine] = useState('true');
  const [status, setStatus] = useState('SCHEDULED');
  const rows = useLoad(
    () => api<Row[]>(`/appointments?mine=${mine}${status ? `&status=${status}` : ''}`),
    [mine, status],
  );
  return (
    <>
      <PageHeader title="Appointments" description="Counselling sessions, soonest first." />
      <Card
        actions={
          <div className="flex gap-2">
            {can('task.manage') && (
              <Select
                aria-label="Whose"
                className="w-40"
                value={mine}
                onChange={(e) => setMine(e.target.value)}
              >
                <option value="true">Mine</option>
                <option value="false">All in my brands</option>
              </Select>
            )}
            <Select
              aria-label="Status"
              className="w-40"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="SCHEDULED">Scheduled</option>
              <option value="COMPLETED">Completed</option>
              <option value="NO_SHOW">No-show</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="">All</option>
            </Select>
          </div>
        }
      >
        <ErrorText error={rows.error} />
        <Table
          head={['When', 'Student', 'Counsellor', 'Mode', 'Status']}
          empty={rows.data?.length === 0}
        >
          {rows.data?.map((r) => (
            <tr key={r.id}>
              <Td className="whitespace-nowrap">{fmt(r.startsAt)}</Td>
              <Td>
                <Link
                  href={`/leads/${r.leadId}`}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {r.lead?.person.fullName} ({r.lead?.leadNumber})
                </Link>
              </Td>
              <Td>{r.counsellorName}</Td>
              <Td>
                {r.mode.replace('_', ' ').toLowerCase()}
                {r.location ? ` · ${r.location}` : ''}
              </Td>
              <Td>
                <Badge tone={TONE[r.status]}>{r.status.replace('_', ' ').toLowerCase()}</Badge>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
