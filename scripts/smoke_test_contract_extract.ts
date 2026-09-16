/**
 * Smoke test for the TS contract-term extractor (arc 11).
 *
 * Parses a text-based PDF, runs the closed-schema Bedrock extraction, and
 * asserts: only vocabulary fields come back, numeric values are within
 * bounds, and every non-null source excerpt is a verbatim substring of the
 * parsed text (the fabrication guard).
 *
 * Run:
 *   npx tsx scripts/smoke_test_contract_extract.ts <path-to-contract.pdf> [PPA|MODULE_WARRANTY|...]
 */

import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '.env' });
loadDotenv({ path: '.env.local' });

import fs from 'fs';
import { parseFile } from '../src/lib/ai/kb-ingest';
import { extractContractTerms } from '../src/lib/ai/contract-extract';
import { CONTRACT_TERM_FIELDS, isWithinBounds, termFieldDef } from '../src/lib/contracts/term-fields';
import type { ContractType } from '@prisma/client';

async function main() {
  const pdfPath = process.argv[2];
  const contractType = (process.argv[3] ?? 'PPA') as ContractType;
  if (!pdfPath || !CONTRACT_TERM_FIELDS[contractType]) {
    console.error('Usage: npx tsx scripts/smoke_test_contract_extract.ts <contract.pdf> [type]');
    process.exit(1);
  }

  const buffer = fs.readFileSync(pdfPath);
  const text = await parseFile(buffer, 'pdf');
  console.log(`parsed ${text.length} chars of text`);

  const result = await extractContractTerms(text, contractType);
  console.log(`model: ${result.model_id}`);
  console.log(`counterparty: ${result.counterparty}`);
  console.log(`effective: ${result.effective_from} -> ${result.effective_to}`);
  console.log(`terms: ${result.terms.length}, rejected: ${result.rejected_count}`);

  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const doc = normalize(text);
  let failures = 0;

  for (const t of result.terms) {
    const def = termFieldDef(contractType, t.field);
    const value = t.value_numeric ?? t.value_text;
    const line = `  ${t.field} = ${value} ${t.unit ?? ''} (conf ${t.confidence}, explicit ${t.is_explicit})`;
    if (!def) {
      console.error(`FAIL out-of-vocabulary field:${line}`);
      failures++;
      continue;
    }
    if (def.kind === 'numeric' && (t.value_numeric == null || !isWithinBounds(def, t.value_numeric))) {
      console.error(`FAIL out-of-bounds:${line}`);
      failures++;
      continue;
    }
    if (t.source_excerpt && !doc.includes(normalize(t.source_excerpt))) {
      console.error(`FAIL non-verbatim excerpt:${line}\n    excerpt: ${t.source_excerpt}`);
      failures++;
      continue;
    }
    console.log(`ok${line}`);
    if (t.source_excerpt) console.log(`      "${t.source_excerpt.slice(0, 100)}..."`);
  }

  if (failures) {
    console.error(`\n${failures} assertion failure(s)`);
    process.exit(1);
  }
  console.log('\nAll extraction guards held.');
}

main();
