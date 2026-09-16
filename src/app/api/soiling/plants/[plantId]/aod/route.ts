import { NextRequest, NextResponse } from 'next/server';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/soiling/plants/[plantId]/aod
 *
 * Returns Aerosol Optical Depth (AOD) data at 550nm wavelength.
 * TODO: Replace with actual CAMS (Copernicus Atmosphere Monitoring Service) data
 * Currently returns generated data based on seasonal patterns for Alpha1 location.
 *
 * AOD components:
 * - Total AOD at 550nm
 * - Dust AOD (primary soiling contributor)
 * - Sea Salt AOD
 * - Organic Matter AOD
 * - Black Carbon AOD
 * - Sulfate AOD
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

    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '365');

    // Generate AOD data for the period
    // TODO: Replace this with actual CAMS data from analyticsbackend/data/cams/
    const data = generateAODData(days);

    const response = {
      plantId,
      dataSource: 'Generated (TODO: Replace with CAMS data)',
      wavelength_nm: 550,
      dataPoints: data.length,
      period: {
        from: data[0].timestamp,
        to: data[data.length - 1].timestamp,
      },
      data,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/soiling/plants/[plantId]/aod:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * Generate realistic AOD data based on seasonal patterns
 * Alpha1, Chile experiences high dust AOD in winter (June-August)
 * TODO: Replace with actual CAMS reanalysis data
 */
function generateAODData(days: number) {
  const data = [];
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  for (let i = 0; i < days; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);

    // Seasonal variation (higher in southern hemisphere winter)
    const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000);
    const seasonalFactor = Math.sin(((dayOfYear - 172) / 365) * 2 * Math.PI) * 0.05 + 0.15;

    // Add daily variation and noise
    const dailyNoise = (Math.random() - 0.5) * 0.05;
    const dustAOD = Math.max(0, seasonalFactor + dailyNoise);

    // Other AOD components (proportional to dust)
    const seaSaltAOD = dustAOD * 0.2 + (Math.random() - 0.5) * 0.01;
    const organicMatterAOD = dustAOD * 0.15 + (Math.random() - 0.5) * 0.008;
    const blackCarbonAOD = dustAOD * 0.1 + (Math.random() - 0.5) * 0.005;
    const sulfateAOD = dustAOD * 0.25 + (Math.random() - 0.5) * 0.01;

    const totalAOD = dustAOD + seaSaltAOD + organicMatterAOD + blackCarbonAOD + sulfateAOD;

    data.push({
      timestamp: date.toISOString().split('T')[0],
      aod_total: parseFloat(totalAOD.toFixed(4)),
      aod_dust: parseFloat(dustAOD.toFixed(4)),
      aod_sea_salt: parseFloat(Math.max(0, seaSaltAOD).toFixed(4)),
      aod_organic_matter: parseFloat(Math.max(0, organicMatterAOD).toFixed(4)),
      aod_black_carbon: parseFloat(Math.max(0, blackCarbonAOD).toFixed(4)),
      aod_sulfate: parseFloat(Math.max(0, sulfateAOD).toFixed(4)),
    });
  }

  return data;
}
