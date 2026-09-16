import { ReactNode } from 'react';
import { DataSourceProvider } from '@/contexts/DataSourceContext';
import { DemoPlantProvider } from '@/contexts/DemoPlantContext';
import { AnonymizationProvider } from '@/contexts/AnonymizationContext';
import { OpsThemeProvider } from '@/contexts/OpsThemeContext';
import { CopilotProvider } from '@/components/copilot/CopilotProvider';
import { CopilotRail } from '@/components/copilot/CopilotRail';
import ShowcaseHeader from './_components/ShowcaseHeader';

/**
 * Layout for the public /showcase route.
 *
 * Wraps children with:
 *   - DataSourceProvider(dataRoot='/data/showcase', readOnly=true), section
 *     components read this to resolve their static-data base URL.
 *   - ShowcasePlantProvider, static 2-plant list from plants.json.
 *   - AnonymizationProvider, kept for UI parity, but showcase data is already
 *     scrubbed at source.
 *
 * The showcase is public in production (not blocked by middleware).
 */
export default function ShowcaseLayout({ children }: { children: ReactNode }) {
  return (
    <OpsThemeProvider>
      <DataSourceProvider dataRoot="/data/showcase" readOnly>
        <DemoPlantProvider staticPlantsUrl="/data/showcase/plants.json">
          <AnonymizationProvider>
            <CopilotProvider>
              <div className="min-h-screen bg-paper">
                <ShowcaseHeader />
                {children}
              </div>
              <CopilotRail />
            </CopilotProvider>
          </AnonymizationProvider>
        </DemoPlantProvider>
      </DataSourceProvider>
    </OpsThemeProvider>
  );
}

export const metadata = {
  title: 'Live Demo, NuraVolt Platform',
  description:
    'Click through an anonymised sample portfolio: one 45 MW PV plant with co-located BESS, and one 20 MW wind farm.',
};
