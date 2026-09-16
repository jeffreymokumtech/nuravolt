import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { BessAsset } from '@prisma/client';
import type { BessAssetsListResponse, BessAssetInfo } from '@/types/bess';
import { bessFixtureSubdir } from '@/app/api/bess/_showcase';
import { resolvePlantForRead } from '@/lib/api/tenant';
import prisma from '@/libs/prisma';

/** Map a BessAsset DB row into the camelCase API shape. */
function dbAssetToInfo(a: BessAsset): BessAssetInfo {
  return {
    id: a.id,
    plantId: a.plant_id,
    externalAssetId: a.external_asset_id,
    name: a.name,
    chemistry: a.chemistry as BessAssetInfo['chemistry'],
    nominalCapacityKwh: Number(a.nominal_capacity_kwh),
    nominalPowerKw: Number(a.nominal_power_kw),
    moduleCount: a.module_count,
    rackCount: a.rack_count,
    installationDate: a.installation_date
      ? a.installation_date.toISOString().slice(0, 10)
      : null,
    manufacturer: a.manufacturer,
    model: a.model,
    serialNumber: a.serial_number,
    currentSoh: a.current_soh == null ? null : Number(a.current_soh),
    currentSoc: a.current_soc == null ? null : Number(a.current_soc),
    lastCapacityTest: a.last_capacity_test
      ? a.last_capacity_test.toISOString()
      : null,
    lastUpdated: (a.last_updated ?? a.updated_at).toISOString(),
    enabled: a.enabled,
  };
}

/**
 * GET /api/bess/plants/[plantId]
 *
 * Returns list of BESS assets for a plant.
 * DB-first: plants with BessAsset rows are served from Postgres; the static
 * fixture JSON remains the fallback for demo/showcase slugs.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const { plantId } = params;

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    // Database branch: when the plant exists in the DB and carries BESS
    // assets, serve them straight from Postgres.
    if (readAccess.plant) {
      const dbAssets = await prisma.bessAsset.findMany({
        where: { plant_id: readAccess.plant.id },
        orderBy: { created_at: 'asc' },
      });
      if (dbAssets.length > 0) {
        const response: BessAssetsListResponse & { _source: string } = {
          plantId,
          assets: dbAssets.map(dbAssetToInfo),
          count: dbAssets.length,
          _source: 'database',
        };
        return NextResponse.json(response);
      }
    }

    // Load asset info. Showcase plants live under public/data/showcase/bess/{plantId}/.
    const baseSubdir = bessFixtureSubdir(plantId);
    const assetPath = path.join(
      process.cwd(),
      'public',
      'data',
      baseSubdir,
      plantId,
      'asset_info.json'
    );

    try {
      await fs.access(assetPath);
    } catch {
      return NextResponse.json(
        { error: `BESS data not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    const assetData = await fs.readFile(assetPath, 'utf-8');
    const assetInfo = JSON.parse(assetData);

    // Transform to match TypeScript interface
    const asset: BessAssetInfo = {
      id: assetInfo.asset_id,
      plantId: assetInfo.plant_id,
      externalAssetId: assetInfo.asset_id,
      name: assetInfo.name,
      chemistry: assetInfo.chemistry,
      nominalCapacityKwh: assetInfo.nominal_capacity_kwh,
      nominalPowerKw: assetInfo.nominal_power_kw,
      moduleCount: assetInfo.module_count || null,
      rackCount: assetInfo.rack_count || null,
      installationDate: assetInfo.installation_date,
      manufacturer: assetInfo.manufacturer,
      model: assetInfo.model,
      serialNumber: assetInfo.serial_number || null,
      currentSoh: assetInfo.current_soh,
      currentSoc: assetInfo.current_soc,
      lastCapacityTest: null,
      lastUpdated: new Date().toISOString(),
      enabled: true,
    };

    const response: BessAssetsListResponse = {
      plantId,
      assets: [asset], // Demo: single asset per plant
      count: 1,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/bess/plants/[plantId]:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
