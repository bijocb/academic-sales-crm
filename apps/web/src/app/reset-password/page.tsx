'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PASSWORD_MIN_LENGTH } from '@crm/contracts';
import { AuthShell } from '@/components/auth-shell';
import { Button, ErrorText, Field, Input, useAction } from '@/components/ui';
import { api } from '@/lib/api';

function ResetForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const invite = params.get('invite') === '1';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run, setError } = useAction();

  if (done) {
    return (
      <p className="text-sm text-slate-600">
        Your password has been set.{' '}
        <Link href="/login" className="text-brand-700 hover:underline">
          Sign in
        </Link>
      </p>
    );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (password !== confirm) {
          setError(new Error('Passwords do not match'));
          return;
        }
        void run(async () => {
          await api('/auth/password/reset', {
            method: 'POST',
            body: { token, newPassword: password },
          });
          setDone(true);
        });
      }}
    >
      {invite && (
        <p className="text-sm text-slate-600">
          Welcome! Choose a password to activate your account.
        </p>
      )}
      <Field label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters`}>
        <Input
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Field label="Confirm password">
        <Input
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      <ErrorText error={error} />
      <Button type="submit" className="w-full" disabled={busy || !token}>
        {invite ? 'Activate account' : 'Set new password'}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthShell title="Set your password">
      <Suspense>
        <ResetForm />
      </Suspense>
    </AuthShell>
  );
}
