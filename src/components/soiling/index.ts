/**
 * Per-Inverter Soiling Analysis Components
 *
 * React components for displaying per-inverter soiling analysis results.
 * Uses Apache ECharts for visualizations and fetches data from static JSON files.
 *
 * @example
 * ```tsx
 * import { PerInverterDashboard } from '@/components/soiling';
 *
 * export default function SoilingPage() {
 *   return <PerInverterDashboard plantId="alpha1" />;
 * }
 * ```
 */

export { FleetSummaryCard } from './FleetSummaryCard';
export { LossWaterfallChart } from './LossWaterfallChart';
export { PerInverterDashboard } from './PerInverterDashboard';

// Cleaning Optimizer
export { default as CleaningOptimizerTab } from './CleaningOptimizerTab';

// Rain & Soiling Analysis Components (Phase 2)
export { default as SoilingAnalysisChart } from './SoilingAnalysisChart';
export { default as DataLabelingPanel } from './DataLabelingPanel';
export { default as DataExplorerChart } from './DataExplorerChart';
export { SeasonalForecastChart } from './SeasonalForecastChart';

// Data Quality Hub Components (Phase 3)
export { default as DataQualitySection } from './DataQualitySection';
export { default as SpatialUniformityChart } from './SpatialUniformityChart';
export { default as IrradianceQualityChart } from './IrradianceQualityChart';
export { default as DataSourceCorrelationCard } from './DataSourceCorrelationCard';
export { default as QualityAlertsPanel } from './QualityAlertsPanel';

// Types re-exported for convenience
export type {
  FleetSummary,
  InverterSoilingMetrics,
  SoilingRatioStats,
  LossDisaggregation,
  HealthDistribution,
  FleetComparison,
  CleaningParameters,
  OptimizationRequest,
  OptimizationResponse,
  DigitalTwinResponse,
  LiveCostBenefitResult,
  CostBenefitResult,
  SavedScenarioData,
  ScenarioComparison,
  MultiPlantComparison,
  RainDataPoint,
  RainCleaningEvent,
  RainHistoryData,
  DataLabel,
  LabelType,
  // Data Quality Hub Types
  SpatialUniformityData,
  IrradianceComparisonData,
  DataSourceCorrelationData,
  UniformityAlert,
  IrradianceQualityAlert,
  ZoneCorrelation,
} from '@/types/soiling';
