/**
 * SolarEdge monitoring connector contract tests.
 *
 * Drives the real SolarEdgeMonitoringService through its injectable fetch seam
 * against recorded response fixtures — no network, no credentials, always green
 * in CI. The cases live in scripts/test_solaredge_connector.ts (single source of
 * truth, also runnable standalone via `npx tsx`).
 */
import { describe, it } from 'vitest';
import { SOLAREDGE_CASES } from '../../scripts/test_solaredge_connector';

describe('SolarEdge monitoring connector (contract)', () => {
  for (const [name, fn] of SOLAREDGE_CASES) {
    it(name, fn);
  }
});
