import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';

interface SensorDataPoint {
  timestamp: string;
  value: number;
}

interface SensorHistoryResponse {
  equipment_id: string;
  fault_type: string;
  sensor_type: string;
  unit: string;
  data: SensorDataPoint[];
  threshold: number;
  metadata: {
    min: number;
    max: number;
    mean: number;
    count: number;
  };
}

interface SensorConfig {
  sensorType: string;
  unit: string;
  fileName: string;
  valueColumn: string;
  threshold: number;
}

/**
 * GET /api/faults/sensor-history
 *
 * Fetch historical sensor data for fault trend visualization.
 * Returns 30 days of sensor readings for fault analysis.
 *
 * Query params:
 * - plantId: Plant identifier (e.g., "alpha1", "eta")
 * - equipmentId: Equipment identifier (e.g., "INV-05.134", "INV-01.045-S7")
 * - faultType: Fault type (e.g., "inverter_overtemperature", "string_open_circuit")
 * - daysBack: Number of days of history (default: 30, max: 90)
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const plantId = searchParams.get('plantId');
    const equipmentId = searchParams.get('equipmentId');
    const faultType = searchParams.get('faultType');
    const daysBack = parseInt(searchParams.get('daysBack') || '30');

    // Validation
    if (!plantId || !equipmentId || !faultType) {
      return NextResponse.json(
        { error: 'Missing required parameters: plantId, equipmentId, faultType' },
        { status: 400 }
      );
    }

    if (daysBack > 90) {
      return NextResponse.json(
        { error: 'daysBack cannot exceed 90 days' },
        { status: 400 }
      );
    }

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;
    if (readAccess.access === 'org') {
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:fault_detection');
      if (gate) return gate;
    }

    // Determine sensor type and data source based on fault type
    const sensorConfig = getSensorConfig(faultType);

    // Extract inverter ID from equipment ID (strip string suffix for string-level faults)
    // "INV 01.001-string_current_2" -> "INV 01.001"
    // "INV 01.001" -> "INV 01.001"
    let inverterId = equipmentId;
    if (equipmentId.includes('-string_')) {
      inverterId = equipmentId.split('-string_')[0];
    } else if (equipmentId.includes('-S')) {
      // Handle "INV-01.045-S7" format
      inverterId = equipmentId.replace(/-S\d+$/, '');
    }

    // Normalize inverter ID for file matching
    // Handles different formats: "INV 01.001" -> "INV_01_001", "PV-01.001" -> "PV_01_001"
    const normalizedEquipmentId = inverterId
      .replace(/[\s.]/g, '_')  // Replace spaces and dots with underscores
      .replace(/-/g, '_');     // Replace hyphens with underscores

    // For residual files, also try INV_ format (files weren't renamed during PV- migration)
    const invFormatId = normalizedEquipmentId.replace(/^PV_/, 'INV_');

    // Construct path to digital twin residuals or sensor data
    // Try multiple possible file patterns
    const possiblePaths = [
      // Digital twin residuals with normalized ID (primary source)
      path.join(
        process.cwd(),
        'public',
        'data',
        'digitaltwin',
        plantId,
        `residuals_${normalizedEquipmentId}.csv`
      ),
      // Fallback: INV_ format for residual files (PV- migration compatibility)
      path.join(
        process.cwd(),
        'public',
        'data',
        'digitaltwin',
        plantId,
        `residuals_${invFormatId}.csv`
      ),
      // Digital twin residuals with original ID
      path.join(
        process.cwd(),
        'public',
        'data',
        'digitaltwin',
        plantId,
        `residuals_${equipmentId}.csv`
      ),
      // Alternative: all inverters combined
      path.join(
        process.cwd(),
        'public',
        'data',
        'digitaltwin',
        plantId,
        'residuals_all_inverters.csv'
      ),
      // Fallback: raw sensor data
      path.join(
        process.cwd(),
        'public',
        'data',
        plantId,
        sensorConfig.fileName
      )
    ];

    let dataPath: string | null = null;
    for (const testPath of possiblePaths) {
      if (fs.existsSync(testPath)) {
        dataPath = testPath;
        break;
      }
    }

    if (!dataPath) {
      return NextResponse.json(
        {
          error: `Sensor data not found for equipment ${equipmentId}`,
          searched_paths: possiblePaths.map(p => path.basename(p))
        },
        { status: 404 }
      );
    }

    // Parse CSV and filter by equipment and date range
    const csvContent = fs.readFileSync(dataPath, 'utf-8');
    const parsed = Papa.parse(csvContent, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true
    });

    if (parsed.errors.length > 0) {
      console.error('CSV parsing errors:', parsed.errors);
      return NextResponse.json(
        { error: 'Failed to parse sensor data' },
        { status: 500 }
      );
    }

    // First pass: find the latest timestamp in the data
    // This handles cases where data is older than "today"
    let maxTimestamp: Date | null = null;
    const allData: any[] = [];

    for (const row of parsed.data as any[]) {
      if (!row || !row.timestamp) continue;

      // Check if this row is for the target equipment
      const rowEquipmentId = row.inverter_id || row.equipment_id || row.id;
      if (rowEquipmentId && rowEquipmentId !== equipmentId) continue;

      const timestamp = new Date(row.timestamp);
      if (!isNaN(timestamp.getTime())) {
        if (!maxTimestamp || timestamp > maxTimestamp) {
          maxTimestamp = timestamp;
        }
        allData.push({ row, timestamp });
      }
    }

    // Use the latest data timestamp as reference, not today's date
    // This ensures we get data even if the dataset is historical
    const referenceDate = maxTimestamp || new Date();
    const cutoffDate = new Date(referenceDate);
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);

    // Filter and extract sensor data
    const filteredData: SensorDataPoint[] = [];

    for (const { row, timestamp } of allData) {
      // Skip data outside date range
      if (timestamp < cutoffDate) continue;

      // Extract sensor value
      const value = row[sensorConfig.valueColumn];

      if (value !== undefined && value !== null && !isNaN(value)) {
        filteredData.push({
          timestamp: row.timestamp,
          value: parseFloat(value)
        });
      }
    }

    if (filteredData.length === 0) {
      return NextResponse.json(
        {
          error: `No data found for equipment ${equipmentId} in the last ${daysBack} days`,
          data_path: path.basename(dataPath)
        },
        { status: 404 }
      );
    }

    // For degradation faults, apply moving average smoothing to show trend
    // This removes noise and makes the degradation pattern clearer
    const isDegradationFault = faultType.includes('degradation');
    let displayData = filteredData;

    if (isDegradationFault && filteredData.length > 0) {
      // Apply 7-day moving average (7 days * 96 15-min intervals = 672 points)
      // Use shorter window if not enough data
      const windowSize = Math.min(672, Math.floor(filteredData.length / 10));

      if (windowSize >= 10) {
        displayData = applyMovingAverage(filteredData, windowSize);
      }
    }

    // Calculate metadata (use original unsmoothed data for accurate stats)
    const values = filteredData.map(d => d.value);
    const metadata = {
      min: Math.min(...values),
      max: Math.max(...values),
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      count: values.length
    };

    const response: SensorHistoryResponse = {
      equipment_id: equipmentId,
      fault_type: faultType,
      sensor_type: sensorConfig.sensorType,
      unit: sensorConfig.unit,
      data: displayData,  // Use smoothed data for display
      threshold: sensorConfig.threshold,
      metadata
    };

    return NextResponse.json(response);

  } catch (error) {
    console.error('Error fetching sensor history:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

/**
 * Apply simple moving average smoothing to sensor data.
 * This reduces noise and makes long-term trends clearer.
 */
