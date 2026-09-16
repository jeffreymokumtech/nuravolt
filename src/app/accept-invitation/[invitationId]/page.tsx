'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { authClient, useSession, signOut } from '@/lib/auth-client';

/**
 * Landing page for organization invitation emails
 * (linked from the sendInvitationEmail hook in src/lib/auth.ts).
 *
 * Flow: signed-out visitors bounce to /sign-in with a redirect back here;
 * signed-in visitors see the org + inviter and accept with one click. The
 * afterAcceptInvitation hook mirrors the membership into the legacy UserRole
 * table, so org access works immediately after accepting.
 */

interface InvitationInfo {
  organizationName?: string;
  inviterEmail?: string;
  email?: string;
  role?: string;
  status?: string;
}

export default function AcceptInvitationPage() {
  const params = useParams<{ invitationId: string }>();
  const invitationId = params?.invitationId ?? '';
  const router = useRouter();
  const { data: session, isPending } = useSession();

  const [invitation, setInvitation] = useState<InvitationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Signed out → sign in first, then come back here.
  useEffect(() => {
    if (!isPending && !session) {
      router.replace(`/sign-in?redirect_url=${encodeURIComponent(`/accept-invitation/${invitationId}`)}`);
    }
  }, [isPending, session, invitationId, router]);

  // Load invitation details for the confirmation screen.
  useEffect(() => {
    if (!session || !invitationId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error: err } = await authClient.organization.getInvitation({
          query: { id: invitationId },
        });
        if (cancelled) return;
        if (err || !data) {
          setError(err?.message || 'This invitation could not be found. It may have been cancelled.');
        } else {
          setInvitation({
            organizationName: (data as any).organizationName,
            inviterEmail: (data as any).inviterEmail,
            email: (data as any).email,
            role: (data as any).role,
            status: (data as any).status,
          });
        }
      } catch {
        if (!cancelled) setError('This invitation could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, invitationId]);

  const emailMismatch = Boolean(
    invitation?.email &&
      session?.user?.email &&
      invitation.email.toLowerCase() !== session.user.email.toLowerCase(),
  );

  const handleAccept = async () => {
    setAccepting(true);
    setError(null);
    const { error: err } = await authClient.organization.acceptInvitation({ invitationId });
    if (err) {
      setError(err.message || 'Failed to accept the invitation.');
      setAccepting(false);
      return;
    }
    router.push('/dashboard');
  };

  const handleSwitchAccount = async () => {
    await signOut();
    router.replace(`/sign-in?redirect_url=${encodeURIComponent(`/accept-invitation/${invitationId}`)}`);
  };

  if (isPending || !session || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500">Loading invitation…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-200 p-8">
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Team invitation</h1>

        {error ? (
          <>
            <p className="text-sm text-red-600 mb-6">{error}</p>
            <button
              onClick={() => router.push('/dashboard')}
              className="w-full rounded-lg bg-gray-900 text-white py-2.5 text-sm font-medium hover:bg-gray-800"
            >
              Go to dashboard
            </button>
          </>
        ) : invitation?.status && invitation.status !== 'pending' ? (
          <>
            <p className="text-sm text-gray-600 mb-6">
              This invitation has already been {invitation.status}.
            </p>
            <button
              onClick={() => router.push('/dashboard')}
              className="w-full rounded-lg bg-gray-900 text-white py-2.5 text-sm font-medium hover:bg-gray-800"
            >
              Go to dashboard
            </button>
          </>
        ) : emailMismatch ? (
          <>
            <p className="text-sm text-gray-600 mb-1">
              This invitation is for <strong>{invitation?.email}</strong>, but you&apos;re signed in as{' '}
              <strong>{session.user.email}</strong>.
            </p>
            <p className="text-sm text-gray-500 mb-6">Sign in with the invited email to accept it.</p>
            <button
              onClick={handleSwitchAccount}
              className="w-full rounded-lg bg-gray-900 text-white py-2.5 text-sm font-medium hover:bg-gray-800"
            >
              Switch account
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-600 mb-6">
              {invitation?.inviterEmail ? (
                <>
                  <strong>{invitation.inviterEmail}</strong> invited you to join{' '}
                </>
              ) : (
                <>You&apos;ve been invited to join </>
              )}
              <strong>{invitation?.organizationName ?? 'an organization'}</strong> on NuraVolt.
            </p>
            {error && <p className="text-sm text-red-600 mb-4">{error}</p>}
            <button
              onClick={handleAccept}
              disabled={accepting}
              className="w-full rounded-lg bg-emerald-600 text-white py-2.5 text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {accepting ? 'Joining…' : 'Accept invitation'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
