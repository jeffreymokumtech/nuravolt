/**
 * Canonical BESS device_ext_id contract.
 *
 * The builder and the parser are the single definition of the battery grain
 * convention (cloud-connector.ts) — the connectors, the lakehouse writers and
 * the drill-down route all key off it, so a round-trip failure at any grain
 * would silently orphan telemetry. No network, no fixtures needed.
 */
import { describe, it, expect } from 'vitest';
import {
  BESS_DEVICE_ID_PREFIX,
  PLANT_ROLLUP_DEVICE_ID,
  buildBessDeviceId,
  isBessDeviceId,
  parseBessDeviceId,
  sanitizeBessAssetToken,
} from '../../src/lib/services/cloud-connector';
import type { BessDeviceGrain, BessDeviceIdParts } from '../../src/lib/services/cloud-connector';

const CASES: Array<{ grain: BessDeviceGrain; parts: BessDeviceIdParts; id: string }> = [
  { grain: 'asset', parts: { asset: 'athi-1' }, id: 'BESS athi-1' },
  { grain: 'unit', parts: { asset: 'athi-1', unit: 2 }, id: 'BESS athi-1.U-2' },
  { grain: 'rack', parts: { asset: 'athi-1', unit: 2, rack: 7 }, id: 'BESS athi-1.U-2.R-7' },
  {
    grain: 'module',
    parts: { asset: 'athi-1', unit: 2, rack: 7, module: 13 },
    id: 'BESS athi-1.U-2.R-7.M-13',
  },
  {
    grain: 'cell',
    parts: { asset: 'athi-1', unit: 2, rack: 7, module: 13, cell: 208 },
    id: 'BESS athi-1.U-2.R-7.M-13.C-208',
  },
];

describe('canonical BESS device_ext_id', () => {
  it('builds the documented id at every grain', () => {
    for (const testCase of CASES) {
      expect(buildBessDeviceId(testCase.parts)).toBe(testCase.id);
    }
  });

  it('round-trips build then parse at every grain', () => {
    for (const testCase of CASES) {
      const id = buildBessDeviceId(testCase.parts);
      const parsed = parseBessDeviceId(id);
      expect(parsed).not.toBeNull();
      expect(parsed!.grain).toBe(testCase.grain);
      expect(parsed!.asset).toBe(testCase.parts.asset);
      expect(parsed!.unit).toBe(testCase.parts.unit);
      expect(parsed!.rack).toBe(testCase.parts.rack);
      expect(parsed!.module).toBe(testCase.parts.module);
      expect(parsed!.cell).toBe(testCase.parts.cell);
      // parse then build must land on the identical string
      expect(buildBessDeviceId(parsed!)).toBe(id);
    }
  });

  it('round-trips parse then build for hand-written ids', () => {
    for (const testCase of CASES) {
      const parsed = parseBessDeviceId(testCase.id);
      expect(parsed).not.toBeNull();
      expect(buildBessDeviceId(parsed!)).toBe(testCase.id);
      expect(parsed!.device_ext_id).toBe(testCase.id);
    }
  });

  it('accepts asset tokens containing spaces and digits', () => {
    const id = buildBessDeviceId({ asset: 'Athi Storage 01', unit: 1, rack: 3 });
    expect(id).toBe('BESS Athi Storage 01.U-1.R-3');
    expect(parseBessDeviceId(id)?.asset).toBe('Athi Storage 01');
  });

  it('uses index 0 rather than treating it as absent', () => {
    const id = buildBessDeviceId({ asset: 'athi-1', unit: 0 });
    expect(id).toBe('BESS athi-1.U-0');
    const parsed = parseBessDeviceId(id);
    expect(parsed?.grain).toBe('unit');
    expect(parsed?.unit).toBe(0);
  });

  it('rejects hierarchy gaps at build time', () => {
    expect(() => buildBessDeviceId({ asset: 'athi-1', rack: 3 })).toThrow();
    expect(() => buildBessDeviceId({ asset: 'athi-1', unit: 1, module: 2 })).toThrow();
    expect(() => buildBessDeviceId({ asset: 'athi-1', unit: 1, rack: 1, cell: 4 })).toThrow();
  });

  it('rejects non-integer and negative indices', () => {
    expect(() => buildBessDeviceId({ asset: 'athi-1', unit: 1.5 })).toThrow();
    expect(() => buildBessDeviceId({ asset: 'athi-1', unit: -1 })).toThrow();
  });

  it('rejects an empty asset token', () => {
    expect(() => buildBessDeviceId({ asset: '' })).toThrow();
    expect(() => buildBessDeviceId({ asset: '   ' })).toThrow();
  });

  it('keeps PLANT reserved for plant-grain rollups', () => {
    expect(() => buildBessDeviceId({ asset: PLANT_ROLLUP_DEVICE_ID })).toThrow();
    expect(parseBessDeviceId(PLANT_ROLLUP_DEVICE_ID)).toBeNull();
    expect(parseBessDeviceId(`${BESS_DEVICE_ID_PREFIX}${PLANT_ROLLUP_DEVICE_ID}`)).toBeNull();
  });

  it('does not claim PV ids or malformed ids as BESS ids', () => {
    const notBess = [
      'INV 01.032',
      'INV 01.032.MPPT-1',
      'INV 01.032.MPPT-1.STR-2',
      'PLANT',
      'BESS',
      'BESS ',
      'BESS athi-1.R-3',
      'BESS athi-1.U-2.M-1',
      'BESS athi-1.U-x',
      'bess athi-1',
      '',
    ];
    for (const id of notBess) {
      expect(isBessDeviceId(id)).toBe(false);
    }
  });

  it('sanitizes vendor labels into usable asset tokens', () => {
    // '.' is the grain separator, so it can never survive into a token.
    expect(sanitizeBessAssetToken('ESS.01')).toBe('ESS-01');
    expect(sanitizeBessAssetToken('  Athi   Storage  ')).toBe('Athi Storage');
    expect(sanitizeBessAssetToken('')).toBe('');
    const id = buildBessDeviceId({ asset: sanitizeBessAssetToken('ESS.01'), unit: 1 });
    expect(parseBessDeviceId(id)?.asset).toBe('ESS-01');
  });

  it('keeps cell identity in the id, not in a metric name', () => {
    // Guard for the taxonomy: a per-cell id must parse to a cell grain so no
    // caller is ever tempted to encode the cell index into the metric.
    const parsed = parseBessDeviceId('BESS athi-1.U-1.R-2.M-3.C-44');
    expect(parsed?.grain).toBe('cell');
    expect(parsed?.cell).toBe(44);
  });
});
