import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { DataFieldType } from '@prisma/client';
import { extractRegisterMap } from '@/lib/ai/register-map-llm';
import {
  VALID_FIELD_TYPES,
  buildRegisterPersistenceRows,
} from '@/lib/ai/register-map-schema';
import { requireOrg, type OrgContext, hasOrgManageRole, forbidden } from '@/lib/api/tenant';

/** Caller owns the connection; demo identity may also see legacy demo rows. */
function ownsConnection(
  ctx: OrgContext,
  connection: { organization_id: string | null; customer_id: string },
): boolean {
  return (
    connection.organization_id === ctx.org.id ||
    (ctx.isDemo && connection.customer_id === 'demo_customer')
  );
}

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB — generous for datasheet PDFs

/**
 * POST /api/connections/[connectionId]/register-map
 *
 * AI Modbus register-map auto-mapper. Accepts either:
 *   - multipart/form-data with a `file` part (PDF datasheet or CSV/TSV/txt
 *     register export) and optional `vendor_hint` field, or
 *   - JSON `{ "text": "...", "vendorHint": "sma" }`.
 *
 * PDF -> pdf-parse -> text -> extractRegisterMap (deterministic CSV fast
 * path, LLM fallback). Persists a DataStructureAnalysis (full register map
 * JSON in sample_data) and FieldMapping upserts (original_field scoped as
 * `modbus.<name>`, auto-confirm at confidence >= 0.85 — same rule as
 * discover/route.ts). Returns the extracted map + persistence counts.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    if (!hasOrgManageRole(ctx)) return forbidden('org_manage_role_required');

    const { connectionId } = await params;

    const connection = await prisma.dataConnection.findUnique({
      where: {
        id: connectionId,
      },
    });

    if (!connection || !ownsConnection(ctx, connection)) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    // ── Resolve source text (multipart file or JSON text) ──
    let sourceText = '';
    let vendorHint: string | undefined;
    let sourceLabel = 'text';

    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: 'Multipart upload must include a "file" part' },
          { status: 400 }
        );
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: `File too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB)` },
          { status: 413 }
        );
      }
      const hint = form.get('vendor_hint');
      if (typeof hint === 'string' && hint.trim()) vendorHint = hint.trim();

      const buffer = Buffer.from(await file.arrayBuffer());
      const isPdf =
        file.type === 'application/pdf' ||
        /\.pdf$/i.test(file.name || '') ||
        buffer.subarray(0, 5).toString('latin1') === '%PDF-';

      if (isPdf) {
        // pdf-parse's root index.js runs a self-test when `module.parent` is
        // null, which crashes under bundled/dynamic-import paths. Importing
        // the inner file bypasses the debug guard (same as kb-ingest.ts).
        const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default as (
          b: Buffer
        ) => Promise<{ text: string }>;
        const parsed = await pdfParse(buffer);
        sourceText = parsed.text;
        sourceLabel = `pdf:${file.name || 'upload.pdf'}`;
      } else {
        sourceText = buffer.toString('utf8');
        sourceLabel = `file:${file.name || 'upload.txt'}`;
      }
    } else {
      const body = await request.json().catch((): null => null);
      if (!body || typeof body.text !== 'string' || !body.text.trim()) {
        return NextResponse.json(
          { error: 'Provide a multipart file upload or JSON {"text": "..."}' },
          { status: 400 }
        );
      }
      sourceText = body.text;
      if (typeof body.vendorHint === 'string' && body.vendorHint.trim()) {
        vendorHint = body.vendorHint.trim();
      }
    }

    // Default the vendor hint from the connection's Modbus preset
    if (!vendorHint) {
      const config = (connection.config ?? {}) as Record<string, any>;
      const preset = config.manufacturer_preset;
      if (typeof preset === 'string' && preset && preset !== 'generic') {
        vendorHint = preset;
      }
    }

    // ── Extract ──
    const registerMap = await extractRegisterMap(sourceText, { vendorHint });

    // ── Persist FieldMapping rows (skip 'unmapped', like discover/route.ts) ──
    const plan = buildRegisterPersistenceRows(registerMap.registers);
    let upserted = 0;
    for (const row of plan) {
      if (!row.persisted) continue;
      await prisma.fieldMapping.upsert({
        where: {
          connection_id_original_field: {
            connection_id: connectionId,
            original_field: row.original_field,
          },
        },
        create: {
          connection_id: connectionId,
          original_field: row.original_field,
          mapped_field: row.mapped_field as DataFieldType,
          field_path: row.field_path,
          unit: row.unit,
          scaling_factor: row.scaling_factor,
          offset: 0.0,
          confidence_score: row.confidence_score,
          is_confirmed: row.is_confirmed, // auto-confirm at >= 0.85
        },
        update: {
          mapped_field: row.mapped_field as DataFieldType,
          field_path: row.field_path,
          unit: row.unit,
          scaling_factor: row.scaling_factor,
          confidence_score: row.confidence_score,
        },
      });
      upserted++;
    }

    // ── Persist DataStructureAnalysis (full register map in sample_data) ──
    if (registerMap.registers.length > 0) {
      const vendorLabel = registerMap.vendor
        ? ` (${registerMap.vendor}${registerMap.model ? ` ${registerMap.model}` : ''})`
        : '';
      const structureData = {
        data_format: 'long',
        total_columns: registerMap.registers.length,
        numeric_columns: registerMap.registers.length,
        string_columns: 0,
        datetime_columns: 0,
        hierarchy_pattern: `Modbus register map${vendorLabel}`,
        column_statistics: registerMap.registers.map(r => ({
          name: r.name,
          type: 'numeric',
          nullRate: 0,
          uniqueCount: 0,
        })),
        sample_data: {
          register_map: registerMap,
          source: sourceLabel,
          extracted_at: new Date().toISOString(),
        } as any,
      };
      await prisma.dataStructureAnalysis.upsert({
        where: { connection_id: connectionId },
        create: { connection_id: connectionId, ...structureData },
        update: { ...structureData, analyzed_at: new Date() },
      });
    }

    const unmapped = plan.filter(r => !r.persisted).length;
    const autoConfirmed = plan.filter(r => r.is_confirmed).length;

    // ── Audit ──
    await prisma.connectionAudit.create({
      data: {
        connection_id: connectionId,
        action: 'register_map_extracted',
        user_id: ctx.userId,
        success: true,
        new_values: {
          source: sourceLabel,
          method: registerMap.method,
          registers: registerMap.registers.length,
          fieldMappingsUpserted: upserted,
          unmapped,
          autoConfirmed,
        },
      },
    });

    return NextResponse.json({
      data: {
        registerMap,
        // Persistence plan (incl. unmapped rows) so the UI can PATCH rows
        // using the exact original_field keys the server generated.
        rows: plan,
        persistence: {
          fieldMappingsUpserted: upserted,
          unmapped,
          autoConfirmed,
        },
      },
    });
  } catch (error) {
    console.error('Error extracting register map:', error);
    return NextResponse.json(
      { error: 'Failed to extract register map' },
      { status: 500 }
    );
  }
}

interface PatchMappingBody {
  original_field: string;
  mapped_field: string;
  unit?: string;
  scaling_factor?: number;
  field_path?: string;
  is_confirmed?: boolean;
}

/**
 * PATCH /api/connections/[connectionId]/register-map
 *
 * Row-level accept/override from the register-map review table. Manual edits
 * get confidence 1.0 and are confirmed by default (same semantics as the
 * mappings route's manual updates).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    if (!hasOrgManageRole(ctx)) return forbidden('org_manage_role_required');

    const { connectionId } = await params;

    const connection = await prisma.dataConnection.findUnique({
      where: {
        id: connectionId,
      },
    });

    if (!connection || !ownsConnection(ctx, connection)) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    const body = (await request.json().catch((): null => null)) as PatchMappingBody | null;
    if (!body || typeof body.original_field !== 'string' || !body.original_field.trim()) {
      return NextResponse.json({ error: 'original_field is required' }, { status: 400 });
    }
    if (typeof body.mapped_field !== 'string' || !VALID_FIELD_TYPES.includes(body.mapped_field)) {
      return NextResponse.json(
        { error: `Invalid field type: ${body.mapped_field}` },
        { status: 400 }
      );
    }

    const scalingFactor =
      body.scaling_factor !== undefined && Number.isFinite(Number(body.scaling_factor))
        ? Number(body.scaling_factor)
        : undefined;
    const unit = typeof body.unit === 'string' && body.unit.trim() ? body.unit.trim() : undefined;
    const fieldPath =
      typeof body.field_path === 'string' && body.field_path.trim()
        ? body.field_path.trim()
        : undefined;

    const mapping = await prisma.fieldMapping.upsert({
      where: {
        connection_id_original_field: {
          connection_id: connectionId,
          original_field: body.original_field,
        },
      },
      create: {
        connection_id: connectionId,
        original_field: body.original_field,
        mapped_field: body.mapped_field as DataFieldType,
        field_path: fieldPath,
        unit,
        scaling_factor: scalingFactor ?? 1.0,
        offset: 0.0,
        confidence_score: 1.0, // manual mappings get full confidence
        is_confirmed: body.is_confirmed ?? true,
      },
      update: {
        mapped_field: body.mapped_field as DataFieldType,
        ...(fieldPath !== undefined ? { field_path: fieldPath } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(scalingFactor !== undefined ? { scaling_factor: scalingFactor } : {}),
        confidence_score: 1.0,
        is_confirmed: body.is_confirmed ?? true,
      },
    });

    await prisma.connectionAudit.create({
      data: {
        connection_id: connectionId,
        action: 'register_mapping_updated',
        user_id: ctx.userId,
        success: true,
        new_values: {
          original_field: mapping.original_field,
          mapped_field: mapping.mapped_field,
          is_confirmed: mapping.is_confirmed,
        },
      },
    });

    return NextResponse.json({
      data: {
        id: mapping.id,
        original_field: mapping.original_field,
        mapped_field: mapping.mapped_field,
        field_path: mapping.field_path,
        unit: mapping.unit,
        scaling_factor: Number(mapping.scaling_factor),
        confidence_score: Number(mapping.confidence_score),
        is_confirmed: mapping.is_confirmed,
      },
    });
  } catch (error) {
    console.error('Error updating register mapping:', error);
    return NextResponse.json(
      { error: 'Failed to update register mapping' },
      { status: 500 }
    );
  }
}
