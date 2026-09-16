'use client';

import { Info, TrendingDown } from 'lucide-react';
import OpsPanel from '@/components/ops/OpsPanel';
import {
  computeResidualValue,
  TIER_LABEL,
  RESIDUAL_VALUE_NOTES,
  type SecondLifeTier,
} from '@/lib/bess/residualValue';

/**
 * Residual value panel. Projects asset value at the operational milestones
 * that actually differ for this asset, and quantifies the value drop between
 * today and the capacity floor.
 *
 * Two things this panel is careful about.
 *
 * The warranty floor and the second-life threshold are different concepts: the
 * first is a clause in a supply contract, the second is a market convention
 * for when a pack leaves first-life service. On most LFP contracts they are
 * both 70% state of health, at which point printing them as two rows with the
 * same state of health and the same euro figure reads as a rendering bug. They
 * are merged into one milestone whenever they coincide, and named separately
 * when they do not.
 *
 * Every euro figure is a multiple of the installed-cost basis, so the panel
 * renders the multiplier next to each row. Without it "today €1.82M" against a
 * basis of "10,000 kWh × €280/kWh" (€2.80M new) is an unexplained 35% gap.
 */

interface BatteryResidualValueProps {
  currentSoh: number;
  /**
   * Capacity guarantee floor, or null when no warranty terms are on file. Null
   * drops the floor milestone and the value-drop strip rather than projecting
   * against an assumed floor: "value at the warranty floor" is a statement
   * about this asset's contract, not about the industry.
   */
  warrantyFloor: number | null;
  /**
   * Where `warrantyFloor` came from. Anything other than 'contract' means the
   * floor is a stand-in, and the row says so rather than implying a clause
   * nobody has uploaded.
   */
  warrantyFloorSource?: FloorSource;
  installValueEur: number;
  /** How `installValueEur` was arrived at, e.g. "10,000 kWh × €280/kWh". */
  installValueSource?: string;
  /**
   * State of health at which a pack is generally considered to leave
   * first-life service. An industry reference point, not a clause.
   */
  secondLifeFloor?: number;
}

const TIER_TONE: Record<SecondLifeTier, 'ok' | 'warn' | 'alarm' | 'muted'> = {
  used_good: 'ok',
  used_fair: 'warn',
  second_life: 'warn',
  scrap: 'alarm',
};

const TONE_VAR = {
  ok: 'var(--ops-ok)',
  warn: 'var(--ops-warn)',
  alarm: 'var(--ops-alarm)',
  muted: 'var(--ops-muted)',
};

/**
 * Euro amount at a readable magnitude, sign carried on the outside of the
 * currency symbol.
 *
 * The bug this replaces: the magnitude branches were `v >= 1_000_000` and
 * `v >= 1_000`, so any negative amount fell through both and printed raw. The
 * value-drop strip rendered "€-1204000" beside rows reading "€1.82M".
 */
export function formatEur(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  const sign = v < 0 ? '−' : '';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}€${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 100_000) return `${sign}€${(abs / 1_000).toFixed(0)}k`;
  if (abs >= 1_000) return `${sign}€${(abs / 1_000).toFixed(1)}k`;
  return `${sign}€${abs.toFixed(0)}`;
}

/** Whole-percent render sharing the minus sign with `formatEur`. */
export function formatPct(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  return `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)}%`;
}

/**
 * Where the capacity floor came from. `unknown` is a real state, not a
 * fallback for `default`: a payload that carries no provenance is not evidence
 * that the clause was defaulted, and it is certainly not evidence that it was
 * contractual.
 */
export type FloorSource = 'contract' | 'declared' | 'default' | 'unknown';

export const FLOOR_LABEL: Record<FloorSource, string> = {
  contract: 'contractual capacity guarantee',
  declared: 'operator declared capacity floor',
  default: 'chemistry default capacity floor, no contract on file',
  unknown: 'capacity floor, source not recorded',
};

export interface ResidualMilestone {
  /** Stable key, also the row heading. */
  label: string;
  /** One line naming what the milestone is and where its floor came from. */
  note: string;
  soh: number;
  valueEur: number;
  /** Fraction of the installed-cost basis, so the euro figure is derivable. */
  multiplier: number;
  tier: SecondLifeTier;
  isToday?: boolean;
}

/**
 * The milestone rows for a given asset.
 *
 * Merges the warranty floor and the second-life threshold into one row when
 * they land on the same state of health, which on a standard LFP contract
 * (70% guarantee) they always do.
 */
export function residualMilestones(opts: {
  currentSoh: number;
  warrantyFloor: number | null;
  secondLifeFloor: number;
  installValueEur: number;
  warrantyFloorSource: FloorSource;
}): ResidualMilestone[] {
  const { currentSoh, warrantyFloor, secondLifeFloor, installValueEur } = opts;
  const row = (label: string, note: string, soh: number): ResidualMilestone => {
    const r = computeResidualValue(soh, installValueEur);
    return {
      label,
      note,
      soh,
      valueEur: r.valueEur,
      multiplier: r.multiplier,
      tier: r.tier,
    };
  };

  const rows: ResidualMilestone[] = [
    { ...row('Today', 'measured state of health', currentSoh), isToday: true },
  ];

  const floorNote = FLOOR_LABEL[opts.warrantyFloorSource];
  const secondLifeNote = 'industry threshold for leaving first-life service';

  if (warrantyFloor == null) {
    rows.push(row('At second-life threshold', secondLifeNote, secondLifeFloor));
    return rows;
  }
  // Same number, same euro figure: one row naming both meanings beats two
  // identical rows that read as a duplication bug.
  if (Math.abs(warrantyFloor - secondLifeFloor) < 0.005) {
    rows.push(
      row(
        'At capacity floor and second-life threshold',
        `${floorNote}, and the ${secondLifeNote}, coincide at this state of health`,
        warrantyFloor,
      ),
    );
    return rows;
  }
  const distinct = [
    row('At capacity floor', floorNote, warrantyFloor),
    row('At second-life threshold', secondLifeNote, secondLifeFloor),
  ];
  // Highest state of health first, so the rows read as a trajectory.
  distinct.sort((a, b) => b.soh - a.soh);
  rows.push(...distinct);
  return rows;
}

