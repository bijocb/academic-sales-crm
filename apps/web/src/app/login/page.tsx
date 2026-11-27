'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { Button, ErrorText, Field, Input, useAction } from '@/components/ui';
import { api } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();

  return (
    <AuthShell title="Sign in">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/auth/login', { method: 'POST', body: { email, password } });
            router.replace('/');
          });
        }}
      >
        <Field label="Email">
          <Input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorText error={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <p className="text-center text-sm">
          <Link href="/forgot-password" className="text-brand-700 hover:underline">
            Forgot password?
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
