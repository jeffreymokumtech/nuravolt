'use client';

import { useEffect, useMemo } from 'react';
import { AlertTriangle, Link2, CheckCircle2 } from 'lucide-react';

/**
 * SCADA device-name matching.
 *
 * SCADA tags rarely match the equipment names an operator defines
 * (`PLC01.INV_A01.P_AC` vs `INV-A01`). This step auto-matches every
 * discovered device tag to the equipment list with a transparent score and
 * lets the user override each suggestion before anything is persisted.
 */

export interface DeviceMatch {
  equipmentId: string | null;
  /** 0-1 fuzzy score of the auto-suggestion. 0 when manually overridden. */
  score: number;
}

interface Props {
  /** Device tags discovered on the data source. */
  tags: string[];
  /** Equipment external ids defined in the Equipment step. */
  equipment: string[];
  matches: Record<string, DeviceMatch>;
  onChange: (matches: Record<string, DeviceMatch>) => void;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const hasContiguousRun = (hay: number[], needle: number[]) => {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((v, j) => hay[i + j] === v)) return true;
  }
  return false;
};
const nums = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
const alphaTokens = (s: string) =>
  (s.toLowerCase().match(/[a-z]+/g) ?? []).filter((t) => t.length >= 2);

export function scoreMatch(tag: string, equip: string): number {
  const nTag = norm(tag);
  const nEq = norm(equip);
  if (nTag === nEq) return 0.98;
  if (nTag.includes(nEq) || nEq.includes(nTag)) return 0.9;

  let score = 0;
  const tagNums = nums(tag);
  const eqNums = nums(equip);
  if (eqNums.length > 0 && tagNums.length > 0) {
    // Equipment numbers appear as a contiguous run within the tag numbers.
    if (hasContiguousRun(tagNums, eqNums)) score += 0.55;
    else if (tagNums.at(-1) === eqNums.at(-1)) score += 0.3;
  }
  const tagTokens = new Set(alphaTokens(tag));
  const shared = alphaTokens(equip).filter((t) => tagTokens.has(t));
  if (shared.length > 0) score += 0.25;
  return Math.min(score, 0.95);
}

export function suggestMatches(
  tags: string[],
  equipment: string[],
): Record<string, DeviceMatch> {
  const out: Record<string, DeviceMatch> = {};
  for (const tag of tags) {
    let best: string | null = null;
    let bestScore = 0;
    for (const eq of equipment) {
      const s = scoreMatch(tag, eq);
      if (s > bestScore) {
        bestScore = s;
        best = eq;
      }
    }
    out[tag] = bestScore >= 0.4 ? { equipmentId: best, score: bestScore } : { equipmentId: null, score: 0 };
  }
  return out;
}

function ConfidencePill({ score }: { score: number }) {
  if (score >= 0.8) {
    return (
      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
        {Math.round(score * 100)}%
      </span>
    );
  }
  if (score >= 0.4) {
    return (
      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
        {Math.round(score * 100)}%, review
      </span>
    );
  }
  if (score === 0) {
    return (
      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">
        manual
      </span>
    );
  }
  return (
    <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
      no match
    </span>
  );
}

export default function DeviceMatchStep({ tags, equipment, matches, onChange }: Props) {
  // Auto-suggest on first render (or when the discovery/tag set changes).
  useEffect(() => {
    const missing = tags.some((t) => !(t in matches));
    if (missing) {
      onChange({ ...suggestMatches(tags, equipment), ...matches });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags, equipment]);

  const stats = useMemo(() => {
    const vals = tags.map((t) => matches[t]).filter(Boolean);
    return {
      matched: vals.filter((m) => m.equipmentId != null).length,
      review: vals.filter((m) => m.equipmentId != null && m.score > 0 && m.score < 0.8).length,
      unmatched: vals.filter((m) => m.equipmentId == null).length,
    };
  }, [tags, matches]);

  const usedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tags) {
      const eq = matches[t]?.equipmentId;
      if (eq) counts.set(eq, (counts.get(eq) ?? 0) + 1);
    }
    return counts;
  }, [tags, matches]);

  const setMatch = (tag: string, equipmentId: string | null) =>
    onChange({ ...matches, [tag]: { equipmentId, score: 0 } });

  if (equipment.length === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        No equipment was defined in the Equipment step, so there is nothing to
        match device tags against. You can continue, device matching can be
        done later from the Data Hub once equipment is configured.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
          <Link2 className="h-5 w-5 text-blue-600" />
          Match SCADA devices to your equipment
        </h3>
        <p className="mt-1 text-sm text-gray-500">
          Tag names on the data source rarely match your equipment naming.
          Review the automatic matches below, telemetry only flows for
          matched devices.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" /> {stats.matched} matched
        </span>
        {stats.review > 0 && (
          <span className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-700">
            {stats.review} low-confidence, review
          </span>
        )}
        {stats.unmatched > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-1 font-medium text-rose-700">
            <AlertTriangle className="h-3.5 w-3.5" /> {stats.unmatched} unmatched
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-4 py-2.5">Discovered tag</th>
              <th className="px-4 py-2.5">Equipment</th>
              <th className="px-4 py-2.5">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => {
              const m = matches[tag];
              const dup = m?.equipmentId && (usedCounts.get(m.equipmentId) ?? 0) > 1;
              return (
                <tr key={tag} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-2 font-mono text-xs text-gray-700">{tag}</td>
                  <td className="px-4 py-2">
                    <select
                      value={m?.equipmentId ?? ''}
                      onChange={(e) => setMatch(tag, e.target.value || null)}
                      className={`w-full rounded-md border bg-white px-2 py-1.5 text-xs ${
                        m?.equipmentId == null
                          ? 'border-rose-300 text-rose-700'
                          : dup
                            ? 'border-amber-300'
                            : 'border-gray-300'
                      }`}
                    >
                      <option value="">, not matched,</option>
                      {equipment.map((eq) => (
                        <option key={eq} value={eq}>
                          {eq}
                        </option>
                      ))}
                    </select>
                    {dup && (
                      <div className="mt-0.5 text-[11px] text-amber-600">
                        Also assigned to another tag
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <ConfidencePill score={m?.equipmentId == null ? -1 : m?.score ?? 0} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {stats.unmatched > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          Unmatched tags will be ingested but not attributed to any inverter, analytics (twin, soiling, faults) ignore them until matched. You can
          finish matching later from the Data Hub.
        </div>
      )}
    </div>
  );
}