function applyMovingAverage(
  data: SensorDataPoint[],
  windowSize: number
): SensorDataPoint[] {
  if (data.length < windowSize) {
    return data;
  }

  const smoothed: SensorDataPoint[] = [];

  for (let i = 0; i < data.length; i++) {
    // Calculate window bounds
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end = Math.min(data.length, i + Math.ceil(windowSize / 2));

    // Calculate average of values in window
    let sum = 0;
    let count = 0;

    for (let j = start; j < end; j++) {
      if (!isNaN(data[j].value) && data[j].value !== null) {
        sum += data[j].value;
        count++;
      }
    }

    const avgValue = count > 0 ? sum / count : data[i].value;

    smoothed.push({
      timestamp: data[i].timestamp,
      value: avgValue
    });
  }

  return smoothed;
}

function getSensorConfig(faultType: string): SensorConfig {
  // Residuals files have columns: timestamp, actual, expected, residual, loss_pct, irradiance
  // Map fault types to appropriate columns from actual data
  //
  // Key insight: Show RELEVANT data for each fault type:
  // - Soiling/degradation → loss_pct (how much performance is lost)
  // - Underperformance → actual vs expected (power comparison)
  // - Thermal → loss_pct (thermal impact on performance, since we don't have temp sensors)
  // - Offline → actual (should be near zero)

  const configs: Record<string, SensorConfig> = {
    // ========== SOILING FAULTS ==========
    // Show Performance Ratio (loss_pct) - the actual soiling impact
    'soiling_detected': {
      sensorType: 'Performance Ratio Loss',
      unit: '%',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'loss_pct',
      threshold: 5.0  // 5% loss threshold for soiling
    },
    'soiling_high': {
      sensorType: 'Performance Ratio Loss',
      unit: '%',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'loss_pct',
      threshold: 10.0
    },

    // ========== DEGRADATION FAULTS ==========
    // Show loss percentage - degradation impact over time
    'string_degradation': {
      sensorType: 'Performance Loss',
      unit: '%',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'loss_pct',
      threshold: 10.0
    },
    'module_degradation': {
      sensorType: 'Performance Loss',
      unit: '%',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'loss_pct',
      threshold: 20.0
    },
    'inverter_degradation': {
      sensorType: 'Performance Loss',
      unit: '%',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'loss_pct',
      threshold: 15.0
    },

    // ========== THERMAL FAULTS ==========
    // Show loss_pct - thermal issues cause performance drops
    // (Temperature sensor data not available in residuals - show impact instead)
    'inverter_overtemperature': {
      sensorType: 'Thermal Performance Impact',
      unit: '%',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'loss_pct',
      threshold: 15.0  // 15% loss typical for thermal derating
    },
    'inverter_overtemperature_warning': {
      sensorType: 'Thermal Performance Impact',
      unit: '%',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'loss_pct',
      threshold: 10.0
    },
    'inverter_thermal': {
      sensorType: 'Thermal Performance Impact',
      unit: '%',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'loss_pct',
      threshold: 15.0
    },
    'cooling_degradation': {
      sensorType: 'Cooling System Impact',
      unit: '%',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'loss_pct',
      threshold: 10.0
    },

    // ========== UNDERPERFORMANCE FAULTS ==========
    // Show deviation from expected (residual column)
    'inverter_underperformance': {
      sensorType: 'Performance Deviation',
      unit: 'pu',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'residual',
      threshold: -0.15  // 15% underperformance
    },
    'string_underperformance': {
      sensorType: 'Performance Deviation',
      unit: 'pu',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'residual',
      threshold: -0.10
    },

    // ========== MISMATCH/IMBALANCE FAULTS ==========
    // Show deviation from expected
    'string_mismatch': {
      sensorType: 'String Mismatch',
      unit: 'pu',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'residual',
      threshold: 0.1
    },
    'mppt_imbalance': {
      sensorType: 'MPPT Imbalance',
      unit: 'pu',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'residual',
      threshold: 0.15
    },

    // ========== STRING CIRCUIT FAULTS ==========
    // Show actual power output (should drop significantly)
    'string_open_circuit': {
      sensorType: 'String Output',
      unit: 'pu',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'actual',
      threshold: 0.70
    },
    'string_short_circuit': {
      sensorType: 'String Output',
      unit: 'pu',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'actual',
      threshold: 0.70
    },

    // ========== OFFLINE/COMMUNICATION FAULTS ==========
    // Show actual power (should be near zero when offline)
    'inverter_offline': {
      sensorType: 'Power Output',
      unit: 'pu',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'actual',
      threshold: 0.01
    },
    'communication_loss': {
      sensorType: 'Power Output',
      unit: 'pu',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'actual',
      threshold: 0.01
    },

    // ========== DEFAULT ==========
    // Show performance deviation for unknown fault types
    'default': {
      sensorType: 'Performance Deviation',
      unit: 'pu',
      fileName: 'residuals_INV_*.csv',
      valueColumn: 'residual',
      threshold: 0.15
    }
  };

  // Return config for the fault type, or default
  return configs[faultType] || configs['default'];
}
