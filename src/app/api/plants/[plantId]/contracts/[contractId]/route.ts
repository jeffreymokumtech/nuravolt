import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg, requirePlantAccess, resolvePlantForRead } from '@/lib/api/tenant';
import { shapeContract } from '@/lib/contracts/shape';
import { fixtureContractsFor } from '@/fixtures/contracts';

export const dynamic = 'force-dynamic';

/**
 * GET /api/plants/[plantId]/contracts/[contractId]
 *
 * Single contract with its full term list (values, confidence, source
 * excerpts). Same access rules as the list route.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string; contractId: string } }
) {
  try {
    const { plantId, contractId } = params;
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    if (!readAccess.plant) {
      const fixture = fixtureContractsFor(plantId).find((c) => c.id === contractId);
      if (!fixture) {
        return NextResponse.json({ error: 'contract_not_found' }, { status: 404 });
      }
      return NextResponse.json({ contract: fixture, _source: 'fixture' });
    }

    const row = await prisma.contract.findFirst({
      where: { id: contractId, plant_id: readAccess.plant.id },
      include: { terms: { orderBy: { field: 'asc' } } },
    });
    if (!row) {
      return NextResponse.json({ error: 'contract_not_found' }, { status: 404 });
    }
    return NextResponse.json({
      contract: shapeContract(row, readAccess.plant.slug),
      _source: 'database',
    });
  } catch (error) {
    console.error('Error in GET /api/plants/[plantId]/contracts/[contractId]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

const PATCHABLE_STATUS = ['ACTIVE', 'EXPIRED', 'ARCHIVED'] as const;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** PATCH: metadata edits (title, counterparty, status, effective window). */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { plantId: string; contractId: string } }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const access = await requirePlantAccess(orgResult.ctx, params.plantId, 'MANAGE');
    if (!access.ok) return access.response;

    const existing = await prisma.contract.findFirst({
      where: { id: params.contractId, plant_id: access.plant.id },
    });
    if (!existing) {
      return NextResponse.json({ error: 'contract_not_found' }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }

    const data: Record<string, unknown> = {};
    if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim();
    if (typeof body.counterparty === 'string') data.counterparty = body.counterparty.trim() || null;
    if (typeof body.status === 'string' && (PATCHABLE_STATUS as readonly string[]).includes(body.status)) {
      data.status = body.status;
    }
    if (typeof body.effective_from === 'string' && ISO_DAY.test(body.effective_from)) {
      data.effective_from = new Date(body.effective_from);
    }
    if (typeof body.effective_to === 'string' && ISO_DAY.test(body.effective_to)) {
      data.effective_to = new Date(body.effective_to);
    }
    if (!Object.keys(data).length) {
      return NextResponse.json({ error: 'no_valid_fields' }, { status: 400 });
    }

    const updated = await prisma.contract.update({
      where: { id: existing.id },
      data,
      include: { terms: { orderBy: { field: 'asc' } } },
    });
    return NextResponse.json({ contract: shapeContract(updated, access.plant.slug) });
  } catch (error) {
    console.error('Error in PATCH /contracts/[contractId]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** DELETE: remove the contract row (terms cascade). The S3 source object and
 * any KB document are left in place — deletion of evidence is deliberate-only. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { plantId: string; contractId: string } }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const access = await requirePlantAccess(orgResult.ctx, params.plantId, 'MANAGE');
    if (!access.ok) return access.response;

    const existing = await prisma.contract.findFirst({
      where: { id: params.contractId, plant_id: access.plant.id },
    });
    if (!existing) {
      return NextResponse.json({ error: 'contract_not_found' }, { status: 404 });
    }
    await prisma.contract.delete({ where: { id: existing.id } });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error('Error in DELETE /contracts/[contractId]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
