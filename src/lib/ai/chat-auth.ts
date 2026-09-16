/**
 * Resolves the current Better Auth user/org for chat-related routes, with a
 * dev-mode fallback so the local demo environment keeps working without a
 * session. orgId is the session's active organization (Better Auth
 * organization plugin), which legacy tables store in their org_clerk_id
 * columns.
 */

import { headers } from 'next/headers';
import { auth } from '@/lib/auth';

const DEMO_USER_ID = 'demo_user';
const DEMO_ORG_ID = 'demo_org_alpha1';

export async function getChatIds(): Promise<{
  userId: string | null;
  orgId: string | null;
}> {
  const isDev = process.env.NODE_ENV === 'development';

  try {
    const session = await auth.api.getSession({ headers: headers() });
    return {
      userId: session?.user.id ?? (isDev ? DEMO_USER_ID : null),
      orgId:
        session?.session.activeOrganizationId ?? (isDev ? DEMO_ORG_ID : null),
    };
  } catch (e) {
    if (isDev) {
      return { userId: DEMO_USER_ID, orgId: DEMO_ORG_ID };
    }
    return { userId: null, orgId: null };
  }
}
