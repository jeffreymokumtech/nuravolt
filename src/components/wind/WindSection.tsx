/**
 * WindSection - Main wind plant monitoring dashboard section
 *
 * Combines all wind components into a cohesive dashboard view.
 */

'use client';

import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Wind,
  Activity,
  AlertTriangle,
  Wrench,
  LayoutGrid,
  RefreshCw,
  Compass,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

import { useWindData, type WindSiteData } from '@/hooks/useWindData';
import { usePageContext } from '@/components/copilot/usePageContext';
import { WindKPIGrid } from './WindKPIGrid';
import { PowerCurveChart } from './PowerCurveChart';
import { TurbineFleetHeatmap } from './TurbineFleetHeatmap';
import { WindFaultTable } from './WindFaultTable';
import { WindRULTimeline } from './WindRULTimeline';
import { TurbineSelector } from './TurbineSelector';
import WindRose from './WindRose';
import WakeMap from './WakeMap';

interface WindSectionProps {
  plantId: string;
}

export function WindSection({ plantId }: WindSectionProps) {
  const {
    plant,
    turbines,
    powerCurve,
    faults,
    rul,
    selectedTurbineId,
    isLoading,
    error,
    refetch,
    selectTurbine,
    fetchSite,
  } = useWindData(plantId);

  const [activeTab, setActiveTab] = useState('overview');

  // Tab-aware copilot context: "what am I looking at" on the wind console.
  usePageContext({
    plantId,
    plantName: plant?.plantName,
    section: `wind:${activeTab}`,
    assetType: 'WIND',
  });

  // Site climate + wake analysis, loaded lazily when the tab first opens.
  const [site, setSite] = useState<WindSiteData | null>(null);
  const [siteLoaded, setSiteLoaded] = useState(false);
  useEffect(() => {
    if (activeTab !== 'site' || siteLoaded) return;
    fetchSite().then((data) => {
      setSite(data);
      setSiteLoaded(true);
    });
  }, [activeTab, siteLoaded, fetchSite]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          Failed to load wind plant data: {error.message}
        </AlertDescription>
      </Alert>
    );
  }

  if (isLoading && !plant) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!plant) {
    return (
      <Alert>
        <Wind className="h-4 w-4" />
        <AlertDescription>
          No wind plant data available for {plantId}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with plant info and turbine selector */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Wind className="h-6 w-6" />
            {plant.plantName}
          </h2>
          <p className="text-muted-foreground">
            {plant.location} • {plant.turbineModel}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {turbines && (
            <TurbineSelector
              turbines={turbines.turbines}
              selectedId={selectedTurbineId}
              onSelect={selectTurbine}
            />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={refetch}
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI Grid */}
      <WindKPIGrid plant={plant} />

      {/* Tabbed content */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview" className="flex items-center gap-2">
            <LayoutGrid className="h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="power-curve" className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Power Curve
          </TabsTrigger>
          <TabsTrigger value="faults" className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Faults
            {faults && faults.faults.filter((f) => f.status === 'ACTIVE').length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-destructive text-destructive-foreground">
                {faults.faults.filter((f) => f.status === 'ACTIVE').length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="predictive" className="flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Predictive
          </TabsTrigger>
          <TabsTrigger value="site" className="flex items-center gap-2">
            <Compass className="h-4 w-4" />
            Site &amp; Wake
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 mt-6">
          {/* Turbine Fleet */}
          {turbines && (
            <TurbineFleetHeatmap
              turbines={turbines.turbines}
              selectedTurbineId={selectedTurbineId}
              onTurbineSelect={selectTurbine}
            />
          )}

          {/* Power Curve Preview */}
          {powerCurve && (
            <PowerCurveChart analysis={powerCurve} height={300} />
          )}

          {/* Active Faults Summary */}
          {faults && faults.faults.filter((f) => f.status === 'ACTIVE').length > 0 && (
            <WindFaultTable
              faults={faults.faults.filter((f) => f.status === 'ACTIVE')}
            />
          )}
        </TabsContent>

        <TabsContent value="power-curve" className="mt-6">
          {powerCurve ? (
            <PowerCurveChart analysis={powerCurve} height={500} />
          ) : (
            <Skeleton className="h-96 w-full" />
          )}
        </TabsContent>

        <TabsContent value="faults" className="mt-6">
          {faults ? (
            <WindFaultTable faults={faults.faults} />
          ) : (
            <Skeleton className="h-96 w-full" />
          )}
        </TabsContent>

        <TabsContent value="predictive" className="mt-6">
          {rul ? (
            <WindRULTimeline predictions={rul.predictions} />
          ) : (
            <Skeleton className="h-96 w-full" />
          )}
        </TabsContent>

        <TabsContent value="site" className="mt-6 space-y-6">
          {!siteLoaded ? (
            <Skeleton className="h-96 w-full" />
          ) : site?.rose || site?.wake ? (
            <div className="grid gap-6 xl:grid-cols-2">
              {site.rose && <WindRose data={site.rose} />}
              {site.wake && <WakeMap data={site.wake} />}
            </div>
          ) : (
            <Alert>
              <Compass className="h-4 w-4" />
              <AlertDescription>
                No site analysis available for this plant yet. Site climate and
                wake fixtures are generated by
                scripts/generate_wind_site_analysis.py.
              </AlertDescription>
            </Alert>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default WindSection;
