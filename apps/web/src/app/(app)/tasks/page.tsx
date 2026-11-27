'use client';
import { useState } from 'react';
import { TaskList } from '@/components/task-panel';
import { Card, ErrorText, PageHeader, Select, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { TaskRow } from '@/lib/types';

const endOfToday = () => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
};

const FILTERS = {
  open: { label: 'All open', qs: 'status=OPEN' },
  overdue: { label: 'Overdue', qs: 'status=OPEN&due=overdue' },
  today: { label: 'Due by end of today', qs: '' },
  done: { label: 'Completed', qs: 'status=COMPLETED' },
} as const;

export default function TasksPage() {
  const { can } = useSession();
  const [view, setView] = useState<'mine' | 'team'>('mine');
  const [filter, setFilter] = useState<keyof typeof FILTERS>('open');
  const qs =
    filter === 'today'
      ? `status=OPEN&dueBefore=${encodeURIComponent(endOfToday())}`
      : FILTERS[filter].qs;
  const tasks = useLoad(() => api<TaskRow[]>(`/tasks?view=${view}&${qs}`), [view, qs]);
  const overdue = tasks.data?.filter((t) => t.overdue).length ?? 0;

  return (
    <>
      <PageHeader
        title={view === 'mine' ? 'My tasks' : 'Team tasks'}
        description="Calls and follow-ups, soonest first. Completing a call records its outcome and the next action."
      />
      <Card
        title={
          tasks.data
            ? `${tasks.data.length} task(s)${overdue ? ` · ${overdue} overdue` : ''}`
            : 'Tasks'
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {can('task.manage') && (
              <Select
                aria-label="Whose tasks"
                className="w-36"
                value={view}
                onChange={(e) => setView(e.target.value as 'mine' | 'team')}
              >
                <option value="mine">Mine</option>
                <option value="team">My team</option>
              </Select>
            )}
            <Select
              aria-label="Filter"
              className="w-52"
              value={filter}
              onChange={(e) => setFilter(e.target.value as keyof typeof FILTERS)}
            >
              {Object.entries(FILTERS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        <ErrorText error={tasks.error} />
        <TaskList
          tasks={tasks.data}
          onChanged={() => void tasks.reload()}
          showLead
          empty="Nothing here — well done."
        />
      </Card>
    </>
  );
}
