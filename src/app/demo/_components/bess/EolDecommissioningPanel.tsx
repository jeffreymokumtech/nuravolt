'use client';

import { Info, Recycle } from 'lucide-react';
import OpsPanel from '@/components/ops/OpsPanel';
import {
  computeDecommissioningCost,
  normaliseChemistry,
  DECOMMISSIONING_NOTES,
} from '@/lib/bess/decommissioningCost';
import { formatEur } from './BatteryResidualValue';

/**
 * End-of-life decommissioning cost breakdown, disposal cost minus recycled
 * material value, with chemistry-specific recovery assumptions.
 *
 * Every euro on this panel is capacity times a rate, so the capacity and both
 * rates are rendered underneath: a reader who wants to check €800k against
 * €80/kWh needs to see the 10,000 kWh as well.
 */

interface EolDecommissioningPanelProps {
  capacityKwh: number;
  chemistry: string | null | undefined;
  /** SoH at decommissioning [0,1], normally the contractual warranty floor. */
  endOfLifeSoh: number;
  /**
   * Where `endOfLifeSoh` came from, rendered next to the model-estimate chip.
   * An assumed end-of-life SoH must say so: the cost only reads as evidence if
   * the reader can see whether the input was contractual or industry-typical.
   */
  endOfLifeSohSource?: string;
}

export default function EolDecommissioningPanel({
  capacityKwh,
  chemistry,
  endOfLifeSoh,
  endOfLifeSohSource,
}: EolDecommissioningPanelProps) {
  const chemKey = normaliseChemistry(chemistry);
  const result = computeDecommissioningCost(capacityKwh, endOfLifeSoh, chemKey);
  const capacityLabel = `${Math.round(capacityKwh).toLocaleString('en-GB')} kWh`;

  return (
    <OpsPanel
      label="End-of-life decommissioning · cost projection"
      meta={
        <span className="inline-flex flex-wrap items-center gap-2 text-[10.5px]">
          <span
            className="rounded-sm border px-1.5 py-px font-mono"
            style={{
              color: 'var(--ops-muted)',
              background: 'var(--ops-panel-2)',
              borderColor: 'var(--ops-hair)',
            }}
            title={DECOMMISSIONING_NOTES}
          >
            <Info size={10} className="mr-1 inline" />
            Model estimate · {chemKey}
          </span>
          <span style={{ color: 'var(--ops-label)' }}>
            at {(endOfLifeSoh * 100).toFixed(0)}% SoH
            {endOfLifeSohSource ? `, ${endOfLifeSohSource}` : ''}
          </span>
        </span>
      }
    >
      <div className="flex flex-col gap-2.5 font-mono text-[11.5px]">
        <div
          className="flex items-baseline justify-between border-b py-1.5"
          style={{ borderColor: 'var(--ops-row-hair)' }}
        >
          <span style={{ color: 'var(--ops-muted)' }}>Disposal cost</span>
          <span className="ops-num" style={{ color: 'var(--ops-alarm)' }}>
            {formatEur(result.disposalCostEur)}
          </span>
        </div>

        <div
          className="flex items-baseline justify-between border-b py-1.5"
          style={{ borderColor: 'var(--ops-row-hair)' }}
        >
          <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ops-muted)' }}>
            <Recycle size={11} style={{ color: 'var(--ops-ok)' }} />
            Recycled material value
          </span>
          <span className="ops-num" style={{ color: 'var(--ops-ok)' }}>
            {formatEur(-result.recycledMaterialValueEur)}
          </span>
        </div>

        <div
          className="mt-1 flex items-baseline justify-between rounded-sm px-2 py-2"
          style={{
            background: 'var(--ops-info-bg)',
            border: '1px solid var(--ops-info-border)',
          }}
        >
          <span style={{ color: 'var(--ops-info)', fontWeight: 600 }}>Net decommissioning cost</span>
          <span className="ops-num" style={{ color: 'var(--ops-info)', fontWeight: 600, fontSize: 16 }}>
            {formatEur(result.netCostEur)}
          </span>
        </div>

        <div
          className="grid gap-1 pt-1 text-[10px]"
          style={{ color: 'var(--ops-label)', gridTemplateColumns: '1fr 1fr' }}
        >
          <div>
            <div className="uppercase tracking-[0.06em]">Disposal rate</div>
            <div className="ops-num" style={{ color: 'var(--ops-txt)' }}>
              €{result.assumptions.disposalRateEurPerKwh}/kWh × {capacityLabel}
            </div>
          </div>
          <div>
            <div className="uppercase tracking-[0.06em]">Material yield</div>
            <div className="ops-num" style={{ color: 'var(--ops-txt)' }}>
              €{result.assumptions.materialValueEurPerKwh}/kWh × {capacityLabel} ×{' '}
              {(result.assumptions.recoveryFactor * 100).toFixed(0)}%
            </div>
          </div>
        </div>
      </div>
    </OpsPanel>
  );
}
