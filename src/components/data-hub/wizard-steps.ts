import type { DataSourceEntry } from '@/types/onboarding';

/**
 * Wizard step state machine — the single source of truth for step gating.
 *
 * Each predicate below is a 1:1 transcription of the gating conditions that
 * previously lived scattered across ConnectionWizard's footer buttons and
 * hard-coded Back/auto-advance special cases. The wizard renders the steps,
 * this module decides which are complete, skipped, and enterable — enabling
 * non-linear navigation (clickable step indicator, jump back/forward).
 */

export interface WizardSnapshot {
  mode: 'full-onboarding' | 'connection-only';
  // Full onboarding
  plantName: string;
  capacityMw: number;
  /**
   * Asset type picked on step 1. Optional so a caller that has not wired it
   * through yet still compiles; the step labels then read as solar, which is
   * the historic behavior. Wire it together with energyCapacityMwh: a storage
   * plant cannot finish step 1 without its energy nameplate.
   */
  assetType?: 'SOLAR' | 'WIND' | 'BESS' | 'HYBRID';
  /** Declared storage energy (MWh). Required for storage assets, null for PV. */
  energyCapacityMwh?: number | null;
  dataSources: DataSourceEntry[];
  skipDataSources: boolean;
  sampleMode: boolean;
  hasDeviceMatching: boolean;
  // Connection-only
  selectedType: string | null;
  connectionName: string;
  connectionId: string | null;
  testSucceeded: boolean;
  discoveryStatus: string | null;
}

export interface WizardStepDef {
  id: number;
  name: string;
  description: string;
  /**
   * Asset-type-aware override for `description`. A battery has no inverters or
   * irradiance sensors to configure, so the storage branch names what the step
   * actually asks for. Read it through stepDescription(), never directly.
   */
  describe?(s: WizardSnapshot): string;
  /** Green tick + unlocks later steps. */
  isComplete(s: WizardSnapshot): boolean;
  /** Hidden from the indicator and skipped by next/prev navigation. */
  isSkipped(s: WizardSnapshot): boolean;
}

const never = () => false;
const always = () => true;

/** True for asset types whose equipment is racks and a BMS, not inverters. */
const isStorage = (s: WizardSnapshot) => s.assetType === 'BESS' || s.assetType === 'HYBRID';

/** The step's description for this snapshot, falling back to the static one. */
export function stepDescription(step: WizardStepDef, s: WizardSnapshot): string {
  return step.describe?.(s) || step.description;
}

/** Sources that still need Configure/Test/Discover (not reused connections). */
const newSources = (s: WizardSnapshot) => s.dataSources.filter((ds) => !ds.existing);

/** True when the per-source Configure/Discover steps have nothing to do. */
const sourceStepsSkipped = (s: WizardSnapshot) =>
  s.skipDataSources ||
  s.sampleMode ||
  (s.dataSources.length > 0 && newSources(s).length === 0);

