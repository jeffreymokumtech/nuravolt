import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { resolvePlantForRead, requireOrg, requirePlantAccess } from '@/lib/api/tenant';

/**
 * API endpoint for Python analytics to fetch PlantConfig
 *
 * Usage from Python:
 *   response = requests.get(f"{API_BASE}/api/analytics/plant-config/{plant_id}")
 *   config = response.json()
 *
 * Or for YAML:
 *   response = requests.get(f"{API_BASE}/api/analytics/plant-config/{plant_id}",
 *                          headers={"Accept": "application/x-yaml"})
 *   yaml_config = response.text
 */

// GET /api/analytics/plant-config/[plantId] - Get PlantConfig for Python
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ plantId: string }> }
) {
  try {
    const { plantId } = await params;

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    const acceptHeader = request.headers.get('accept') || '';
    const { searchParams } = new URL(request.url);
    const version = searchParams.get('version');
    const format = searchParams.get('format') || (acceptHeader.includes('yaml') ? 'yaml' : 'json');

    // Find active config for this plant
    const whereClause: any = {
      plant_id: plantId,
      is_active: true,
    };

    if (version) {
      whereClause.version = parseInt(version, 10);
      delete whereClause.is_active;  // Allow fetching specific versions
    }

    const config = await prisma.generatedPlantConfig.findFirst({
      where: whereClause,
      orderBy: { version: 'desc' },
    });

    if (!config) {
      return NextResponse.json(
        { error: `PlantConfig not found for plant: ${plantId}` },
        { status: 404 }
      );
    }

    // Check validation status
    if (config.validation_status === 'invalid') {
      const errors = config.validation_errors as string[] | null;
      return NextResponse.json(
        {
          error: 'PlantConfig has validation errors',
          validation_errors: errors,
          config: config.config_json,  // Still return config for debugging
        },
        { status: 422 }
      );
    }

    // Return based on format
    if (format === 'yaml') {
      return new NextResponse(config.config_yaml, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-yaml',
          'Content-Disposition': `attachment; filename="${plantId}_config.yaml"`,
        },
      });
    }

    // Return JSON (default)
    return NextResponse.json({
      plant_id: config.plant_id,
      version: config.version,
      generated_at: config.generated_at,
      validation_status: config.validation_status,
      config: config.config_json,
    });
  } catch (error) {
    console.error('Error fetching PlantConfig:', error);
    return NextResponse.json(
      { error: 'Failed to fetch PlantConfig' },
      { status: 500 }
    );
  }
}

// POST /api/analytics/plant-config/[plantId]/validate - Validate config
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ plantId: string }> }
) {
  try {
    const { plantId } = await params;

    // Tenancy: POST mutates validation state — require org + OPERATE access.
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const plantResult = await requirePlantAccess(orgResult.ctx, plantId, 'OPERATE');
    if (!plantResult.ok) return plantResult.response;

    const body = await request.json();

    // Find config
    const config = await prisma.generatedPlantConfig.findFirst({
      where: {
        plant_id: plantId,
        is_active: true,
      },
      orderBy: { version: 'desc' },
    });

    if (!config) {
      return NextResponse.json(
        { error: `PlantConfig not found for plant: ${plantId}` },
        { status: 404 }
      );
    }

    // Perform validation (this could be extended to call Python validation)
    const configJson = config.config_json as Record<string, any>;
    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic structure validation
    if (!configJson.plant_id) errors.push('Missing plant_id');
    if (!configJson.location) errors.push('Missing location');
    if (!configJson.data?.columns?.irradiance) errors.push('Missing irradiance column mapping');
    if (!configJson.data?.columns?.ambient_temp) errors.push('Missing ambient_temp column mapping');

    // Check capacity
    if (!configJson.capacity?.nominal_mw || configJson.capacity.nominal_mw <= 0) {
      errors.push('Invalid or missing nominal_mw');
    }

    // Check location
    if (configJson.location?.latitude === 0 && configJson.location?.longitude === 0) {
      warnings.push('Location is at 0,0 - please verify');
    }

    // Check components
    const totalInverters = configJson.components?.groups?.reduce(
      (sum: number, g: any) => sum + (g.inverters?.length || 0), 0
    ) || 0;

    if (totalInverters === 0) {
      warnings.push('No inverters defined in components');
    }

    // Update validation status
    const isValid = errors.length === 0;

    await prisma.generatedPlantConfig.update({
      where: { id: config.id },
      data: {
        validation_status: isValid ? 'valid' : 'invalid',
        validation_errors: errors.length > 0 ? errors : null,
        validated_at: new Date(),
      },
    });

    return NextResponse.json({
      plant_id: plantId,
      version: config.version,
      is_valid: isValid,
      errors,
      warnings,
    });
  } catch (error) {
    console.error('Error validating PlantConfig:', error);
    return NextResponse.json(
      { error: 'Failed to validate PlantConfig' },
      { status: 500 }
    );
  }
}
