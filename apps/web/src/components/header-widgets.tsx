'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Note {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

/** "Taking leads" switch for lead recipients (A-029). */
export function AvailabilityToggle() {
  const { can, me } = useSession();
  const [on, setOn] = useState<boolean | null>(null);
  const show = can('lead.receive') && !me.user.isPlatformAdmin;
  useEffect(() => {
    if (show)
      void api<{ isAvailable: boolean }>('/me/availability')
        .then((r) => setOn(r.isAvailable))
        .catch(() => undefined);
  }, [show]);
  if (!show || on === null) return null;
  return (
    <button
      onClick={async () =>
        setOn(
          (
            await api<{ isAvailable: boolean }>('/me/availability', {
              method: 'PUT',
              body: { isAvailable: !on },
            })
          ).isAvailable,
        )
      }
      className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${on ? 'bg-green-50 text-green-800 ring-green-600/30' : 'bg-slate-100 text-slate-600 ring-slate-300'}`}
      aria-pressed={on}
      title="When off, no new leads are allocated to you"
    >
      {on ? '● Taking leads' : '○ Not taking leads'}
    </button>
  );
}

export function NotificationBell() {
  const { me } = useSession();
  const [data, setData] = useState<{ items: Note[]; unread: number } | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const load = () =>
    api<{ items: Note[]; unread: number }>('/notifications')
      .then(setData)
      .catch(() => undefined);
  useEffect(() => {
    if (me.user.isPlatformAdmin) return;
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [me.user.isPlatformAdmin]);
  useEffect(() => {
    const close = (e: MouseEvent) =>
      ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  if (me.user.isPlatformAdmin || !data) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md px-2 py-1 ring-1 ring-slate-300 hover:bg-slate-50"
        aria-label={`Notifications, ${data.unread} unread`}
      >
        🔔
        {data.unread > 0 && (
          <span className="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white">
            {data.unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-md bg-white shadow-lg ring-1 ring-slate-200">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-sm">
            <span className="font-medium">Notifications</span>
            {data.unread > 0 && (
              <button
                className="text-xs text-brand-700 hover:underline"
                onClick={async () => {
                  await api('/notifications/read', { method: 'POST' });
                  await load();
                }}
              >
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {data.items.length === 0 && (
              <li className="px-3 py-4 text-sm text-slate-500">Nothing yet.</li>
            )}
            {data.items.map((n) => (
              <li
                key={n.id}
                className={`border-b border-slate-100 px-3 py-2 text-sm ${n.readAt ? 'text-slate-500' : ''}`}
              >
                <Link
                  href={n.link ?? '#'}
                  onClick={() => {
                    setOpen(false);
                    if (!n.readAt)
                      void api(`/notifications/${n.id}/read`, { method: 'POST' }).then(load);
                  }}
                  className="block hover:underline"
                >
                  <span className={n.readAt ? '' : 'font-medium'}>{n.title}</span>
                  {n.body && <span className="block text-xs text-slate-500">{n.body}</span>}
                  <span className="block text-xs text-slate-400">
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
