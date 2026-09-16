/**
 * Local demo identity: a Better Auth user + credential account, the demo
 * organisation, membership, the legacy Organization/UserRole mirror, and one
 * MCP API key for the agent service.
 *
 * The organisation id is literally `demo_org_alpha1`: every plan/budget gate in
 * the app treats `demo_`-prefixed org ids as enterprise (src/lib/billing/
 * plan.ts, gate.ts, llm-budget.ts), so the seeded org can use every feature
 * with no Stripe. Idempotent: re-running updates in place.
 *
 * Refuses to run in production. Credentials are documented in the README.
 *
 *   npx tsx prisma/seed-demo-account.ts
 *   DEMO_EMAIL=... DEMO_PASSWORD=... npx tsx prisma/seed-demo-account.ts
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from 'better-auth/crypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashKey } from '../src/lib/mcp/keys';
import { FULL_AGENT_SCOPES } from '../src/lib/mcp/scopes';

const prisma = new PrismaClient();

export const DEMO_ORG_ID = 'demo_org_alpha1';
export const DEMO_USER_ID = 'demo_user';
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@nuravolt.local';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'nuravolt-demo';
const DEMO_ORG_NAME = 'NuraVolt Demo';

/**
 * Deterministic agent key: derived from BETTER_AUTH_SECRET so a rebuilt
 * database yields the same token and .env.docker keeps working. Keys are
 * stored as an unsalted sha256 (src/lib/mcp/keys.ts), which is what makes
 * this reproducible.
 */
export function deriveAgentKey(secret: string): string {
  const digest = crypto.createHash('sha256').update(`${secret}:agent-demo-key`).digest('base64url');
  return `nv_test_${digest.slice(0, 32)}`;
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-demo-account refuses to run with NODE_ENV=production');
  }
  const now = new Date();

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: { name: 'Demo Operator', emailVerified: true, banned: false },
    create: { id: DEMO_USER_ID, name: 'Demo Operator', email: DEMO_EMAIL, emailVerified: true, role: 'user' },
  });

  const password = await hashPassword(DEMO_PASSWORD);
  const existingAccount = await prisma.account.findFirst({
    where: { userId: user.id, providerId: 'credential' },
  });
  if (existingAccount) {
    await prisma.account.update({ where: { id: existingAccount.id }, data: { password, updatedAt: now } });
  } else {
    await prisma.account.create({
      data: { id: crypto.randomUUID(), accountId: user.id, providerId: 'credential', userId: user.id, password },
    });
  }

  // Slug equals the id so it can never collide with an org created through
  // the sign-up UI (slugs are unique).
  await prisma.authOrganization.upsert({
    where: { id: DEMO_ORG_ID },
    update: { name: DEMO_ORG_NAME },
    create: { id: DEMO_ORG_ID, name: DEMO_ORG_NAME, slug: DEMO_ORG_ID.replace(/_/g, '-') },
  });
  await prisma.member.upsert({
    where: { organizationId_userId: { organizationId: DEMO_ORG_ID, userId: user.id } },
    update: { role: 'owner' },
    create: { id: crypto.randomUUID(), organizationId: DEMO_ORG_ID, userId: user.id, role: 'owner' },
  });

  // Legacy mirror rows the rest of the app keys on.
  await prisma.organization.upsert({
    where: { clerk_org_id: DEMO_ORG_ID },
    update: { name: DEMO_ORG_NAME, plan_type: 'enterprise' },
    create: { clerk_org_id: DEMO_ORG_ID, name: DEMO_ORG_NAME, plan_type: 'enterprise', max_plants: 25, max_users: 25 },
  });
  await prisma.userRole.upsert({
    where: { user_clerk_id_org_clerk_id: { user_clerk_id: user.id, org_clerk_id: DEMO_ORG_ID } },
    update: { role: 'ORG_ADMIN' },
    create: { user_clerk_id: user.id, org_clerk_id: DEMO_ORG_ID, role: 'ORG_ADMIN' },
  });

  // Agent API key (full agent scopes; mint a read-only one if writes must be
  // impossible server-side for a given demo).
  const secret = process.env.BETTER_AUTH_SECRET || 'local-dev-secret';
  const raw = deriveAgentKey(secret);
  const hashed = hashKey(raw);
  const existingKey = await prisma.apiKey.findFirst({ where: { hashed_key: hashed } });
  if (!existingKey) {
    await prisma.apiKey.create({
      data: {
        org_clerk_id: DEMO_ORG_ID,
        hashed_key: hashed,
        key_prefix: raw.slice(0, 14),
        name: 'agent-demo',
        scopes: FULL_AGENT_SCOPES,
        created_by: user.id,
      },
    });
  }

  // Hand the token to the agent container: append/replace in .env.docker.
  const envFile = process.env.AGENT_KEY_ENV_FILE || path.join(process.cwd(), '.env.docker');
  if (fs.existsSync(path.dirname(envFile))) {
    const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n') : [];
    const lines = existing.filter((l) => !l.startsWith('AGENT_MCP_API_KEY=') && !l.startsWith('DEMO_USER_ID='));
    lines.push(`AGENT_MCP_API_KEY=${raw}`, `DEMO_USER_ID=${user.id}`);
    fs.writeFileSync(envFile, lines.join('\n').replace(/\n+$/, '') + '\n');
  }

  console.log(`demo user   ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`demo org    ${DEMO_ORG_ID} (${DEMO_ORG_NAME}, enterprise entitlements)`);
  console.log(`agent key   ${raw}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
