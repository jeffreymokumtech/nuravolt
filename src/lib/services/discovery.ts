import { DataConnection } from '@prisma/client';
import { InfluxDBService, DiscoveredPlant, DiscoveredField, DataRange } from './influxdb-service';
import { SQLScadaService } from './sql-scada-service';
import { ModbusService } from './modbus-service';
import { parseBessDeviceId } from './cloud-connector';
import type { BessDeviceGrain, NormalizedDevice } from './cloud-connector';

// ---------------------------------------------------------------------------
// Device classes
// ---------------------------------------------------------------------------
// Discovery classifies every device it finds so the onboarding wizard can route
// it: PV devices to a Plant, battery devices to a BessAsset. Batteries are
// hierarchical (asset / unit / rack / module / cell) and that grain lives in the
// canonical device_ext_id, so the summary below carries the parsed grain rather
// than re-deriving it downstream.

export const DEVICE_CLASSES = [
  'string_inverter',
  'residential_inverter',
  'emi',
  'battery',
  'power_sensor',
  'dongle',
  'logger',
  'other',
] as const;

export type DeviceClass = (typeof DEVICE_CLASSES)[number];

/** Device classes that belong to a BessAsset rather than to PV. */
export const BATTERY_DEVICE_CLASSES: DeviceClass[] = ['battery'];

export function isBatteryDeviceClass(deviceType: string | undefined | null): boolean {
  return !!deviceType && BATTERY_DEVICE_CLASSES.indexOf(deviceType as DeviceClass) !== -1;
}

/** Flattened device row for the wizard's device-matching step. */
export interface DiscoveredDeviceSummary {
  external_device_id: string;
  external_plant_id: string;
  device_type: string;
  name?: string;
  model?: string;
  serial?: string;
  /** Raw vendor handle when external_device_id carries a canonical id. */
  vendor_device_id?: string;
  /** Set for battery devices whose id follows the canonical BESS convention. */
  bess_grain?: BessDeviceGrain;
  /** Asset token parsed out of the canonical BESS id. */
  bess_asset?: string;
}

/**
 * Battery devices grouped by the asset token in their canonical id — the unit
 * the wizard matches against a BessAsset. Devices whose id is not canonical are
 * still listed, under a null asset, so nothing disappears silently.
 */
export interface DiscoveredBatteryAsset {
  asset: string | null;
  devices: DiscoveredDeviceSummary[];
  /** Grains present under this asset, deepest last. */
  grains: BessDeviceGrain[];
}

const GRAIN_ORDER: BessDeviceGrain[] = ['asset', 'unit', 'rack', 'module', 'cell'];

export function summarizeDiscoveredDevices(
  devices: NormalizedDevice[]
): DiscoveredDeviceSummary[] {
  return devices.map(device => {
    const summary: DiscoveredDeviceSummary = {
      external_device_id: String(device.external_device_id),
      external_plant_id: String(device.external_plant_id ?? ''),
      device_type: device.device_type,
      name: device.name,
      model: device.model,
      serial: device.serial,
      vendor_device_id: device.metadata?.vendor_device_id
        ? String(device.metadata.vendor_device_id)
        : undefined,
    };

    if (isBatteryDeviceClass(device.device_type)) {
      const canonical = String(
        device.metadata?.canonical_device_id ?? device.external_device_id
      );
      const parsed = parseBessDeviceId(canonical);
      if (parsed) {
        summary.bess_grain = parsed.grain;
        summary.bess_asset = parsed.asset;
      }
    }
    return summary;
  });
}

/** Group battery devices by BESS asset token for the device-matching step. */
export function groupBatteryDevicesByAsset(
  devices: NormalizedDevice[]
): DiscoveredBatteryAsset[] {
  const byAsset = new Map<string, DiscoveredDeviceSummary[]>();

  for (const summary of summarizeDiscoveredDevices(devices)) {
    if (!isBatteryDeviceClass(summary.device_type)) continue;
    const key = summary.bess_asset ?? '';
    const list = byAsset.get(key) ?? [];
    list.push(summary);
    byAsset.set(key, list);
  }

  return Array.from(byAsset.entries()).map(([asset, list]) => ({
    asset: asset === '' ? null : asset,
    devices: list,
    grains: GRAIN_ORDER.filter(grain => list.some(d => d.bess_grain === grain)),
  }));
}

