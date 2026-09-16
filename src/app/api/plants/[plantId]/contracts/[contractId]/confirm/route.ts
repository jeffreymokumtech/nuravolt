import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg, requirePlantAccess } from '@/lib/api/tenant';
import { shapeContract } from '@/lib/contracts/shape';
import { termFieldDef } from '@/lib/contracts/term-fields';
import { syncContractToBessWarrantyTerms } from '@/lib/contracts/bess-sync';
import { ingestKBDocument } from '@/lib/ai/kb-ingest';
import { getObjectBuffer } from '@/lib/services/s3-objects';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300; // KB ingest embeds chunk-by-chunk

interface ConfirmTermInput {
  field: string;
  status: 'CONFIRMED' | 'REJECTED';
  value_numeric?: number | null;
  value_text?: string | null;
  unit?: string | null;
}

interface ConfirmBody {
  title?: string;
  counterparty?: string;
  effective_from?: string;
  effective_to?: string;
  terms?: ConfirmTermInput[];
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /api/plants/[plantId]/contracts/[contractId]/confirm
 *
 * Human review of extracted terms: the client sends the final per-field
 * verdicts (confirm/reject, optionally edited values). Edited values lose
 * their extraction provenance (confidence + excerpt nulled) — the review
 * screen must never present a human edit as a model quote. Confirming
 * activates the contract, flips monitorable fields on, one-way syncs
 * BESS_WARRANTY terms into BessWarrantyTerms, and ingests the source PDF
 * into the knowledge base so Shams can cite the contract text.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { plantId: string; contractId: string } }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const access = await requirePlantAccess(orgResult.ctx, params.plantId, 'MANAGE');
    if (!access.ok) return access.response;
    const plant = access.plant;

    const contract = await prisma.contract.findFirst({
      where: { id: params.contractId, plant_id: plant.id },
      include: { terms: true },
    });
    if (!contract) {
      return NextResponse.json({ error: 'contract_not_found' }, { status: 404 });
    }

    let body: ConfirmBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }

    const now = new Date();
    const byField = new Map(contract.terms.map((t) => [t.field, t]));

    for (const input of body.terms ?? []) {
      if (!input?.field || (input.status !== 'CONFIRMED' && input.status !== 'REJECTED')) {
        continue;
      }
      const def = termFieldDef(contract.contract_type, input.field);
      if (!def) continue; // outside the closed vocabulary

      const existing = byField.get(input.field);
      const monitored = input.status === 'CONFIRMED' && (def.monitorable ?? false);

      if (!existing) {
        // Manually added in review — no extraction provenance.
        await prisma.contractTerm.create({
          data: {
            contract_id: contract.id,
            field: input.field,
            value_numeric: input.value_numeric ?? null,
            unit: input.unit ?? def.unit ?? null,
            value_text: input.value_text ?? null,
            confidence: null,
            source_excerpt: null,
            is_explicit: true,
            status: input.status,
            monitored,
            confirmed_by_clerk_id: orgResult.ctx.userId,
            confirmed_at: now,
          },
        });
        continue;
      }

      const numericEdited =
        input.value_numeric !== undefined &&
        Number(input.value_numeric) !== (existing.value_numeric == null ? null : Number(existing.value_numeric));
      const textEdited =
        input.value_text !== undefined && input.value_text !== existing.value_text;
      const edited = numericEdited || textEdited;

      await prisma.contractTerm.update({
        where: { id: existing.id },
        data: {
          value_numeric:
            input.value_numeric !== undefined ? input.value_numeric : existing.value_numeric,
          value_text: input.value_text !== undefined ? input.value_text : existing.value_text,
          unit: input.unit !== undefined ? input.unit : existing.unit,
          ...(edited ? { confidence: null, source_excerpt: null } : {}),
          status: input.status,
          monitored,
          confirmed_by_clerk_id: orgResult.ctx.userId,
          confirmed_at: now,
        },
      });
    }

    const updated = await prisma.contract.update({
      where: { id: contract.id },
      data: {
        status: 'ACTIVE',
        ...(body.title?.trim() ? { title: body.title.trim() } : {}),
        ...(body.counterparty?.trim() ? { counterparty: body.counterparty.trim() } : {}),
        ...(body.effective_from && ISO_DAY.test(body.effective_from)
          ? { effective_from: new Date(body.effective_from) }
          : {}),
        ...(body.effective_to && ISO_DAY.test(body.effective_to)
          ? { effective_to: new Date(body.effective_to) }
          : {}),
      },
      include: { terms: { orderBy: { field: 'asc' } } },
    });

    // One-way sync into the BESS guardian's numeric source of truth.
    let bessSync: Awaited<ReturnType<typeof syncContractToBessWarrantyTerms>> | null = null;
    if (updated.contract_type === 'BESS_WARRANTY' && updated.bess_asset_id) {
      bessSync = await syncContractToBessWarrantyTerms(prisma, {
        id: updated.id,
        bess_asset_id: updated.bess_asset_id,
        effective_from: updated.effective_from,
        terms: updated.terms.map((t) => ({
          field: t.field,
          value_numeric: t.value_numeric == null ? null : Number(t.value_numeric),
          status: t.status,
        })),
      });
    }

    // KB ingest so contract text is citeable in chat. equipment_type
    // 'contract' keeps it filterable out of equipment-manual searches.
    let kbIngested = false;
    if (updated.source_s3_key && !updated.kb_document_id) {
      try {
        const buffer = await getObjectBuffer(updated.source_s3_key);
        const result = await ingestKBDocument({
          orgClerkId: orgResult.ctx.authOrgId,
          uploadedBy: orgResult.ctx.userId,
          title: `${updated.title} (contract)`,
          fileName: updated.source_s3_key.split('/').pop() ?? 'contract.pdf',
          fileType: 'pdf',
          buffer,
          plantId: plant.id,
          equipmentType: 'contract',
          manufacturer: updated.counterparty,
          modelNumber: null,
        });
        await prisma.contract.update({
          where: { id: updated.id },
          data: { kb_document_id: result.document.id },
        });
        kbIngested = true;
      } catch (e) {
        console.error('contract confirm: KB ingest failed (non-fatal)', e);
      }
    }

    const fresh = await prisma.contract.findUnique({
      where: { id: updated.id },
      include: { terms: { orderBy: { field: 'asc' } } },
    });
    return NextResponse.json({
      contract: shapeContract(fresh!, plant.slug),
      bessSync: bessSync
        ? { synced: bessSync.synced, applied: bessSync.applied, skipped: bessSync.skipped, reason: bessSync.reason ?? null }
        : null,
      kbIngested,
    });
  } catch (error) {
    console.error('Error in POST /contracts/[contractId]/confirm:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
