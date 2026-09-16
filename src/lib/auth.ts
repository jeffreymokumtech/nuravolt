import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { organization, magicLink, mcp, bearer, admin } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { expo } from '@better-auth/expo';
import { getResend } from '@/libs/resend-client';
import prisma from '@/libs/prisma';
import { ALL_SCOPES } from '@/lib/mcp/scopes';
import { getOrgBilling } from '@/lib/billing/plan';
import { syncMemberRole, removeMemberAuthz, AUTH_ROLE_LABELS } from '@/lib/auth/role-map';

const baseURL =
  process.env.BETTER_AUTH_URL ??
  process.env.NEXT_PUBLIC_SITE_URL ??
  'http://localhost:3000';


/**
 * Better Auth server instance.
 *
 * - Core tables live in Prisma as User/Session/Account/Verification.
 * - The organization plugin's table is mapped to AuthOrganization because the
 *   legacy `Organization` model (plan limits, plant relations) already exists.
 *   On org creation we mirror a legacy Organization row (clerk_org_id column
 *   holds the Better Auth org id — it's an opaque external-id string) and a
 *   UserRole row so the existing permission system keeps working unchanged.
 * - Google is only enabled when GOOGLE_CLIENT_ID is set, so local dev without
 *   OAuth credentials still boots with email/password + magic link.
 */
