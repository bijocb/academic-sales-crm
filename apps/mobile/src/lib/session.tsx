import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, restoreSession, setOnSignedOut, signIn, signOut } from './api';
import { registerForPush, unregisterPush } from './push';

export interface Me {
  user: { id: string; name: string; email: string };
  organization: { name: string } | null;
}
type State = { status: 'loading' } | { status: 'signedOut' } | { status: 'signedIn'; me: Me };

interface Session {
  state: State;
  pushNote: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}
const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [pushNote, setPushNote] = useState<string | null>(null);

  const start = useCallback(async () => {
    const me = await api<Me>('/auth/me');
    setState({ status: 'signedIn', me });
    const r = await registerForPush().catch(() => ({
      ok: false as const,
      reason: 'Push set-up failed.',
    }));
    setPushNote(r.ok ? null : r.reason);
  }, []);

  useEffect(() => {
    setOnSignedOut(() => setState({ status: 'signedOut' }));
    void (async () => {
      const r = await restoreSession();
      if (r === 'ok') await start().catch(() => setState({ status: 'signedOut' }));
      else if (r === 'offline')
        // Offline with a stored session: cached screens show; writes say they need a connection.
        setState({
          status: 'signedIn',
          me: { user: { id: '', name: '', email: '' }, organization: null },
        });
      else setState({ status: 'signedOut' });
    })();
  }, [start]);

  const value: Session = {
    state,
    pushNote,
    signIn: async (email, password) => {
      await signIn(email, password);
      await start();
    },
    signOut: async () => {
      await unregisterPush();
      await signOut();
      setState({ status: 'signedOut' });
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
