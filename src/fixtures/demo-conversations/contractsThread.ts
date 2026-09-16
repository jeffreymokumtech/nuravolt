import {
  shapeContractDetailOutput,
  shapeContractsOutput,
  type ToolPlantRef,
} from '@/lib/ai/tool-shapes';
import {
  assistantMsg,
  textPart,
  toolPart,
  userMsg,
  type DemoThread,
} from './types';

/**
 * Contract-intelligence example session: list contracts, drill into the PPA
 * availability guarantee. Term values mirror scripts/seed_contracts.ts (the
 * specimen contracts every demo plant carries) so replays match what the
 * Contracts tab actually shows; the obligation reading is the honest
 * energy-proxy sentence the evaluator emits. Cards are inert in scripted
 * replays.
 */

const CONTRACT_ID = 'seed-contract-ppa';
const SLA_ID = 'seed-contract-sla';
const MODULE_ID = 'seed-contract-module';

export function buildContractsThread(args: {
  plant: ToolPlantRef;
  surface: 'demo' | 'showcase';
}): DemoThread {
  const { plant, surface } = args;

  const ppaTerms = [
    { field: 'price_eur_mwh', label: 'Contract price', valueNumeric: 52, unit: 'EUR/MWh', valueText: null, confidence: null, status: 'CONFIRMED', monitored: false },
    { field: 'price_mechanism', label: 'Price mechanism', valueNumeric: null, unit: null, valueText: 'Fixed price, indexed annually', confidence: null, status: 'CONFIRMED', monitored: false },
    { field: 'indexation_pct', label: 'Annual indexation', valueNumeric: 1.5, unit: '%', valueText: null, confidence: null, status: 'CONFIRMED', monitored: false },
    { field: 'term_years', label: 'Contract term', valueNumeric: 10, unit: 'years', valueText: null, confidence: null, status: 'CONFIRMED', monitored: false },
    { field: 'availability_guarantee_pct', label: 'Availability guarantee', valueNumeric: 97, unit: '%', valueText: null, confidence: null, status: 'CONFIRMED', monitored: true },
    { field: 'settlement_period', label: 'Settlement period', valueNumeric: null, unit: null, valueText: 'Monthly', confidence: null, status: 'CONFIRMED', monitored: false },
  ];

  const contracts = [
    {
      id: CONTRACT_ID,
      contractType: 'PPA',
      title: 'Power purchase agreement',
      counterparty: 'Meseta Energy Trading',
      status: 'ACTIVE',
      effectiveFrom: '2023-01-01',
      effectiveTo: '2033-01-01',
      hasSourceDocument: false,
      terms: ppaTerms,
    },
    {
      id: MODULE_ID,
      contractType: 'MODULE_WARRANTY',
      title: 'Module linear performance warranty',
      counterparty: 'Helios Module Works',
      status: 'ACTIVE',
      effectiveFrom: '2023-01-01',
      effectiveTo: '2048-01-01',
      hasSourceDocument: false,
      terms: [
        { field: 'annual_degradation_pct', label: 'Annual degradation', valueNumeric: 0.55, unit: '%/year', valueText: null, confidence: null, status: 'CONFIRMED', monitored: true },
        { field: 'end_capacity_pct', label: 'End-of-warranty capacity', valueNumeric: 84.8, unit: '%', valueText: null, confidence: null, status: 'CONFIRMED', monitored: false },
      ],
    },
    {
      id: SLA_ID,
      contractType: 'OM_SLA',
      title: 'O&M service level agreement',
      counterparty: 'Levante O&M Services',
      status: 'ACTIVE',
      effectiveFrom: '2023-01-01',
      effectiveTo: '2028-01-01',
      hasSourceDocument: false,
      terms: [
        { field: 'response_hours_critical', label: 'Response time (critical)', valueNumeric: 4, unit: 'hours', valueText: null, confidence: null, status: 'CONFIRMED', monitored: true },
        { field: 'guaranteed_availability_pct', label: 'Guaranteed availability', valueNumeric: 98, unit: '%', valueText: null, confidence: null, status: 'CONFIRMED', monitored: true },
      ],
    },
  ];

  const ppaObligation = {
    contract_id: CONTRACT_ID,
    contract_type: 'PPA',
    field: 'availability_guarantee_pct',
    status: 'ok' as const,
    observed_value: null,
    threshold: 97,
    unit: '%',
    window: '30d',
    detail:
      '30-day energy delivery vs twin expectation is above the 97% guarantee (energy proxy, not contractual availability metering)',
  };

  const listOutput = shapeContractsOutput({
    plantId: plant.slug,
    contracts: contracts as never,
    obligations: { obligations: [ppaObligation] },
  });

  const detailOutput = shapeContractDetailOutput(contracts[0] as never, [ppaObligation]);

  return {
    id: `${plant.slug}-contracts`,
    title: 'Are we meeting our PPA guarantees?',
    prompt: `What contracts do we have on ${plant.name}, and are we meeting the PPA availability guarantee?`,
    plantSlug: plant.slug,
    plantName: plant.name,
    surface,
    messages: [
      userMsg(`What contracts do we have on ${plant.name}, and are we meeting the PPA availability guarantee?`),
      assistantMsg([
        textPart(`Checking the contracts on file for ${plant.name}.`),
        toolPart('listContracts', { plantId: plant.slug }, listOutput),
        textPart(
          `Three contracts are on file: the PPA with Meseta Energy Trading, the module linear performance warranty, and the O&M service level agreement. Now the PPA in detail.`
        ),
        toolPart('getContract', { plantId: plant.slug, contractType: 'PPA' }, detailOutput),
        textPart(
          `The PPA runs 2023 to 2033 at a fixed, annually indexed price with a 97% availability guarantee. The guarantee is monitored hourly: 30-day energy delivery against the digital twin's expectation is currently above the 97% floor, so the obligation is on track. Note the honest caveat: this is an energy proxy from the twin, not contractual availability metering.\n\nIf delivery ever drops toward the floor, the obligation flips to at-risk and a breach opens an alert automatically. The full terms, source excerpts and renewal horizon live in the Contracts tab.`
        ),
      ]),
    ],
  };
}
