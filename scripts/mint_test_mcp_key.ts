/**
 * Mint a development MCP API key for local testing.
 *
 *   npx tsx scripts/mint_test_mcp_key.ts
 *
 * Prints the raw token once. Hashed token is stored in the DB.
 */
import prisma from '../src/libs/prisma';
import { mintKey } from '../src/lib/mcp/keys';
import { FULL_AGENT_SCOPES } from '../src/lib/mcp/scopes';

async function main() {
  const orgClerkId = process.env.MCP_TEST_ORG_ID ?? 'demo_org_alpha1';
  const createdBy = process.env.MCP_TEST_USER_ID ?? 'demo_user';
  const name = process.argv[2] ?? 'Local dev key';

  const minted = mintKey();
  const row = await prisma.apiKey.create({
    data: {
      org_clerk_id: orgClerkId,
      hashed_key: minted.hashed,
      key_prefix: minted.prefix,
      name,
      scopes: FULL_AGENT_SCOPES,
      created_by: createdBy,
    },
  });

  // eslint-disable-next-line no-console
  console.log('\n  Minted MCP API key');
  // eslint-disable-next-line no-console
  console.log('  ─────────────────────────────────────────────');
  // eslint-disable-next-line no-console
  console.log(`  id:      ${row.id}`);
  // eslint-disable-next-line no-console
  console.log(`  org:     ${row.org_clerk_id}`);
  // eslint-disable-next-line no-console
  console.log(`  name:    ${row.name}`);
  // eslint-disable-next-line no-console
  console.log(`  scopes:  ${row.scopes.join(', ')}`);
  // eslint-disable-next-line no-console
  console.log(`\n  token:   ${minted.raw}`);
  // eslint-disable-next-line no-console
  console.log('\n  Save this — it will not be shown again.\n');

  await prisma.$disconnect();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
