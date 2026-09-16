'use client';

import { createAuthClient } from 'better-auth/react';
import { organizationClient, magicLinkClient, adminClient } from 'better-auth/client/plugins';

/**
 * Better Auth browser client. Base URL defaults to the current origin, so no
 * env wiring is needed for previews.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient(), magicLinkClient(), adminClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
