/**
 * Huawei FusionSolar connector contract tests.
 *
 * Drives the real HuaweiFusionSolarService through its injectable fetch seam
 * against recorded response fixtures — no network, no credentials, always green
 * in CI. The cases live in scripts/test_huawei_connector.ts (single source of
 * truth, also runnable standalone via `npx tsx`).
 */
import { describe, it } from 'vitest';
import { HUAWEI_CASES } from '../../scripts/test_huawei_connector';

describe('Huawei FusionSolar connector (contract)', () => {
  for (const [name, fn] of HUAWEI_CASES) {
    it(name, fn);
  }
});
