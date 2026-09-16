/**
 * Runtime probe for the chat contract tools (arc 11) — the chat-tool files
 * are excluded from scoped tsc (TS2589), so behaviour is verified here.
 *
 * Requires the dev server on localhost:3000 and the seeded plants.
 *
 * Run:
 *   npx tsx scripts/smoke_test_contract_tools.ts
 */

import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '.env' });
loadDotenv({ path: '.env.local' });

import { buildContractTools } from '../src/lib/ai/chat-tools-contracts';
import type { ChatAccessContext, AllowedPlant } from '../src/lib/ai/access-control';

const ORIGIN = process.env.PROBE_ORIGIN ?? 'http://localhost:3000';

const plants: AllowedPlant[] = [
  { id: 'p1', slug: 'region_a-storage', name: 'Region A Storage', asset_type: 'BESS', status: 'OPERATIONAL', capacity_mw: 1, location_name: null, country: 'ES' },
  { id: 'p2', slug: 'ribera', name: 'Ribera Solar Park', asset_type: 'PV', status: 'OPERATIONAL', capacity_mw: 5, location_name: null, country: 'ES' },
] as unknown as AllowedPlant[];

const ctx: ChatAccessContext = {
  userClerkId: 'probe',
  orgClerkId: 'probe-org',
  allowedPlantIds: new Set(['p1', 'p2', 'region_a-storage', 'ribera']),
  plants,
};

async function main() {
  const tools = buildContractTools(ctx, ORIGIN) as Record<
    string,
    { execute: (args: Record<string, unknown>) => Promise<unknown> }
  >;
  let failures = 0;
  const check = (label: string, ok: boolean, extra?: unknown) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 160)}` : ''}`);
    if (!ok) failures++;
  };

  const list = (await tools.listContracts.execute({ plantId: 'region_a-storage' })) as any;
  check('listContracts region_a', list.count >= 1 && list.contracts?.[0]?.type === 'BESS_WARRANTY', {
    count: list.count,
  });

  const listPv = (await tools.listContracts.execute({ plantId: 'ribera' })) as any;
  check('listContracts ribera has PPA', listPv.contracts?.some((c: any) => c.type === 'PPA'), {
    types: listPv.contracts?.map((c: any) => c.type),
  });

  const byType = (await tools.getContract.execute({ plantId: 'ribera', contractType: 'PPA' })) as any;
  check(
    'getContract by type returns confirmed terms',
    byType.terms?.length > 0 && byType.terms.every((t: any) => t.status !== undefined),
    { terms: byType.terms?.length }
  );

  const ambiguous = (await tools.getContract.execute({ plantId: 'region_a-storage', contractType: 'BESS_WARRANTY' })) as any;
  check('getContract ambiguity handled (2 BESS contracts)', ambiguous.error === 'ambiguous_contract' || ambiguous.terms?.length > 0, ambiguous.error ?? 'resolved');

  const wp = (await tools.getWarrantyPosition.execute({ plantId: 'region_a-storage' })) as any;
  check(
    'getWarrantyPosition',
    wp.health_score != null && wp.current_soh_pct != null && wp.provisional === true,
    { health: wp.health_score, soh: wp.current_soh_pct, provisional: wp.provisional }
  );

  const oa = (await tools.getOptimizerAudit.execute({ plantId: 'region_a-storage' })) as any;
  check('getOptimizerAudit', oa.capture_ratio != null && oa.provisional === true, {
    capture: oa.capture_ratio,
    gap: oa.revenue_gap_eur,
  });

  const noBess = (await tools.getWarrantyPosition.execute({ plantId: 'ribera' })) as any;
  check('getWarrantyPosition honest 404 for PV plant', noBess.error === 'no_warranty_dossier', noBess.error);

  const deniedRes = (await tools.listContracts.execute({ plantId: 'not-my-plant' })) as any;
  check('access denied for unknown plant', deniedRes.error === 'plant_not_found_or_no_access');

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll contract-tool probes passed.');
}

main();
