import prisma from '@/libs/prisma';
import { embedText, vectorLiteral } from '@/lib/ai/embeddings';

export interface KBSearchResult {
  chunk_id: string;
  document_id: string;
  document_title: string;
  file_name: string;
  chunk_index: number;
  content: string;
  similarity: number;
  manufacturer: string | null;
  model_number: string | null;
  source_url: string | null;
}

export interface KBEquipmentFilter {
  manufacturer?: string | null;
  /** Matched loosely (ILIKE both ways) — vendor model strings vary in punctuation. */
  model?: string | null;
  equipmentType?: string | null;
}

/**
 * Vector similarity search over KB chunks. Uses cosine distance
 * (1 - similarity) so we can return a 0..1 similarity score.
 *
 * Scope: the org's own documents PLUS global documents
 * (org_clerk_id IS NULL — shared vendor manuals every org may read).
 * Optional narrowing by plant and by equipment identity, so the alert
 * engine can ask "what does the manual for THIS inverter model say".
 */
export async function searchKB(args: {
  orgClerkId: string;
  query: string;
  limit?: number;
  plantId?: string | null;
  equipment?: KBEquipmentFilter | null;
}): Promise<KBSearchResult[]> {
  const limit = Math.max(1, Math.min(args.limit ?? 5, 20));
  const vec = await embedText(args.query);

  const params: any[] = [vectorLiteral(vec), args.orgClerkId];
  const filters: string[] = [];

  // Note: filtering by plant_id includes chunks from documents either
  // explicitly tagged to this plant OR untagged (plant_id IS NULL).
  if (args.plantId) {
    params.push(args.plantId);
    filters.push(`AND (d.plant_id = $${params.length} OR d.plant_id IS NULL)`);
  }

  // Equipment narrowing: a document matches when its identity columns are
  // compatible — either the column is unset (generic doc) or it matches
  // loosely. Model strings differ in punctuation/casing across vendors and
  // fleets, so both sides are wrapped in wildcards.
  const eq = args.equipment;
  if (eq?.manufacturer) {
    params.push(`%${eq.manufacturer.trim()}%`);
    filters.push(
      `AND (d.manufacturer IS NULL OR d.manufacturer ILIKE $${params.length})`
    );
  }
  if (eq?.model) {
    // Compare with punctuation stripped on both sides.
    params.push(`%${eq.model.trim().replace(/[^a-zA-Z0-9]+/g, '%')}%`);
    filters.push(
      `AND (d.model_number IS NULL OR regexp_replace(d.model_number, '[^a-zA-Z0-9]+', '%', 'g') ILIKE $${params.length} OR d.model_number ILIKE $${params.length})`
    );
  }
  if (eq?.equipmentType) {
    params.push(eq.equipmentType.trim());
    filters.push(
      `AND (d.equipment_type IS NULL OR d.equipment_type = $${params.length})`
    );
  }

  const sql = `
    SELECT
      c.id AS chunk_id,
      d.id AS document_id,
      d.title AS document_title,
      d.file_name,
      c.chunk_index,
      c.content,
      1 - (c.embedding <=> $1::vector) AS similarity,
      d.manufacturer,
      d.model_number,
      d.source_url
    FROM "KBChunk" c
    JOIN "KBDocument" d ON d.id = c.document_id
    WHERE (d.org_clerk_id = $2 OR d.org_clerk_id IS NULL)
      AND d.processing_status = 'completed'
      AND c.embedding IS NOT NULL
      ${filters.join('\n      ')}
    ORDER BY c.embedding <=> $1::vector
    LIMIT ${limit}
  `;

  const rows = await prisma.$queryRawUnsafe<KBSearchResult[]>(sql, ...params);
  return rows;
}
