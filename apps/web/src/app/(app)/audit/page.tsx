'use client';
import { useState } from 'react';
import { Button, Card, ErrorText, PageHeader, Table, Td, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { Paged } from '@/lib/types';

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  reason: string | null;
  ip: string | null;
  createdAt: string;
}

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const logs = useLoad(() => api<Paged<AuditRow>>(`/audit-logs?page=${page}&pageSize=50`), [page]);
  const pages = logs.data ? Math.max(1, Math.ceil(logs.data.total / logs.data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only record of security and configuration changes. Entries cannot be edited or deleted."
      />
      <ErrorText error={logs.error} />
      <Card>
        <Table
          head={['When', 'Action', 'Entity', 'Actor', 'Reason', 'IP']}
          empty={logs.data?.items.length === 0}
        >
          {logs.data?.items.map((l) => (
            <tr key={l.id}>
              <Td className="whitespace-nowrap">{new Date(l.createdAt).toLocaleString()}</Td>
              <Td className="font-mono text-xs">{l.action}</Td>
              <Td className="font-mono text-xs">
                {l.entityType}
                {l.entityId ? `:${l.entityId.slice(0, 8)}` : ''}
              </Td>
              <Td className="font-mono text-xs">{l.actorUserId?.slice(0, 8) ?? 'system'}</Td>
              <Td>{l.reason ?? '—'}</Td>
              <Td className="font-mono text-xs">{l.ip ?? '—'}</Td>
            </tr>
          ))}
        </Table>
        <div className="mt-4 flex items-center gap-2 text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-slate-600">
            Page {page} of {pages}
          </span>
          <Button
            variant="secondary"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </Card>
    </>
  );
}
