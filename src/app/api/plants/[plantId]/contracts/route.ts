import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { ContractType } from '@prisma/client';
import prisma from '@/libs/prisma';
import { requireOrg, requirePlantAccess, resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { readArtifact } from '@/lib/analysis/artifacts';
import { shapeContract } from '@/lib/contracts/shape';
import { fixtureContractsFor } from '@/fixtures/contracts';
import { parseFile } from '@/lib/ai/kb-ingest';
import { extractContractTerms } from '@/lib/ai/contract-extract';
import { putObject } from '@/lib/services/s3-objects';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120; // PDF parse + one Bedrock extraction call

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * GET /api/plants/[plantId]/contracts
 *
 * Contracts on file for a plant, plus the latest obligation-status artifact
 * (kind='contract_obligations', written hourly by the alert cron). DB-first;
 * fixture-only demo plants (no Plant row) serve in-code specimen contracts.
 * A real plant with zero contracts is a valid state and returns an empty
 * list, never fixtures.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const { plantId } = params;
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    if (!readAccess.plant) {
      return NextResponse.json({
        plantId,
        contracts: fixtureContractsFor(plantId),
        obligations: null,
        _source: 'fixture',
      });
    }

    const [rows, artifact] = await Promise.all([
      prisma.contract.findMany({
        where: { plant_id: readAccess.plant.id },
        include: { terms: { orderBy: { field: 'asc' } } },
        orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
      }),
      readArtifact(readAccess.plant.id, 'contract_obligations'),
    ]);

    return NextResponse.json({
      plantId: readAccess.plant.slug,
      contracts: rows.map((c) => shapeContract(c, readAccess.plant!.slug)),
      obligations: artifact
        ? { ...(artifact.payload as object), _generatedAt: artifact.generatedAt.toISOString() }
        : null,
      _source: 'database',
    });
  } catch (error) {
    console.error('Error in GET /api/plants/[plantId]/contracts:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/plants/[plantId]/contracts
 *
 * Upload a contract PDF: stores the binary to S3, extracts terms with the
 * closed-schema Bedrock extractor, and creates a DRAFT contract whose terms
 * await human review (EXTRACTED). Nothing is monitored until confirm.
 * MANAGE access; extraction sits behind the ai:copilot feature.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const access = await requirePlantAccess(orgResult.ctx, params.plantId, 'MANAGE');
    if (!access.ok) return access.response;
    const gate = await requireFeature(orgResult.ctx.authOrgId, 'ai:copilot');
    if (gate) return gate;
    const plant = access.plant;

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: 'invalid_multipart_payload' }, { status: 400 });
    }

    const file = formData.get('file');
    if (!(file instanceof Blob) || !('name' in file)) {
      return NextResponse.json({ error: 'no_file_uploaded' }, { status: 400 });
    }
    const named = file as File;
    if (named.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: 'file_too_large_max_25mb' }, { status: 413 });
    }
    if (!named.name.toLowerCase().endsWith('.pdf')) {
      return NextResponse.json({ error: 'only_pdf_contracts_supported' }, { status: 415 });
    }

    const typeRaw = (formData.get('contract_type') as string | null) ?? '';
    if (!Object.values(ContractType).includes(typeRaw as ContractType)) {
      return NextResponse.json(
        { error: 'invalid_contract_type', allowed: Object.values(ContractType) },
        { status: 400 }
      );
    }
    const contractType = typeRaw as ContractType;

    const bessAssetId = (formData.get('bess_asset_id') as string | null) || null;
    if (bessAssetId) {
      const asset = await prisma.bessAsset.findFirst({
        where: { id: bessAssetId, plant_id: plant.id },
      });
      if (!asset) {
        return NextResponse.json({ error: 'bess_asset_not_found' }, { status: 404 });
      }
    }

    const buffer = Buffer.from(await named.arrayBuffer());
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    const duplicate = await prisma.contract.findFirst({
      where: { plant_id: plant.id, source_sha256: sha256 },
    });
    if (duplicate) {
      return NextResponse.json(
        { error: 'duplicate_document', contractId: duplicate.id },
        { status: 409 }
      );
    }

    let text = '';
    try {
      text = await parseFile(buffer, 'pdf');
    } catch (e) {
      console.error('contracts upload: pdf parse failed', e);
    }
    if (text.replace(/\s+/g, ' ').trim().length < 50) {
      // Honest failure for scanned/image-only PDFs — no OCR in v1.
      return NextResponse.json(
        {
          error: 'no_extractable_text',
          detail:
            'This PDF has no machine-readable text (likely a scan). OCR is not supported yet.',
        },
        { status: 422 }
      );
    }

    // Persist the source document; the claim-grade story needs the original
    // binary, but a storage outage should not block term extraction.
    const s3Key = `contracts/${plant.slug}/${sha256}.pdf`;
    let storedDocument = true;
    try {
      await putObject(s3Key, buffer, 'application/pdf');
    } catch (e) {
      console.error('contracts upload: S3 put failed', e);
      storedDocument = false;
    }

    const extraction = await extractContractTerms(text, contractType);

    const title =
      (formData.get('title') as string | null)?.trim() || named.name.replace(/\.pdf$/i, '');
    const counterparty =
      (formData.get('counterparty') as string | null)?.trim() || extraction.counterparty;

    const contract = await prisma.contract.create({
      data: {
        plant_id: plant.id,
        org_clerk_id: orgResult.ctx.authOrgId,
        contract_type: contractType,
        title,
        counterparty,
        status: 'DRAFT',
        effective_from: extraction.effective_from ? new Date(extraction.effective_from) : null,
        effective_to: extraction.effective_to ? new Date(extraction.effective_to) : null,
        source_s3_key: storedDocument ? s3Key : null,
        source_sha256: sha256,
        bess_asset_id: bessAssetId,
        extraction_model: extraction.model_id,
        extracted_at: new Date(),
        created_by_clerk_id: orgResult.ctx.userId,
        terms: {
          create: extraction.terms.map((t) => ({
            field: t.field,
            value_numeric: t.value_numeric,
            unit: t.unit,
            value_text: t.value_text,
            confidence: t.confidence,
            source_excerpt: t.source_excerpt,
            is_explicit: t.is_explicit,
            status: 'EXTRACTED' as const,
            monitored: false,
          })),
        },
      },
      include: { terms: { orderBy: { field: 'asc' } } },
    });

    return NextResponse.json(
      {
        contract: shapeContract(contract, plant.slug),
        extraction: {
          termCount: extraction.terms.length,
          rejectedCount: extraction.rejected_count,
          model: extraction.model_id,
          storedDocument,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error in POST /api/plants/[plantId]/contracts:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
