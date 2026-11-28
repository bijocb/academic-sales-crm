import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, api, OfflineError } from './api';

/**
 * Read-only offline cache (A-050): the last loaded copy of a screen's data is kept on the phone. Offline, screens show
 * that copy with its age; anything that writes (log a call, send WhatsApp) needs a connection and says so.
 */
export interface Cached<T> {
  data: T;
  savedAt: string;
  stale: boolean;
}

const key = (path: string) => `cache:${path}`;

export async function cachedGet<T>(path: string): Promise<Cached<T>> {
  try {
    const data = await api<T>(path);
    const savedAt = new Date().toISOString();
    await AsyncStorage.setItem(key(path), JSON.stringify({ data, savedAt })).catch(() => undefined);
    return { data, savedAt, stale: false };
  } catch (e) {
    if (!(e instanceof OfflineError) && !(e instanceof ApiError && e.status >= 500)) throw e;
    const hit = await AsyncStorage.getItem(key(path)).catch(() => null);
    if (!hit) throw e;
    const c = JSON.parse(hit) as { data: T; savedAt: string };
    return { ...c, stale: true };
  }
}
