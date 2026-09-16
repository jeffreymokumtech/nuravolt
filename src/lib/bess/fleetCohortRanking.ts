/**
 * Fleet cohort percentile ranking for a BESS asset's warranty-health score.
 *
 * Compares the target asset's `warrantyHealthScore` against all other
 * `BessAsset` rows in the same org. Returns the percentile + simple cohort
 * stats so the UI can render a horizontal positioning band.
 */

export interface CohortAsset {
  id: string;
  name: string;
  warrantyHealthScore: number;
  currentSoh: number;
  chemistry: string;
}

export interface CohortRanking {
  targetId: string;
  targetScore: number;
  /** 0-100. 100 = best in cohort. */
  percentile: number;
  /** Number of assets in the cohort (including target). */
  cohortSize: number;
  /** How many other assets the target outperforms. */
  betterThanCount: number;
  /** Cohort mean score. */
  meanScore: number;
  /** Cohort median score. */
  medianScore: number;
  /** Highest-scoring asset in cohort. */
  bestInCohort: CohortAsset | null;
  /** Lowest-scoring asset in cohort. */
  worstInCohort: CohortAsset | null;
  /** Adjacent neighbours above + below the target's rank. */
  neighbours: { above: CohortAsset[]; below: CohortAsset[] };
}

/**
 * Compute the cohort ranking.
 *
 * @param target — the asset being ranked
 * @param cohort — all assets in the comparison set (target may or may not be included)
 */
export function rankFleetCohort(
  target: CohortAsset,
  cohort: CohortAsset[]
): CohortRanking {
  // Ensure target appears once in the working set
  const set = cohort.some((a) => a.id === target.id) ? cohort : [...cohort, target];

  if (set.length <= 1) {
    return {
      targetId: target.id,
      targetScore: target.warrantyHealthScore,
      percentile: 100,
      cohortSize: 1,
      betterThanCount: 0,
      meanScore: target.warrantyHealthScore,
      medianScore: target.warrantyHealthScore,
      bestInCohort: target,
      worstInCohort: target,
      neighbours: { above: [], below: [] },
    };
  }

  const sorted = [...set].sort(
    (a, b) => b.warrantyHealthScore - a.warrantyHealthScore
  );
  const idx = sorted.findIndex((a) => a.id === target.id);
  const betterThanCount = sorted.length - 1 - idx;
  const percentile = (betterThanCount / (sorted.length - 1)) * 100;

  const scores = sorted.map((a) => a.warrantyHealthScore);
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const mid = Math.floor(scores.length / 2);
  const median =
    scores.length % 2 !== 0 ? scores[mid] : (scores[mid - 1] + scores[mid]) / 2;

  return {
    targetId: target.id,
    targetScore: target.warrantyHealthScore,
    percentile: Math.round(percentile),
    cohortSize: sorted.length,
    betterThanCount,
    meanScore: Math.round(mean),
    medianScore: Math.round(median),
    bestInCohort: sorted[0],
    worstInCohort: sorted[sorted.length - 1],
    neighbours: {
      above: sorted.slice(Math.max(0, idx - 2), idx),
      below: sorted.slice(idx + 1, Math.min(sorted.length, idx + 3)),
    },
  };
}
