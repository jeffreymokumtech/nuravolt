import {
  assistantMsg,
  textPart,
  toolPart,
  userMsg,
  type DemoThread,
} from './types';
import type { ToolPlantRef } from '@/lib/ai/tool-shapes';

/**
 * Manuals example session: Shams grounding an answer in the shared knowledge
 * base. The excerpts below are VERBATIM slices of the shipped seed manual
 * (public/data/manuals/seed/synthetic/soiling-cleaning-sop.md) — the
 * contract test asserts they still exist in the file, so drift fails loudly.
 */

export const SOP_TITLE = 'Soiling and module cleaning: standard operating procedure';

export const SOP_EXCERPT_ROI =
  'Trigger cleaning when `roi ≥ 2.0`. Adjust the threshold upward in regions\nwith high dust deposition cycles, downward in regions with stable soiling.';

export const SOP_EXCERPT_WATER =
  'Always rinse with demineralised water (conductivity <50 µS/cm). Tap water\nleaves mineral residue that re-soils within days.';

export function buildManualsThread(args: {
  plant: ToolPlantRef;
  surface: 'demo' | 'showcase';
}): DemoThread {
  const { plant, surface } = args;

  const kbOutput = {
    count: 2,
    results: [
      {
        document_title: SOP_TITLE,
        file_name: 'soiling-cleaning-sop.md',
        chunk_index: 1,
        excerpt: SOP_EXCERPT_ROI,
      },
      {
        document_title: SOP_TITLE,
        file_name: 'soiling-cleaning-sop.md',
        chunk_index: 2,
        excerpt: SOP_EXCERPT_WATER,
      },
    ],
  };

  return {
    id: `${plant.slug}-manuals-sop`,
    title: 'What does the cleaning SOP say?',
    prompt: 'When is cleaning actually worth it according to our SOP?',
    plantSlug: plant.slug,
    plantName: plant.name,
    surface,
    messages: [
      userMsg('When is cleaning actually worth it according to our SOP?'),
      assistantMsg([
        textPart(`Let me check the knowledge base.`),
        toolPart(
          'searchKnowledgeBase',
          { query: 'cleaning SOP when is cleaning justified ROI threshold', limit: 3 },
          kbOutput
        ),
        textPart(
          `Your cleaning SOP [[cite:kb|title=${SOP_TITLE}|chunk=1]] is specific about this. Cleaning is triggered when the expected 30 day revenue recovery is at least twice the cleaning cost, in the SOP's own words: "Trigger cleaning when roi is at least 2.0. Adjust the threshold upward in regions with high dust deposition cycles, downward in regions with stable soiling."\n\nOne execution detail worth repeating to the crew [[cite:kb|title=${SOP_TITLE}|chunk=2]]: "Always rinse with demineralised water (conductivity below 50 microsiemens per cm). Tap water leaves mineral residue that re-soils within days."\n\nSo before booking a clean, I would check the current soiling forecast against that 2x threshold. Want me to run it for ${plant.name}?`
        ),
      ]),
    ],
  };
}