export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  // 'nuravolt://' is the Expo mobile app's deep-link scheme.
  trustedOrigins: [baseURL, 'http://localhost:3000', 'nuravolt://'],
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
  },
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // re-validate against the DB every 5 minutes
    },
  },
  databaseHooks: {
    session: {
      create: {
        // Sessions carry the active org so server code can resolve
        // { userId, orgId } in one lookup (mirrors Clerk's auth() shape).
        before: async (session) => {
          const member = await prisma.member.findFirst({
            where: { userId: session.userId },
            orderBy: { createdAt: 'asc' },
          });
          return {
            data: {
              ...session,
              // Respect an explicitly provided org (defensive — plugins may
              // pre-set it); otherwise pin to the oldest membership.
              activeOrganizationId:
                (session as any).activeOrganizationId ?? member?.organizationId ?? null,
            },
          };
        },
      },
    },
  },
  plugins: [
    // Mobile: Expo deep-link handling + Authorization: Bearer session tokens
    // (the React Native app can't rely on cookies).
    expo(),
    bearer(),
    // Platform admin (founder): impersonation + user management. Access is
    // granted by setting User.role='admin' by hand (never through the app);
    // the /admin UI additionally checks the PLATFORM_ADMIN_EMAILS allow-list.
    admin({ impersonationSessionDuration: 60 * 60 }),
    organization({
      schema: {
        organization: { modelName: 'authOrganization' },
      },
      // Seat cap enforced when members are added/accepted — resolved from the
      // org's plan (residential 1, business 10, enterprise unlimited).
      membershipLimit: async (_user, org) => {
        const { limits } = await getOrgBilling(org.id);
        return Number.isFinite(limits.seats) ? limits.seats : 100000;
      },
      // Invitation emails via Resend (same pattern as sendMagicLink below).
      sendInvitationEmail: async ({ id, email, role, organization: org, inviter }) => {
        const roleLabel = AUTH_ROLE_LABELS[role] ?? role;
        const inviterEmail = inviter?.user?.email ?? 'a teammate';
        await getResend()?.emails.send({
          from: 'NuraVolt <noreply@nuravolt.com>',
          to: email,
          subject: `You've been invited to ${org.name} on NuraVolt`,
          html: `
            <p>${inviterEmail} invited you to join <strong>${org.name}</strong> on NuraVolt as ${roleLabel}.</p>
            <p><a href="${baseURL}/accept-invitation/${id}">Accept invitation</a></p>
            <p>This invitation expires in 48 hours. If you weren't expecting it, you can ignore this email.</p>
          `,
        });
      },
      organizationHooks: {
        afterCreateOrganization: async ({ organization: org, user }) => {
          // Mirror into the legacy multi-tenant tables. clerk_org_id /
          // user_clerk_id are opaque external-id columns — they now hold
          // Better Auth ids.
          await prisma.organization.upsert({
            where: { clerk_org_id: org.id },
            update: { name: org.name },
            create: {
              clerk_org_id: org.id,
              name: org.name,
              plan_type: 'free',
              max_plants: 5,
              max_users: 5,
            },
          });
          await prisma.userRole.upsert({
            where: {
              user_clerk_id_org_clerk_id: {
                user_clerk_id: user.id,
                org_clerk_id: org.id,
              },
            },
            update: { role: 'ORG_ADMIN' },
            create: {
              user_clerk_id: user.id,
              org_clerk_id: org.id,
              role: 'ORG_ADMIN',
            },
          });
          // Seed the LLM budget at the entry-tier caps ($1/day, $10/month —
          // plan.ts PLAN_LLM_BUDGETS); the Stripe webhook raises them when a
          // higher plan is purchased.
          await prisma.orgLLMBudget
            .upsert({
              where: { org_clerk_id: org.id },
              update: {},
              create: {
                org_clerk_id: org.id,
                daily_cap_usd: 1,
                monthly_cap_usd: 10,
                alert_email: user.email ?? null,
              },
            })
            .catch(() => {});
        },
        // Mirror org renames into the legacy Organization row (its `name` is
        // what tenancy-aware surfaces render).
        afterUpdateOrganization: async ({ organization: org }) => {
          if (!org?.name) return;
          await prisma.organization
            .updateMany({
              where: { clerk_org_id: org.id },
              data: { name: org.name },
            })
            .catch((err) =>
              console.error('[auth] afterUpdateOrganization mirror failed:', err)
            );
        },
        // Keep the legacy UserRole/PlantAccess tables (the authz source of
        // truth for every API route) in sync with Better Auth membership.
        // Best-effort: a sync failure must never 500 the auth flow — the
        // /api/team/members endpoint lazy-heals missing rows.
        afterAddMember: async ({ member, user, organization: org }) => {
          await syncMemberRole(user.id, org.id, member.role).catch((err) =>
            console.error('[auth] afterAddMember role sync failed:', err)
          );
        },
        afterAcceptInvitation: async ({ member, user, organization: org }) => {
          await syncMemberRole(user.id, org.id, member.role).catch((err) =>
            console.error('[auth] afterAcceptInvitation role sync failed:', err)
          );
        },
        afterUpdateMemberRole: async ({ member, user, organization: org }) => {
          await syncMemberRole(user.id, org.id, member.role).catch((err) =>
            console.error('[auth] afterUpdateMemberRole role sync failed:', err)
          );
        },
        afterRemoveMember: async ({ user, organization: org }) => {
          await removeMemberAuthz(user.id, org.id).catch((err) =>
            console.error('[auth] afterRemoveMember authz cleanup failed:', err)
          );
        },
        // Block invites past the seat limit with a clear upgrade message
        // (membershipLimit above is the backstop at accept time).
        beforeCreateInvitation: async ({ organization: org }) => {
          const { limits } = await getOrgBilling(org.id);
          if (!Number.isFinite(limits.seats)) return;
          const [members, pending] = await Promise.all([
            prisma.member.count({ where: { organizationId: org.id } }),
            prisma.invitation.count({
              where: { organizationId: org.id, status: 'pending' },
            }),
          ]);
          if (members + pending >= limits.seats) {
            throw new APIError('FORBIDDEN', {
              message: `Your plan includes ${limits.seats} seat${limits.seats === 1 ? '' : 's'}. Upgrade to invite more teammates.`,
            });
          }
        },
      },
    }),
    // OAuth provider for MCP clients (Claude Desktop and friends): discovery
    // via /.well-known/oauth-authorization-server, RFC 7591 dynamic client
    // registration, sign-in through the normal /sign-in page. Enterprise-only
    // enforcement happens at MCP request time (src/lib/mcp/auth.ts).
    mcp({
      loginPage: '/sign-in',
      oidcConfig: {
        loginPage: '/sign-in',
        allowDynamicClientRegistration: true,
        scopes: ['openid', 'profile', 'email', 'offline_access', ...ALL_SCOPES],
      },
    }),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await getResend()?.emails.send({
          from: 'NuraVolt <noreply@nuravolt.com>',
          to: email,
          subject: 'Your NuraVolt sign-in link',
          html: `
            <p>Click the link below to sign in to NuraVolt:</p>
            <p><a href="${url}">Sign in to NuraVolt</a></p>
            <p>This link expires in 5 minutes. If you didn't request it, you can ignore this email.</p>
          `,
        });
      },
    }),
    // Must stay last: makes server actions set auth cookies correctly.
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