export const FULL_ONBOARDING_STEPS: WizardStepDef[] = [
  {
    id: 1,
    name: 'Plant',
    description: 'Define your plant',
    // Transcribed from the step-1 Continue gate:
    // !plantConfig.plantName.trim() || !plantConfig.capacity_MW
    // Storage adds one more required field: a battery is sized, priced and
    // modelled on its energy, so the MWh nameplate is not optional.
    isComplete: (s) =>
      Boolean(s.plantName.trim()) &&
      s.capacityMw > 0 &&
      (!isStorage(s) || (s.energyCapacityMwh ?? 0) > 0),
    isSkipped: never,
  },
  {
    id: 2,
    name: 'Equipment',
    description: 'Inverters & sensors',
    describe: (s) => (isStorage(s) ? 'Racks and BMS' : 'Inverters & sensors'),
    isComplete: always, // optional step (had an unconditional Continue + Skip)
    isSkipped: never,
  },
  {
    id: 3,
    name: 'Data Sources',
    description: 'Connect your data',
    isComplete: (s) => s.skipDataSources || s.sampleMode || s.dataSources.length > 0,
    isSkipped: never,
  },
  {
    id: 4,
    name: 'Configure',
    description: 'Enter credentials',
    // Transcribed from the Test-button flow: a source is configured once its
    // connection exists and the test passed.
    isComplete: (s) =>
      newSources(s).length > 0 &&
      newSources(s).every((ds) => Boolean(ds.connectionId) && Boolean(ds.testSuccess)),
    isSkipped: sourceStepsSkipped,
  },
  {
    id: 5,
    name: 'Discover',
    description: 'Analyze data source',
    isComplete: (s) =>
      newSources(s).length > 0 &&
      newSources(s).every((ds) => (ds.discovery as any)?.status === 'completed'),
    isSkipped: sourceStepsSkipped,
  },
  {
    id: 6,
    name: 'Match Devices',
    description: 'Match SCADA tags to equipment',
    isComplete: always, // review step (had an unconditional Continue)
    // Transcribed from the hard-coded Back/advance cases: skipped when there
    // are no device tags or no equipment to match them to.
    isSkipped: (s) => sourceStepsSkipped(s) || !s.hasDeviceMatching,
  },
  {
    id: 7,
    name: 'Map Fields',
    description: 'Review field mappings',
    isComplete: always, // review step (Confirm Mappings was never disabled)
    // NOT skipped for reused connections — their persisted mappings are shown
    // here for review.
    isSkipped: (s) => s.skipDataSources || s.sampleMode,
  },
  {
    id: 8,
    name: 'Confirm',
    description: 'Save and activate',
    isComplete: never, // terminal
    isSkipped: never,
  },
];

export const CONNECTION_ONLY_STEPS: WizardStepDef[] = [
  {
    id: 1,
    name: 'Type',
    description: 'Choose connection type',
    // Transcribed: !selectedType || !connectionName
    isComplete: (s) => Boolean(s.selectedType) && Boolean(s.connectionName),
    isSkipped: never,
  },
  {
    id: 2,
    name: 'Configure',
    description: 'Enter credentials',
    isComplete: (s) => Boolean(s.connectionId) && s.testSucceeded,
    isSkipped: never,
  },
  {
    id: 3,
    name: 'Discover',
    description: 'Analyze data source',
    isComplete: (s) => s.discoveryStatus === 'completed',
    isSkipped: never,
  },
  {
    id: 4,
    name: 'Map Fields',
    description: 'Review field mappings',
    isComplete: always,
    isSkipped: never,
  },
  {
    id: 5,
    name: 'Confirm',
    description: 'Save connection',
    isComplete: never,
    isSkipped: never,
  },
];

/**
 * May the user jump to step `id`? Visited steps are always re-enterable
 * (state is preserved); unvisited steps require every earlier non-skipped
 * step to be complete.
 */
export function canEnterStep(
  steps: WizardStepDef[],
  id: number,
  s: WizardSnapshot,
  visited: Set<number>,
): boolean {
  const step = steps.find((st) => st.id === id);
  if (!step || step.isSkipped(s)) return false;
  if (visited.has(id)) return true;
  return steps
    .filter((st) => st.id < id && !st.isSkipped(s))
    .every((st) => st.isComplete(s));
}

/** Next non-skipped step after `from` (or `from` itself at the end). */
export function nextStep(steps: WizardStepDef[], from: number, s: WizardSnapshot): number {
  const candidates = steps.filter((st) => st.id > from && !st.isSkipped(s));
  return candidates.length > 0 ? candidates[0].id : from;
}

/** Previous non-skipped step before `from` (or 0, meaning "close/cancel"). */
export function prevStep(steps: WizardStepDef[], from: number, s: WizardSnapshot): number {
  const candidates = steps.filter((st) => st.id < from && !st.isSkipped(s));
  return candidates.length > 0 ? candidates[candidates.length - 1].id : 0;
}
