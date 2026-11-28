'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { AvailabilityToggle, NotificationBell } from '@/components/header-widgets';

interface NavItem {
  href: string;
  label: string;
  show: (s: ReturnType<typeof useSession>) => boolean;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', show: (s) => !s.me.user.isPlatformAdmin },
  { href: '/leads', label: 'Leads', show: (s) => s.can('lead.read') || s.can('lead.read_own') },
  {
    href: '/pipeline',
    label: 'Pipeline',
    show: (s) => !s.me.user.isPlatformAdmin && (s.can('lead.read') || s.can('lead.read_own')),
  },
  {
    href: '/tasks',
    label: 'My tasks',
    show: (s) => !s.me.user.isPlatformAdmin && (s.can('lead.read') || s.can('lead.read_own')),
  },
  {
    href: '/appointments',
    label: 'Appointments',
    show: (s) => !s.me.user.isPlatformAdmin && (s.can('lead.read') || s.can('lead.read_own')),
  },
  {
    href: '/admissions',
    label: 'Admissions',
    show: (s) =>
      s.can('admission.manage') || (s.can('settings.manage') && !s.me.user.isPlatformAdmin),
  },
  {
    href: '/recovery',
    label: 'Recovery',
    show: (s) =>
      !s.me.user.isPlatformAdmin && (s.can('pipeline.transition') || s.can('recovery.manage')),
  },
  {
    href: '/sla',
    label: 'SLA monitor',
    show: (s) => s.can('task.manage') || s.can('allocation.manage'),
  },
  { href: '/leads/import', label: 'Import leads', show: (s) => s.can('lead.import') },
  { href: '/leads/exceptions', label: 'Rejected leads', show: (s) => s.can('lead.import') },
  { href: '/leads/duplicates', label: 'Possible duplicates', show: (s) => s.can('lead.merge') },
  {
    href: '/allocation',
    label: 'Allocation',
    show: (s) => s.can('lead.assign') || s.can('lead.reassign') || s.can('allocation.manage'),
  },
  {
    href: '/lead-sources',
    label: 'Sources & campaigns',
    show: (s) => s.can('campaign.manage') || s.can('integration.manage'),
  },
  {
    href: '/templates',
    label: 'Message templates',
    show: (s) => s.can('campaign.manage') || s.can('settings.manage'),
  },
  { href: '/brands', label: 'Brands & branches', show: (s) => s.can('brand.read') },
  { href: '/teams', label: 'Teams', show: (s) => s.can('team.read') },
  { href: '/courses', label: 'Courses & batches', show: (s) => s.can('course.read') },
  {
    href: '/settings',
    label: 'Brand settings',
    show: (s) => s.can('brand.read') && !s.me.user.isPlatformAdmin,
  },
  { href: '/users', label: 'Users', show: (s) => s.can('user.read') },
  { href: '/roles', label: 'Roles', show: (s) => s.can('role.read') || s.can('role.assign') },
  { href: '/audit', label: 'Audit log', show: (s) => s.can('audit.read') },
  { href: '/platform', label: 'Organizations', show: (s) => s.me.user.isPlatformAdmin },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => n.show(session));
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.href = '/login';
  };

  return (
    <div className="min-h-screen lg:flex">
      <aside
        className={`${open ? 'block' : 'hidden'} border-b border-slate-200 bg-white lg:block lg:w-60 lg:shrink-0 lg:border-r lg:border-b-0`}
      >
        <div className="hidden px-5 py-5 lg:block">
          <p className="text-xs font-semibold tracking-wide text-brand-700">ACADEMIC SALES CRM</p>
          <p className="mt-1 truncate text-sm text-slate-600">
            {session.me.organization?.name ?? 'Platform administration'}
          </p>
        </div>
        <nav className="space-y-0.5 px-3 py-3 lg:py-0" aria-label="Main">
          {items.map((n) => {
            const active =
              n.href === '/'
                ? pathname === '/'
                : pathname === n.href ||
                  (pathname.startsWith(n.href + '/') &&
                    !NAV.some(
                      (o) =>
                        o.href !== n.href &&
                        o.href.startsWith(n.href + '/') &&
                        pathname.startsWith(o.href),
                    ));
            return (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className={`block rounded-md px-3 py-2 text-sm ${active ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-700 hover:bg-slate-100'}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:px-8">
          <button
            className="rounded-md px-2 py-1 text-sm ring-1 ring-slate-300 lg:hidden"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            Menu
          </button>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <AvailabilityToggle />
            <NotificationBell />
            <span className="hidden text-slate-600 sm:inline">{session.me.user.name}</span>
            <button
              onClick={logout}
              className="rounded-md px-2 py-1 text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
