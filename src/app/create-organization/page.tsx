'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import NuraVoltLogo from '@/components/NuraVoltLogo';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
}

export default function CreateOrganizationPage() {
  const router = useRouter();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data: organizations, isPending: orgsPending } = authClient.useListOrganizations();

  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Signed-out users go to sign-in; users who already belong to an org skip this step.
  useEffect(() => {
    if (!sessionPending && !session) {
      router.replace('/sign-in?redirect_url=/create-organization');
    }
  }, [session, sessionPending, router]);

  useEffect(() => {
    if (!orgsPending && organizations && organizations.length > 0) {
      router.replace('/dashboard');
    }
  }, [organizations, orgsPending, router]);

  const createOrganization = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCreating(true);

    const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error: err } = await authClient.organization.create({ name, slug });
    if (err || !data) {
      setError(err?.message ?? 'Could not create the organization');
      setCreating(false);
      return;
    }
    await authClient.organization.setActive({ organizationId: data.id });
    router.push('/onboarding');
  };

  if (sessionPending || orgsPending) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center py-12 px-4">
      <div className="mb-8">
        <NuraVoltLogo width={220} height={55} showTagline={false} />
      </div>

      <Card className="w-full max-w-md bg-white shadow-lg border-0">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold text-gray-900">Set up your organization</CardTitle>
          <CardDescription>
            Plants, team members and tickets all live inside an organization.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={createOrganization} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="org-name">Organization name</Label>
              <Input
                id="org-name"
                placeholder="e.g. Helios Asset Management"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
              />
            </div>
            <Button
              type="submit"
              className="w-full bg-blue-600 hover:bg-blue-700 text-white"
              disabled={creating || name.trim().length < 2}
            >
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create organization
            </Button>
          </form>

          {error && <p className="text-sm text-red-600 bg-red-50 rounded-md p-3">{error}</p>}
        </CardContent>
      </Card>

      <Link href="/dashboard" className="mt-4 text-sm text-gray-500 hover:text-gray-700 hover:underline">
        ← Back to dashboard
      </Link>
    </div>
  );
}
