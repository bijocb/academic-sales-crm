'use client';
import Link from 'next/link';
import { useState } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { Button, ErrorText, Field, Input, useAction } from '@/components/ui';
import { api } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();

  return (
    <AuthShell title="Reset your password">
      {sent ? (
        <p className="text-sm text-slate-600">
          If an active account exists for <strong>{email}</strong>, we have emailed a reset link. It
          is valid for 30 minutes.
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/auth/password/forgot', { method: 'POST', body: { email } });
              setSent(true);
            });
          }}
        >
          <Field label="Email">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <ErrorText error={error} />
          <Button type="submit" className="w-full" disabled={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-4 text-center text-sm">
        <Link href="/login" className="text-brand-700 hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
