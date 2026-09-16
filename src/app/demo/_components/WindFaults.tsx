'use client';

/**
 * Wind fault console for the /faults route. The PV fault queue (OpsFaults)
 * doesn't apply to turbines — this renders the wind-specific fault table and
 * component-RUL timeline that previously only existed as a tab inside the
 * wind overview, so the rail's Faults item lands on real wind content.
 */

import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';
import OpsPanel from '@/components/ops/OpsPanel';
import { useWindData } from '@/hooks/useWindData';
import { WindFaultTable } from '@/components/wind/WindFaultTable';
import { WindRULTimeline } from '@/components/wind/WindRULTimeline';

export default function WindFaults({ plantId }: { plantId: string }) {
  const { faults, rul, isLoading, error } = useWindData(plantId);

  if (error) {
    return (
      <div className="ops-legacy">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Failed to load wind fault data: {error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="ops-legacy space-y-3.5">
      <OpsPanel
        label="Wind faults · component events"
        subtitle="Detected + labeled turbine faults with impact estimates"
      >
        {faults ? (
          <WindFaultTable faults={faults.faults} />
        ) : isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : (
          <p className="text-sm text-gray-500">No fault data available.</p>
        )}
      </OpsPanel>

      <OpsPanel
        label="Remaining useful life · per component"
        subtitle="Normal-behaviour-model residuals per drivetrain component"
      >
        {rul ? (
          <WindRULTimeline predictions={rul.predictions} />
        ) : isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : (
          <p className="text-sm text-gray-500">No RUL predictions available.</p>
        )}
      </OpsPanel>
    </div>
  );
}
