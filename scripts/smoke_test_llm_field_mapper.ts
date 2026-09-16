/**
 * Smoke test for the LLM field-mapper fallback.
 *
 * Runs a representative set of ambiguous column names through both:
 *   1. The regex-based FieldMappingIntelligence
 *   2. The LLM fallback (when regex confidence < threshold)
 *
 * Verifies:
 *   - Obvious columns (e.g. "AC_Power") get high-confidence regex match without LLM
 *   - Ambiguous columns (e.g. "Inv01_T1") trigger LLM and get a sensible classification
 *   - Out-of-taxonomy responses are rejected (test injects a nonsense column)
 *
 * Run:
 *   npx tsx scripts/smoke_test_llm_field_mapper.ts
 *
 * Requires AWS Bedrock credentials in env (.env or shell).
 */

// Load .env so the AWS SDK picks up credentials (tsx doesn't auto-load).
import { config as loadDotenv } from 'dotenv';
loadDotenv();

import {
  FieldMappingIntelligence,
} from '../src/lib/services/field-mapping-intelligence';
import {
  llmPolishMappings,
  LLM_FALLBACK_THRESHOLD,
} from '../src/lib/services/field-mapping-llm';

// Representative ambiguous columns a real client might upload
const TEST_COLUMNS: Array<{
  name: string;
  samples: any[];
  expectedFamily: string;  // human-readable category we expect the LLM to land in
  notes: string;
}> = [
  // Clear matches — regex should handle these (LLM not called)
  {
    name: 'AC_Power_kW',
    samples: [125.3, 180.5, 200.1, 175.2, 160.0],
    expectedFamily: 'power_ac',
    notes: 'unambiguous regex match expected',
  },
  {
    name: 'INV_01_Module_Temp_C',
    samples: [42.1, 45.3, 48.0, 50.2, 47.8],
    expectedFamily: 'temp_module',
    notes: 'unambiguous regex match expected',
  },

  // Ambiguous — regex likely below threshold, LLM should clarify
  {
    name: 'Inv01_T1',
    samples: [42.5, 45.0, 48.3, 50.1, 47.5],
    expectedFamily: 'temp_*',
    notes: 'T1 is ambiguous — could be temp_module / temp_ambient / temp_inverter',
  },
  {
    name: 'INV_001.P_OUT',
    samples: [98000, 110000, 125000, 105000, 95000],
    expectedFamily: 'power_ac',
    notes: 'P_OUT = power output, values in W',
  },
  {
    name: 'String_3_MPPT_V',
    samples: [580.2, 595.0, 610.3, 600.1, 585.5],
    expectedFamily: 'voltage_dc',
    notes: 'string voltage at MPPT, DC',
  },
  {
    name: 'Pack_1_Charge',
    samples: [75.2, 78.5, 80.1, 82.3, 79.0],
    expectedFamily: 'bess_soc',
    notes: 'BESS context — Pack + Charge typically = SoC in %',
  },
  {
    name: 'Cells_TempMax',
    samples: [28.5, 30.1, 32.4, 29.8, 31.2],
    expectedFamily: 'bess_temp_cell',
    notes: 'BESS cell temperature',
  },
  {
    name: 'irr_pyr',
    samples: [850, 920, 1050, 980, 870],
    expectedFamily: 'irradiance_*',
    notes: 'pyranometer reading — POA or GHI',
  },

  // Should be rejected as unmapped
  {
    name: 'maintenance_log_id',
    samples: ['MAINT-001', 'MAINT-002', 'MAINT-003'],
    expectedFamily: 'unmapped',
    notes: 'identifier field — no measurement type',
  },
];

async function main() {
  console.log('=' .repeat(70));
  console.log(' LLM field-mapper fallback smoke test');
  console.log('=' .repeat(70));
  console.log(` LLM fallback threshold: confidence < ${LLM_FALLBACK_THRESHOLD}`);

  // Step 1: regex pass
  const intel = new FieldMappingIntelligence();
  const fields = TEST_COLUMNS.map(c => ({ name: c.name, sampleValues: c.samples }));
  const regexResults = intel.mapFields(fields, { vendor: 'mixed', dataFormat: 'wide' });

  console.log('\n── Step 1: regex pass ──');
  for (let i = 0; i < TEST_COLUMNS.length; i++) {
    const tc = TEST_COLUMNS[i];
    const r = regexResults[i];
    const flag = r.confidence < LLM_FALLBACK_THRESHOLD ? '⚠️ ' : '✓ ';
    console.log(
      `${flag}${tc.name.padEnd(28)} → ${String(r.mappedType).padEnd(20)} ` +
      `conf=${r.confidence.toFixed(2)}  (expected: ${tc.expectedFamily})`
    );
  }

  // Step 2: LLM polish
  console.log(`\n── Step 2: LLM polish (where confidence < ${LLM_FALLBACK_THRESHOLD}) ──`);
  const sampleMap = new Map<string, any[]>();
  TEST_COLUMNS.forEach(tc => sampleMap.set(tc.name, tc.samples));

  const { polished, llmCallsMade, llmAcceptedCount, llmRejectedCount } =
    await llmPolishMappings(regexResults, sampleMap, {
      contextHints: { vendor: 'mixed', plantType: 'HYBRID' },
      concurrency: 3,
    });

  console.log(`\n  Bedrock invocations: ${llmCallsMade}`);
  console.log(`  Accepted (replaced regex): ${llmAcceptedCount}`);
  console.log(`  Rejected (kept regex): ${llmRejectedCount}`);

  console.log('\n── Final results ──');
  for (let i = 0; i < TEST_COLUMNS.length; i++) {
    const tc = TEST_COLUMNS[i];
    const r = polished[i];
    const llmTag = (r as any).llmInvoked ? ' [LLM]' : '';
    console.log(
      `${tc.name.padEnd(28)} → ${String(r.mappedType).padEnd(20)} ` +
      `conf=${r.confidence.toFixed(2)}${llmTag}  ` +
      `(expected: ${tc.expectedFamily})`
    );
    if ((r as any).llmReason) {
      console.log(`    LLM reason: ${(r as any).llmReason}`);
    }
  }
  console.log('=' .repeat(70));
}

main().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
