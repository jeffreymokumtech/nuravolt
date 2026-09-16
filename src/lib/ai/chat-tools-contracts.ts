import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  resolvePlantOrDeny,
  type ChatAccessContext,
} from '@/lib/ai/access-control';
import {
  shapeContractDetailOutput,
  shapeContractsOutput,
  shapeOptimizerAuditOutput,
  shapeWarrantyPositionOutput,
} from '@/lib/ai/tool-shapes';

/**
 * Contract-intelligence tools (arc 11): read-only views over the Contracts
 * tab data and the live BESS audit artifacts. Uploading/confirming contracts
 * stays a UI flow — the model can report and explain, never bind terms.
 * Excluded from scoped tsc like the other chat-tool files (ai SDK tool()
 * generics, TS2589); verified via npx tsx runtime probes.
 */

const denied = (reason: string, detail?: string) => ({
  error: reason,
  ...(detail ? { detail } : {}),
});

const internalHeaders = () => ({
  'x-internal-chat-tool': process.env.INTERNAL_API_SECRET ?? '',
});

const CONTRACT_TYPES = [
  'PPA',
  'MODULE_WARRANTY',
  'INVERTER_WARRANTY',
  'OM_SLA',
  'BESS_WARRANTY',
  'OTHER',
] as const;

export function buildContractTools(ctx: ChatAccessContext, origin: string): ToolSet {
  const fetchContracts = async (slug: string) => {
    const res = await fetch(`${origin}/api/plants/${slug}/contracts`, {
      headers: internalHeaders(),
    });
    if (!res.ok) return null;
    return res.json();
  };

  const fetchAudit = async (slug: string, file: 'dossier' | 'optimizer') => {
    const res = await fetch(`${origin}/api/bess/plants/${slug}/audit?file=${file}`, {
      headers: internalHeaders(),
    });
    if (!res.ok) return null;
    return res.json();
  };

  return {
    listContracts: tool({
      description:
        'List the contracts on file for a plant (PPA, module/inverter warranties, O&M SLA, BESS warranty) with each contract\'s live obligation status. Use when the user asks about contracts, warranties, PPAs, SLAs, or "are we meeting our guarantees".',
      inputSchema: z.object({
        plantId: z.string().describe('Plant id or slug from listPlants.'),
      }),
      execute: async ({ plantId }) => {
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('plant_not_found_or_no_access');
        const payload = await fetchContracts(plant.slug);
        if (!payload) return denied('contracts_unavailable');
        return shapeContractsOutput(payload);
      },
    }),

    getContract: tool({
      description:
        'Full terms and live obligation status for one contract. Look it up by contract id (from listContracts) or by contract type when the plant has one contract of that type. Never state terms that this tool did not return, and never present EXTRACTED (unreviewed) terms as agreed.',
      inputSchema: z.object({
        plantId: z.string().describe('Plant id or slug.'),
        contractId: z.string().optional().describe('Contract id from listContracts.'),
        contractType: z
          .enum(CONTRACT_TYPES)
          .optional()
          .describe('Alternative lookup: the contract type, when the id is unknown.'),
      }),
      execute: async ({ plantId, contractId, contractType }) => {
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('plant_not_found_or_no_access');
        const payload = await fetchContracts(plant.slug);
        if (!payload) return denied('contracts_unavailable');

        const contracts: { id: string; contractType: string }[] = payload.contracts ?? [];
        let match = contractId ? contracts.find((c) => c.id === contractId) : undefined;
        if (!match && contractType) {
          const ofType = contracts.filter((c) => c.contractType === contractType);
          if (ofType.length > 1) {
            return denied(
              'ambiguous_contract',
              `${ofType.length} ${contractType} contracts on file — pass contractId from listContracts.`
            );
          }
          match = ofType[0];
        }
        if (!match) return denied('contract_not_found');

        const rows = (payload.obligations?.obligations ?? []).filter(
          (o: { contract_id: string }) => o.contract_id === match!.id
        );
        return shapeContractDetailOutput(match as never, rows);
      },
    }),

    getWarrantyPosition: tool({
      description:
        'BESS warranty guardian position for a battery plant: health score, SoH vs the contractual capacity floor, cycle-budget consumption, projected floor crossing, open violations, and the latest capacity test. Backed by the weekly audit dossier. Use for "warranty position", "are we inside warranty", "battery health vs contract".',
      inputSchema: z.object({
        plantId: z.string().describe('BESS or hybrid plant id or slug.'),
      }),
      execute: async ({ plantId }) => {
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('plant_not_found_or_no_access');
        const dossier = await fetchAudit(plant.slug, 'dossier');
        if (!dossier) {
          return denied(
            'no_warranty_dossier',
            'No audit dossier artifact exists for this plant yet — the weekly bess-audit job has not covered it (BESS/hybrid plants with dispatch history only).'
          );
        }
        return shapeWarrantyPositionOutput(dossier);
      },
    }),

    getOptimizerAudit: tool({
      description:
        'Dispatch strategy benchmark for a battery plant: capture ratio vs a perfect-foresight optimum on the same day-ahead prices, revenue gap, and annualized gap. Use for "how good is our dispatch", "are we leaving revenue on the table", "optimizer performance". Always keep the perfect-foresight framing from the note.',
      inputSchema: z.object({
        plantId: z.string().describe('BESS or hybrid plant id or slug.'),
      }),
      execute: async ({ plantId }) => {
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('plant_not_found_or_no_access');
        const audit = await fetchAudit(plant.slug, 'optimizer');
        if (!audit) {
          return denied(
            'no_optimizer_audit',
            'No optimizer audit artifact exists for this plant yet — the weekly bess-audit job has not covered it.'
          );
        }
        return shapeOptimizerAuditOutput(audit);
      },
    }),
  };
}
