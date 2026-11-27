/** Browser API client. Same-origin (proxied by Next), cookie auth, CSRF header on every call. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  // One refresh in flight per tab, shared by all concurrent 401s.
  refreshing ??= fetch('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'x-crm-client': 'web' },
    credentials: 'same-origin',
  })
    .then((r) => r.ok)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; retry?: boolean } = {},
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      'x-crm-client': 'web',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401 && init.retry !== false && !path.startsWith('/auth/')) {
    if (await refreshOnce()) return api<T>(path, { ...init, retry: false });
    if (typeof window !== 'undefined') window.location.href = '/login';
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'HTTP_ERROR', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (Array.isArray(e.details) && e.details.length) {
      return e.details
        .map((d: { path: string; message: string }) => `${d.path || 'value'}: ${d.message}`)
        .join('; ');
    }
    return e.message;
  }
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong. Please try again.';
}
