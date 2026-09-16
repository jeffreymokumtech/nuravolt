import { describe, expect, it } from 'vitest';
import { DURATION_REFERENCE_HOURS, equivalentMw } from '@/lib/billing/plan';

/**
 * The pricing meter. The load-bearing property is the first test: a PV plant
 * carries no storage MWh, so its billed size must stay exactly its rated MW.
 * If that ever breaks, every existing customer's bill moves.
 */
describe('equivalentMw', () => {
  it('returns rated MW when a plant declares no storage energy', () => {
    expect(equivalentMw(12.5, null)).toBe(12.5);
    expect(equivalentMw(12.5, undefined)).toBe(12.5);
    expect(equivalentMw(0.1, null)).toBe(0.1);
  });

  it('prices a 2-hour battery on its power, not its energy', () => {
    // 50 MW / 100 MWh: 100 / 4 = 25, which is below the 50 MW rating.
    expect(equivalentMw(50, 100)).toBe(50);
  });

  it('prices a 4-hour battery identically on either basis', () => {
    expect(equivalentMw(50, 50 * DURATION_REFERENCE_HOURS)).toBe(50);
  });

  it('prices an 8-hour battery on its energy', () => {
    // 50 MW / 400 MWh: 400 / 4 = 100, four times the racks of a 2-hour asset.
    expect(equivalentMw(50, 400)).toBe(100);
  });

  it('treats zero, negative and non-finite inputs as zero', () => {
    expect(equivalentMw(0, 0)).toBe(0);
    expect(equivalentMw(0, null)).toBe(0);
    expect(equivalentMw(-5, null)).toBe(0);
    expect(equivalentMw(10, -400)).toBe(10);
    expect(equivalentMw(-5, -400)).toBe(0);
    expect(equivalentMw(Number.NaN, 40)).toBe(10);
    expect(equivalentMw(10, Number.NaN)).toBe(10);
  });

  it('accepts a Decimal-like energy value from Prisma', () => {
    // Prisma returns Decimal instances; Number() is applied internally.
    const decimalish = { toString: () => '400', valueOf: () => '400' } as unknown as number;
    expect(equivalentMw(50, decimalish)).toBe(100);
  });
});