export interface DiscoveryResult {
  plants: DiscoveredPlant[];
  discoveredFields: DiscoveredField[];
  dataRange?: DataRange;
  estimatedDataPoints: number;
  qualityScore: number;
  recommendations: string[];
  /** Every device found, PV and battery alike. Absent for source types that have no device concept. */
  devices?: DiscoveredDeviceSummary[];
  /** Battery devices grouped by asset, for matching against a BessAsset. */
  batteryAssets?: DiscoveredBatteryAsset[];
}

export class DiscoveryService {
  async initiateDiscovery(connectionId: string): Promise<void> {
    // This would typically be called asynchronously
    // For now, we'll just log that discovery is initiated
    console.log(`Discovery initiated for connection ${connectionId}`);
    
    // In production, this would:
    // 1. Queue a background job
    // 2. Update connection status to 'discovering'
    // 3. Run discovery in the background
    // 4. Update results when complete
  }

  async runDiscovery(connection: DataConnection): Promise<DiscoveryResult> {
    switch (connection.type) {
      case 'influxdb':
        return await this.discoverInfluxDB(connection);
      case 'sql_scada':
        return await this.discoverSQLScada(connection);
      case 'modbus_tcp':
        return await this.discoverModbus(connection);
      case 'csv_upload':
        return await this.discoverCSV(connection);
      case 'huawei_api':
        return await this.discoverHuaweiAPI(connection);
      case 'sungrow_api':
        return await this.discoverSungrowAPI(connection);
      default:
        throw new Error(`Unsupported connection type: ${connection.type}`);
    }
  }

  private async discoverInfluxDB(connection: DataConnection): Promise<DiscoveryResult> {
    const influxService = new InfluxDBService();
    
    try {
      await influxService.connect(connection);
      
      // Run parallel discovery
      const [plants, fields, portfolio] = await Promise.all([
        influxService.discoverPlants(),
        influxService.discoverFields(),
        influxService.discoverPortfolio(),
      ]);

      const recommendations = this.generateInfluxDBRecommendations(plants, fields, portfolio);

      return {
        plants,
        discoveredFields: fields,
        dataRange: portfolio.timeRange,
        estimatedDataPoints: portfolio.estimatedDataPoints,
        qualityScore: portfolio.qualityScore,
        recommendations,
      };
    } finally {
      await influxService.close();
    }
  }

  private async discoverSQLScada(connection: DataConnection): Promise<DiscoveryResult> {
    const sqlService = new SQLScadaService();
    
    try {
      await sqlService.connect(connection);
      
      const [plants, fields, dataInfo] = await Promise.all([
        sqlService.discoverPlants(),
        sqlService.discoverFields(),
        sqlService.getDataInfo(),
      ]);

      const recommendations = this.generateSQLRecommendations(plants, fields, dataInfo);

      return {
        plants,
        discoveredFields: fields,
        dataRange: {
          ...dataInfo.timeRange,
          totalPoints: dataInfo.estimatedPoints
        },
        estimatedDataPoints: dataInfo.estimatedPoints,
        qualityScore: dataInfo.qualityScore,
        recommendations,
      };
    } finally {
      await sqlService.close();
    }
  }

  private async discoverModbus(connection: DataConnection): Promise<DiscoveryResult> {
    const modbusService = new ModbusService();
    
    try {
      await modbusService.connect(connection);
      
      const [devices, registers] = await Promise.all([
        modbusService.discoverDevices(),
        modbusService.discoverRegisters(),
      ]);

      // Convert Modbus devices to plants
      const plants: DiscoveredPlant[] = devices.map(device => ({
        id: device.unitId.toString(),
        name: device.name || `Device ${device.unitId}`,
        metadata: {
          unitId: device.unitId,
          deviceType: device.deviceType,
          manufacturer: device.manufacturer,
        },
      }));

      const discoveredFields = registers.map(register => ({
        originalName: register.name,
        mappedType: register.mappedType,
        fieldPath: `${register.address}`,
        unit: register.unit,
        confidenceScore: register.confidence,
        validationRules: register.validationRules,
      }));

      const recommendations = this.generateModbusRecommendations(devices, registers);

      return {
        plants,
        discoveredFields,
        estimatedDataPoints: devices.length * registers.length * 35040, // 15-min intervals for a year
        qualityScore: 85, // Modbus is typically reliable
        recommendations,
      };
    } finally {
      await modbusService.close();
    }
  }

  private async discoverCSV(connection: DataConnection): Promise<DiscoveryResult> {
    // CSV discovery would analyze uploaded files
    // For now, return a basic structure
    return {
      plants: [{
        id: 'csv_plant_1',
        name: 'Uploaded Data',
      }],
      discoveredFields: [],
      estimatedDataPoints: 0,
      qualityScore: 60, // Lower score until validated
      recommendations: [
        'Upload CSV files with standardized column headers',
        'Ensure timestamp columns are in ISO format',
        'Include plant identification in each row',
      ],
    };
  }

