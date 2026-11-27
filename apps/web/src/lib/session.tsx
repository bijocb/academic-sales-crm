'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './api';
import type { Me } from './types';

interface Session {
  me: Me;
  /** Holds the permission at any scope (UI hint only — the API enforces real access). */
  can: (permission: string) => boolean;
  canOrgWide: (permission: string) => boolean;
  reload: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  const reload = useCallback(async () => {
    try {
      setMe(await api<Me>('/auth/me'));
    } catch {
      router.replace('/login');
    }
  }, [router]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!me) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }
  const can = (p: string) => (me.permissions[p]?.length ?? 0) > 0;
  const canOrgWide = (p: string) =>
    (me.permissions[p] ?? []).some((s) => s.scopeType === 'ORGANIZATION');
  return (
    <SessionContext.Provider value={{ me, can, canOrgWide, reload }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
