'use client';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '@/lib/api';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
};

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const styles = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-300',
    secondary:
      'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50',
  }[variant];
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed ${styles} ${className}`}
    />
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

const inputCls =
  'block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-600 focus:outline-none';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-slate-800">{title}</h2>}
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Badge({
  children,
  tone = 'slate',
}: {
  children: React.ReactNode;
  tone?: 'slate' | 'green' | 'amber' | 'red' | 'blue';
}) {
  const t = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-green-50 text-green-700 ring-green-600/20',
    amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
    red: 'bg-red-50 text-red-700 ring-red-600/20',
    blue: 'bg-brand-50 text-brand-700 ring-brand-600/20',
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-transparent ${t}`}
    >
      {children}
    </span>
  );
}

export const statusTone = (s: string) =>
  (
    ({
      ACTIVE: 'green',
      INVITED: 'blue',
      SUSPENDED: 'amber',
      DEACTIVATED: 'red',
      ARCHIVED: 'slate',
    }) as const
  )[s as 'ACTIVE'] ?? 'slate';

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
      {errorMessage(error)}
    </p>
  );
}

export function Table({
  head,
  children,
  empty,
}: {
  head: string[];
  children: React.ReactNode;
  empty?: boolean;
}) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {empty ? (
            <tr>
              <td colSpan={head.length} className="px-4 py-6 text-center text-slate-500">
                Nothing here yet.
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}

export const Td = ({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) => <td className={`px-4 py-2 align-top ${className}`}>{children}</td>;

/** Load data with loading/error state; `reload` re-fetches. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const load = useCallback(loader, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(undefined);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

/** Wraps a submit handler with busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}
