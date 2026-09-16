'use client';

import { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
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

function SignInForm() {
  const searchParams = useSearchParams();
  const redirectUrl = searchParams.get('redirect_url') || '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState<'google' | 'password' | 'magic' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  const signInWithGoogle = async () => {
    setError(null);
    setPending('google');
    const { error: err } = await authClient.signIn.social({
      provider: 'google',
      callbackURL: redirectUrl,
    });
    if (err) {
      setError(err.message ?? 'Google sign-in failed');
      setPending(null);
    }
  };

  const signInWithPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending('password');
    const { error: err } = await authClient.signIn.email({
      email,
      password,
      callbackURL: redirectUrl,
    });
    if (err) {
      setError(err.message ?? 'Invalid email or password');
      setPending(null);
    }
  };

  const sendMagicLink = async () => {
    if (!email) {
      setError('Enter your email first, then request a sign-in link.');
      return;
    }
    setError(null);
    setPending('magic');
    const { error: err } = await authClient.signIn.magicLink({
      email,
      callbackURL: redirectUrl,
    });
    setPending(null);
    if (err) {
      setError(err.message ?? 'Could not send the sign-in link');
    } else {
      setMagicLinkSent(true);
    }
  };

  return (
    <Card className="w-full max-w-md bg-white shadow-lg border-0">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold text-gray-900">Sign in to NuraVolt</CardTitle>
        <CardDescription>Energy intelligence for solar, wind and storage</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          variant="outline"
          className="w-full gap-2"
          onClick={signInWithGoogle}
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

        <form onSubmit={signInWithPassword} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
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
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button
            type="submit"
            className="w-full bg-blue-600 hover:bg-blue-700 text-white"
            disabled={pending !== null}
          >
            {pending === 'password' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Sign in
          </Button>
        </form>

        <button
          type="button"
          onClick={sendMagicLink}
          disabled={pending !== null}
          className="w-full text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50"
        >
          {pending === 'magic' ? 'Sending link…' : 'Email me a sign-in link instead'}
        </button>

        {magicLinkSent && (
          <p className="text-sm text-green-700 bg-green-50 rounded-md p-3">
            Check your inbox. We sent a sign-in link to {email}.
          </p>
        )}
        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-md p-3">{error}</p>
        )}

        <p className="text-center text-sm text-gray-600">
          No account yet?{' '}
          <Link href="/sign-up" className="text-blue-600 hover:text-blue-700 font-medium">
            Create one
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default function SignInPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center py-12 px-4">
      <div className="mb-8">
        <NuraVoltLogo width={220} height={55} showTagline={true} />
      </div>
      <Suspense>
        <SignInForm />
      </Suspense>
    </div>
  );
}