  private async discoverHuaweiAPI(connection: DataConnection): Promise<DiscoveryResult> {
    // Huawei API discovery would use their NorthBound API
    // For now, return a placeholder structure
    return {
      plants: [],
      discoveredFields: [],
      estimatedDataPoints: 0,
      qualityScore: 90, // Huawei API is typically high quality
      recommendations: [
        'Verify API access permissions for all required data points',
        'Configure polling interval based on API rate limits',
        'Enable webhook notifications for real-time updates',
      ],
    };
  }

  /**
   * Sungrow iSolarCloud. The live discovery path runs in the connections
   * discover route (same as Huawei and SolarEdge); this entry point returns the
   * onboarding guidance the source needs. Both facts below are real constraints,
   * not filler: iSolarCloud access needs a signed agreement with Sungrow, and
   * its measurement point ids are account specific, so a connection cannot emit
   * readings until the operator supplies a point map.
   */
  private async discoverSungrowAPI(connection: DataConnection): Promise<DiscoveryResult> {
    const config = (connection.config || {}) as Record<string, any>;
    const hasPointMap =
      !!(config.point_map || config.pointMap) &&
      Object.keys((config.point_map || config.pointMap) as Record<string, any>).length > 0;
    const hasDeviceTypeMap =
      !!(config.device_type_map || config.deviceTypeMap) &&
      Object.keys((config.device_type_map || config.deviceTypeMap) as Record<string, any>).length > 0;

    const recommendations: string[] = [];
    if (!hasPointMap) {
      recommendations.push(
        'Add a point map to the connection config. iSolarCloud measurement point ids are account specific, so no reading is stored until each point id is mapped to a data field.'
      );
    }
    if (!hasDeviceTypeMap) {
      recommendations.push(
        'Add a device type map so battery devices are recognised. Unmapped Sungrow device type codes are classified as other and cannot be matched to a battery asset.'
      );
    }
    recommendations.push(
      'Confirm the appkey and access key are stored in Secrets Manager, not in the connection config.'
    );

    return {
      plants: [],
      discoveredFields: [],
      estimatedDataPoints: 0,
      // No quality claim: this connector has never run against a live endpoint.
      qualityScore: 0,
      recommendations,
      devices: [],
      batteryAssets: [],
    };
  }

  private generateInfluxDBRecommendations(
    plants: DiscoveredPlant[],
    fields: DiscoveredField[],
    portfolio: any
  ): string[] {
    const recommendations: string[] = [];

    // Check data coverage
    const criticalFields = ['power_ac', 'irradiance_poa', 'temp_module'];
    const foundCriticalFields = fields.filter(f => 
      criticalFields.includes(f.mappedType) && f.confidenceScore > 0.8
    );

    if (foundCriticalFields.length < criticalFields.length) {
      recommendations.push('Some critical data fields are missing or have low confidence mapping');
    }

    // Check portfolio size
    if (plants.length > 20) {
      recommendations.push('Large portfolio detected - consider implementing data aggregation strategies');
    }

    // Check data quality
    if (portfolio.qualityScore < 80) {
      recommendations.push('Data quality issues detected - review sensor calibration and data gaps');
    }

    // Check time range
    const daysSinceLastData = portfolio.timeRange ? 
      (Date.now() - new Date(portfolio.timeRange.end).getTime()) / (1000 * 60 * 60 * 24) : 0;
    
    if (daysSinceLastData > 1) {
      recommendations.push('Data appears to be stale - verify real-time data ingestion');
    }

    return recommendations;
  }

  private generateSQLRecommendations(plants: any[], fields: any[], dataInfo: any): string[] {
    const recommendations: string[] = [];

    recommendations.push('Optimize SQL queries for better performance with large datasets');
    recommendations.push('Consider implementing data indexing on timestamp columns');
    
    if (fields.length < 5) {
      recommendations.push('Limited data fields detected - verify SCADA tag mapping');
    }

    return recommendations;
  }

  private generateModbusRecommendations(devices: any[], registers: any[]): string[] {
    const recommendations: string[] = [];

    recommendations.push('Configure optimal polling intervals to avoid overloading devices');
    recommendations.push('Implement error handling for network timeouts');
    
    if (devices.length > 10) {
      recommendations.push('Consider implementing a Modbus gateway for better scalability');
    }

    return recommendations;
  }
}