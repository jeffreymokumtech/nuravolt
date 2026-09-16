'use client';

/**
 * Showcase plant detail, delegates to the full /demo plant body.
 *
 * Because the showcase layout provides DataSourceContext (dataRoot='/data/showcase')
 * and a DemoPlantProvider hydrated from /data/showcase/plants.json, the existing
 * section components (OverviewSection, HeatmapSection, SoilingIntelligenceSection,
 * FaultDetectionSection, BessSection, PlantFinancialSection) render against
 * showcase data without modification.
 */
import DemoPlantPage from '@/app/demo/plant/[plantId]/page';

export default function ShowcasePlantPage() {
  return <DemoPlantPage />;
}