export default function BatteryResidualValue({
  currentSoh,
  warrantyFloor,
  warrantyFloorSource = 'unknown',
  installValueEur,
  installValueSource,
  secondLifeFloor = 0.7,
}: BatteryResidualValueProps) {
  const hasFloor = warrantyFloor != null && Number.isFinite(warrantyFloor);
  const rows = residualMilestones({
    currentSoh,
    warrantyFloor: hasFloor ? warrantyFloor! : null,
    secondLifeFloor,
    installValueEur,
    warrantyFloorSource,
  });

  const today = rows[0];
  const atFloor = hasFloor ? rows[rows.length - 1] : null;
  const netImpactEur = atFloor ? atFloor.valueEur - today.valueEur : null;
  const netImpactPct =
    atFloor && today.valueEur > 0 ? (netImpactEur! / today.valueEur) * 100 : null;

  return (
    <OpsPanel
      label="Residual value · projection"
      meta={
        <span className="inline-flex flex-wrap items-center gap-2 text-[10.5px]">
          <span
            className="rounded-sm border px-1.5 py-px font-mono"
            style={{
              color: 'var(--ops-muted)',
              background: 'var(--ops-panel-2)',
              borderColor: 'var(--ops-hair)',
            }}
            title={RESIDUAL_VALUE_NOTES}
          >
            <Info size={10} className="mr-1 inline" />
            Model estimate
          </span>
          <span style={{ color: 'var(--ops-label)' }}>
            basis {formatEur(installValueEur)}
            {installValueSource ? ` · ${installValueSource}` : ''}
          </span>
        </span>
      }
    >
      <div className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-3 rounded-sm border-b py-1.5 last:border-0"
            style={{ borderColor: 'var(--ops-row-hair)' }}
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span
                className="font-mono text-[11.5px]"
                style={{
                  color: row.isToday ? 'var(--ops-bright)' : 'var(--ops-txt)',
                  fontWeight: row.isToday ? 600 : 400,
                }}
              >
                {row.label}
              </span>
              <span className="font-mono text-[9.5px]" style={{ color: 'var(--ops-label)' }}>
                SoH {(row.soh * 100).toFixed(1)}% ·{' '}
                <span style={{ color: TONE_VAR[TIER_TONE[row.tier]] }}>
                  {TIER_LABEL[row.tier]}
                </span>{' '}
                · {(row.multiplier * 100).toFixed(0)}% of basis
              </span>
              <span className="text-[9.5px] leading-snug" style={{ color: 'var(--ops-label)' }}>
                {row.note}
              </span>
            </div>
            <span
              className="ops-num shrink-0 text-[18px]"
              style={{
                color: row.isToday ? 'var(--ops-bright)' : TONE_VAR[TIER_TONE[row.tier]],
                fontWeight: 600,
              }}
            >
              {formatEur(row.valueEur)}
            </span>
          </div>
        ))}

        {netImpactEur != null ? (
          <div
            className="mt-1 flex items-center justify-between gap-3 rounded-sm px-2 py-2 font-mono text-[11.5px]"
            style={{
              background: netImpactEur < 0 ? 'var(--ops-alarm-bg)' : 'var(--ops-ok-bg)',
              border: `1px solid ${
                netImpactEur < 0 ? 'var(--ops-alarm-border)' : 'var(--ops-ok-border)'
              }`,
            }}
          >
            <span
              className="inline-flex items-center gap-1.5"
              style={{
                color: netImpactEur < 0 ? 'var(--ops-alarm)' : 'var(--ops-ok)',
                fontWeight: 600,
              }}
            >
              <TrendingDown size={12} />
              Value drop, today to the capacity floor
            </span>
            <span
              className="ops-num shrink-0"
              style={{
                color: netImpactEur < 0 ? 'var(--ops-alarm)' : 'var(--ops-ok)',
                fontWeight: 600,
              }}
            >
              {formatEur(netImpactEur)}
              {netImpactPct == null ? '' : ` (${formatPct(netImpactPct)})`}
            </span>
          </div>
        ) : (
          <div
            className="mt-1 rounded-sm px-2 py-2 text-[11.5px] leading-relaxed"
            style={{
              background: 'var(--ops-panel-2)',
              border: '1px solid var(--ops-row-hair)',
              color: 'var(--ops-muted)',
            }}
          >
            No warranty terms on file, so the value at the contractual capacity
            floor is not shown. Upload the supply contract to add that milestone.
          </div>
        )}
      </div>
    </OpsPanel>
  );
}
