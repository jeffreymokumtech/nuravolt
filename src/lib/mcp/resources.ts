import prisma from '@/libs/prisma';
import type { ChatAccessContext } from '@/lib/ai/access-control';
import { resolvePlantOrDeny } from '@/lib/ai/access-control';
import { querySoilingForecastPoints } from '@/lib/db/timeseries';

/**
 * MCP resource assemblers. Resources are read-only content the host AI can
 * attach to its context without spending a tool call. Format is markdown so
 * both frontier models and smaller ones can parse them cheaply.
 */

// ─────────────────────────────────────────────────────────────────────────
// Plant overview
// ─────────────────────────────────────────────────────────────────────────

export async function listPlantOverviewResources(ctx: ChatAccessContext) {
  return ctx.plants.map((p) => ({
    uri: `nuravolt://plant/${p.slug}/overview.md`,
    name: `${p.name} — overview`,
    description: `${p.asset_type} plant, ${p.capacity_mw ?? '—'} MW, ${p.location_name ?? p.country ?? 'unknown'}. Auto-generated overview.`,
    mimeType: 'text/markdown',
  }));
}

export async function readPlantOverview(
  ctx: ChatAccessContext,
  plantKey: string,
): Promise<string> {
  const plant = resolvePlantOrDeny(ctx, plantKey);
  if (!plant) {
    return `# Access denied\n\nNo access to plant "${plantKey}" with this API key.`;
  }

  const [openTickets, criticalTickets, latestForecast] = await Promise.all([
    prisma.ticket.count({
      where: {
        org_clerk_id: ctx.orgClerkId,
        plant_id: plant.id,
        status: { in: ['NEW', 'VALIDATED', 'ASSIGNED', 'IN_PROGRESS'] },
      },
    }),
    prisma.ticket.count({
      where: {
        org_clerk_id: ctx.orgClerkId,
        plant_id: plant.id,
        priority: 'CRITICAL',
        status: { in: ['NEW', 'VALIDATED', 'ASSIGNED', 'IN_PROGRESS'] },
      },
    }),
    // analysis_results is the canonical soiling store; the Prisma
    // SoilingForecast table has no writer and would always read empty.
    querySoilingForecastPoints(plant.id, 7)
      .then((points) => points[0] ?? null)
      .catch(() => null),
  ]);

  const capacity = plant.capacity_mw != null ? `${plant.capacity_mw} MW` : 'unspecified capacity';
  const location = plant.location_name ?? plant.country ?? 'unspecified location';
  const forecastLine = latestForecast
    ? `- **Latest soiling ratio (${latestForecast.date}):** ${
        latestForecast.soiling_ratio != null
          ? Number(latestForecast.soiling_ratio).toFixed(3)
          : '—'
      }${latestForecast.is_cleaning_needed ? ' · **cleaning recommended**' : ''}`
    : '- **Latest soiling ratio:** no forecast available yet.';

  return [
    `# ${plant.name}`,
    '',
    `${plant.asset_type} · ${capacity} · ${location}`,
    '',
    '## At a glance',
    `- **Slug:** \`${plant.slug}\``,
    `- **Asset type:** ${plant.asset_type}`,
    `- **Status:** ${plant.status}`,
    `- **Capacity:** ${capacity}`,
    `- **Open tickets:** ${openTickets} (${criticalTickets} critical)`,
    forecastLine,
    '',
    '## Suggested next questions',
    `- What's the 30-day soiling forecast for ${plant.slug}?`,
    `- Which inverters at ${plant.slug} are underperforming right now?`,
    `- List the ${criticalTickets > 0 ? 'critical' : 'open'} tickets at ${plant.slug}.`,
    '',
    `_Auto-generated from live NuraVolt data at ${new Date().toISOString()}._`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Knowledge base document
// ─────────────────────────────────────────────────────────────────────────

export async function listKBResources(orgClerkId: string) {
  const docs = await prisma.kBDocument.findMany({
    where: {
      org_clerk_id: orgClerkId,
      processing_status: 'completed',
    },
    orderBy: { created_at: 'desc' },
    take: 200,
    select: {
      id: true,
      title: true,
      file_name: true,
      equipment_type: true,
      manufacturer: true,
      model_number: true,
    },
  });
  return docs.map((d) => ({
    uri: `nuravolt://kb/${d.id}`,
    name: d.title,
    description: [
      d.file_name,
      d.equipment_type,
      d.manufacturer,
      d.model_number,
    ]
      .filter(Boolean)
      .join(' · '),
    mimeType: 'text/markdown',
  }));
}

export async function readKBDocument(
  orgClerkId: string,
  documentId: string,
): Promise<string> {
  const doc = await prisma.kBDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      title: true,
      file_name: true,
      org_clerk_id: true,
      manufacturer: true,
      model_number: true,
      equipment_type: true,
    },
  });
  if (!doc || doc.org_clerk_id !== orgClerkId) {
    return `# Access denied\n\nDocument ${documentId} is not accessible with this API key.`;
  }

  const chunks = await prisma.kBChunk.findMany({
    where: { document_id: doc.id },
    orderBy: { chunk_index: 'asc' },
    select: { chunk_index: true, section_title: true, content: true },
  });

  const meta = [
    doc.equipment_type ? `**Equipment type:** ${doc.equipment_type}` : null,
    doc.manufacturer ? `**Manufacturer:** ${doc.manufacturer}` : null,
    doc.model_number ? `**Model:** ${doc.model_number}` : null,
    `**File:** \`${doc.file_name}\``,
  ]
    .filter(Boolean)
    .join(' · ');

  const body = chunks
    .map((c) =>
      c.section_title
        ? `## ${c.section_title}\n\n${c.content.trim()}`
        : c.content.trim(),
    )
    .join('\n\n');

  return `# ${doc.title}\n\n${meta}\n\n---\n\n${body}`;
}
