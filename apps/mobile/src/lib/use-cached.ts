import { useCallback, useEffect, useState } from 'react';
import { cachedGet, type Cached } from './cache';

/** Load a GET through the offline cache; `reload` re-fetches (pull to refresh). */
export function useCached<T>(path: string | null) {
  const [res, setRes] = useState<Cached<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setRes(await cachedGet<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load');
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return {
    data: res?.data ?? null,
    stale: res?.stale ?? false,
    savedAt: res?.savedAt,
    error,
    loading,
    reload,
  };
}
