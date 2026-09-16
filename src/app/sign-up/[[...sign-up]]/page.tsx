'use client';

import { useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import NuraVoltLogo from '@/components/NuraVoltLogo';
import { Loader2 } from 'lucide-react';

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.49 12c0-.73.13-1.44.35-2.1V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.61 0 3.06.56 4.2 1.65l3.16-3.16A11 11 0 0 0 2.18 7.06L5.84 9.9c.87-2.6 3.3-4.52 6.16-4.52z" />
    </svg>
  );
}

export default function SignUpPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState<'google' | 'email' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signUpWithGoogle = async () => {
    setError(null);
    setPending('google');
    const { error: err } = await authClient.signIn.social({
      provider: 'google',
      callbackURL: '/create-organization',
    });
    if (err) {
      setError(err.message ?? 'Google sign-up failed');
      setPending(null);
    }
  };

  const signUpWithEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending('email');
    const { error: err } = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: '/create-organization',
    });
    if (err) {
      setError(err.message ?? 'Could not create the account');
      setPending(null);
    } else {
      // signUp.email signs the user in; callbackURL only applies to the
      // email-verification flow, so navigate explicitly.
      window.location.href = '/create-organization';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center py-12 px-4">
      <div className="mb-8">
        <NuraVoltLogo width={220} height={55} showTagline={true} />
      </div>

      <Card className="w-full max-w-md bg-white shadow-lg border-0">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold text-gray-900">Create your account</CardTitle>
          <CardDescription>Start monitoring your fleet in minutes</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={signUpWithGoogle}
            disabled={pending !== null}
          >
            {pending === 'google' ? <Loader2 className="h-4 w-4 animate-spin" /> : <GoogleIcon />}
            Continue with Google
          </Button>

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-gray-200" />
            <span className="text-xs uppercase text-gray-400">or</span>
            <div className="h-px flex-1 bg-gray-200" />
          </div>

          <form onSubmit={signUpWithEmail} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="name">Full name</Label>
              <Input
                id="name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Work email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <p className="text-xs text-gray-500">At least 8 characters.</p>
            </div>
            <Button
              type="submit"
              className="w-full bg-blue-600 hover:bg-blue-700 text-white"
              disabled={pending !== null}
            >
              {pending === 'email' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create account
            </Button>
          </form>

          {error && <p className="text-sm text-red-600 bg-red-50 rounded-md p-3">{error}</p>}

          <p className="text-center text-sm text-gray-600">
            Already have an account?{' '}
            <Link href="/sign-in" className="text-blue-600 hover:text-blue-700 font-medium">
              Sign in here
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
