import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/** API base, e.g. https://crm.example.com/api/v1 (app.json `extra.apiUrl`, or EXPO_PUBLIC_API_URL at build time). */
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
  'http://localhost:3000/api/v1';

const RT_KEY = 'crm.refreshToken';
// SecureStore (Keychain / Keystore) holds the refresh token. The web preview has no secure store and keeps it in memory.
const secure = {
  get: () => (Platform.OS === 'web' ? Promise.resolve(memoryRt) : SecureStore.getItemAsync(RT_KEY)),
  set: (v: string) =>
    Platform.OS === 'web'
      ? ((memoryRt = v), Promise.resolve())
      : SecureStore.setItemAsync(RT_KEY, v),
  clear: () =>
    Platform.OS === 'web'
      ? ((memoryRt = null), Promise.resolve())
      : SecureStore.deleteItemAsync(RT_KEY),
};
let memoryRt: string | null = null;
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
/** No connection (or the server could not be reached). */
export class OfflineError extends Error {
  constructor() {
    super('You are offline. This needs a connection — try again when you are back online.');
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

async function raw(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'x-crm-client': 'mobile',
    Accept: 'application/json',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.auth !== false && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
  try {
    return await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new OfflineError();
  }
}

async function fail(r: Response): Promise<never> {
  let code = 'HTTP_' + r.status;
  let message = `Request failed (${r.status})`;
  try {
    const b = (await r.json()) as { code?: string; message?: string | string[] };
    if (b.code) code = b.code;
    if (b.message) message = Array.isArray(b.message) ? b.message.join(', ') : b.message;
  } catch {
    /* not JSON */
  }
  throw new ApiError(r.status, code, message);
}

async function storeTokens(t: Tokens) {
  accessToken = t.accessToken;
  await secure.set(t.refreshToken);
}

/** Exchange the stored refresh token for a new pair (rotated by the server). One refresh at a time. */
export function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const rt = await secure.get();
      if (!rt) return false;
      const r = await raw('/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: rt }),
        auth: false,
      });
      if (r.status === 401) {
        await secure.clear();
        return false;
      }
      if (!r.ok) await fail(r);
      await storeTokens((await r.json()) as Tokens);
      return true;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export let onSignedOut: () => void = () => {};
export const setOnSignedOut = (f: () => void) => {
  onSignedOut = f;
};

/** JSON request with the access token; refreshes once on 401. */
export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  };
  let r = await raw(path, init);
  if (r.status === 401 && (await refresh())) r = await raw(path, init);
  if (r.status === 401) {
    accessToken = null;
    onSignedOut();
  }
  if (!r.ok) await fail(r);
  return (r.status === 204 ? undefined : await r.json()) as T;
}

export async function signIn(email: string, password: string): Promise<void> {
  const r = await raw('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    auth: false,
  });
  if (!r.ok) await fail(r);
  await storeTokens((await r.json()) as Tokens);
}

export async function signOut(): Promise<void> {
  // Ends this session on the server (the access token identifies it).
  if (accessToken) await raw('/auth/logout', { method: 'POST' }).catch(() => undefined);
  accessToken = null;
  await secure.clear();
  await AsyncStorage.clear().catch(() => undefined); // the read-only cache belongs to the signed-in user
}

/** Sign back in from the stored refresh token at start-up. Offline with a stored token, cached screens stay usable. */
export async function restoreSession(): Promise<'ok' | 'none' | 'offline'> {
  try {
    return (await refresh()) ? 'ok' : 'none';
  } catch (e) {
    return e instanceof OfflineError && (await secure.get()) ? 'offline' : 'none';
  }
}
