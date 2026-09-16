'use client';

import { ArrowUpRight } from 'lucide-react';
import OpsPanel from '@/components/ops/OpsPanel';
import { rankFleetCohort, type CohortAsset } from '@/lib/bess/fleetCohortRanking';

/**
 * Fleet cohort percentile band, shows where this asset sits vs the rest
 * of the org's BESS fleet on warranty health. Twaice's framing: every
 * battery is a member of a portfolio, and operators want to know "is this
 * asset above or below my fleet median?".
 */

interface FleetCohortComparisonProps {
  target: CohortAsset;
  cohort: CohortAsset[];
}

const TONE_FOR_SCORE = (score: number) =>
  score >= 80 ? 'ok' : score >= 60 ? 'warn' : 'alarm';

const TONE_VAR = {
  ok: 'var(--ops-ok)',
  warn: 'var(--ops-warn)',
  alarm: 'var(--ops-alarm)',
};

/**
 * Below this cohort size a percentile carries no information: with two assets
 * the only possible answers are p0 and p100, so the headline switches to the
 * rank, which is what the number actually means at that size.
 */
const MIN_COHORT_FOR_PERCENTILE = 4;

export default function FleetCohortComparison({
  target,
  cohort,
}: FleetCohortComparisonProps) {
  const ranking = rankFleetCohort(target, cohort);
  const targetTone = TONE_FOR_SCORE(ranking.targetScore);
  const peers = Math.max(0, ranking.cohortSize - 1);
  const showPercentile = ranking.cohortSize >= MIN_COHORT_FOR_PERCENTILE;

  return (
    <OpsPanel
      label="Fleet cohort · warranty health"
      meta={
        <span className="font-mono text-[10.5px]" style={{ color: 'var(--ops-muted)' }}>
          n={ranking.cohortSize} · median {ranking.medianScore}/100
        </span>
      }
    >
      <div className="flex flex-col gap-3 font-mono">
        {/* Headline: percentile once the cohort can support one, rank until then. */}
        <div className="flex items-baseline justify-between">
          <span className="text-[11.5px]" style={{ color: 'var(--ops-muted)' }}>
            This asset
          </span>
          <span className="inline-flex items-baseline gap-2">
            <span
              className="ops-num text-[24px]"
              style={{ color: TONE_VAR[targetTone], fontWeight: 600 }}
            >
              {showPercentile
                ? `p${ranking.percentile}`
                : `#${ranking.cohortSize - ranking.betterThanCount}`}
            </span>
            <span className="text-[10.5px]" style={{ color: 'var(--ops-muted)' }}>
              {peers === 0
                ? 'no peers in this account'
                : showPercentile
                  ? `better than ${ranking.betterThanCount}/${peers}`
                  : `of ${ranking.cohortSize} scored assets`}
            </span>
          </span>
        </div>

        {/* Percentile band. A full bar against no peers reads as "best in
            fleet", so with nothing to compare against the band is dropped. */}
        {peers > 0 && (
          <>
            <div className="relative h-3 overflow-hidden rounded-sm" style={{ background: 'var(--ops-row-hair)' }}>
              <div
                className="absolute top-0 bottom-0 left-0"
                style={{
                  width: `${ranking.percentile}%`,
                  background: `linear-gradient(90deg, var(--ops-alarm), var(--ops-warn), var(--ops-ok))`,
                  opacity: 0.85,
                }}
              />
              <div
                className="absolute top-[-2px] bottom-[-2px] w-[2px]"
                style={{
                  left: `${ranking.percentile}%`,
                  background: 'var(--ops-bright)',
                }}
              />
            </div>
            <div className="flex justify-between text-[9.5px]" style={{ color: 'var(--ops-label)' }}>
              <span>p0 · worst</span>
              <span>median p50</span>
              <span>p100 · best</span>
            </div>
          </>
        )}

        {/* Adjacent neighbours */}
        {(ranking.neighbours.above.length > 0 || ranking.neighbours.below.length > 0) && (
          <div className="mt-1 flex flex-col gap-1 text-[10.5px]">
            <div className="text-[9.5px] uppercase tracking-[0.06em]" style={{ color: 'var(--ops-label)' }}>
              Adjacent cohort
            </div>
            {ranking.neighbours.above.map((a) => (
              <CohortRow key={a.id} asset={a} delta={a.warrantyHealthScore - ranking.targetScore} />
            ))}
            <CohortRow asset={target} highlighted delta={0} />
            {ranking.neighbours.below.map((a) => (
              <CohortRow key={a.id} asset={a} delta={a.warrantyHealthScore - ranking.targetScore} />
            ))}
          </div>
        )}

      </div>
    </OpsPanel>
  );
}

function CohortRow({
  asset,
  delta,
  highlighted,
}: {
  asset: CohortAsset;
  delta: number;
  highlighted?: boolean;
}) {
  const deltaTone = delta > 0 ? 'var(--ops-ok)' : delta < 0 ? 'var(--ops-alarm)' : 'var(--ops-muted)';
  return (
    <div
      className="flex items-baseline justify-between rounded-sm px-1.5 py-1"
      style={{
        background: highlighted ? 'var(--ops-info-bg)' : 'transparent',
        border: highlighted ? '1px solid var(--ops-info-border)' : '1px solid transparent',
      }}
    >
      <span
        className="overflow-hidden text-ellipsis whitespace-nowrap"
        style={{
          color: highlighted ? 'var(--ops-bright)' : 'var(--ops-txt)',
          fontWeight: highlighted ? 600 : 400,
        }}
      >
        {asset.name}
      </span>
      <span className="inline-flex items-baseline gap-2">
        <span className="ops-num text-[11px]" style={{ color: 'var(--ops-txt)' }}>
          {asset.warrantyHealthScore}/100
        </span>
        {!highlighted && (
          <span className="ops-num text-[9.5px]" style={{ color: deltaTone }}>
            {delta > 0 ? '+' : ''}{delta}
          </span>
        )}
      </span>
    </div>
  );
}
