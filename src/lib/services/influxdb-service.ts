import { InfluxDB, Point } from '@influxdata/influxdb-client';
import { DataConnection, DataFieldType } from '@prisma/client';
import { CredentialService } from './credentials';

export interface InfluxDBConfig {
  url: string;
  token: string;
  org: string;
  bucket: string;
  timeout?: number;
}

export interface DiscoveredPlant {
  id: string;
  name: string;
  location?: {
    lat?: number;
    lng?: number;
    country?: string;
    region?: string;
  };
  capacity_mw?: number;
  inverter_count?: number;
  inverter_types?: string[];
  commissioning_date?: Date;
  timezone?: string;
  metadata?: any;
  first_data_timestamp?: Date;
  last_data_timestamp?: Date;
}

export interface DiscoveredField {
  originalName: string;
  mappedType: DataFieldType;
  fieldPath?: string;
  unit?: string;
  scalingFactor?: number;
  offset?: number;
  validationRules?: any;
  confidenceScore: number;
  sampleValues?: any[];
}

export interface DataRange {
  start: Date;
  end: Date;
  totalPoints: number;
}

export interface PortfolioSummary {
  plantCount: number;
  totalCapacityMW: number;
  dataTypes: string[];
  timeRange: DataRange;
  estimatedDataPoints: number;
  qualityScore: number;
}

export class InfluxDBService {
  private client: InfluxDB | null = null;
  private config: InfluxDBConfig | null = null;

  async connect(connection: DataConnection): Promise<void> {
    const credentialService = new CredentialService();
    const credentials = await credentialService.getCredentials(connection.secret_arn!);

    const config = connection.config as any;
    this.config = {
      url: config.host || credentials.url,
      token: credentials.token,
      org: config.org || credentials.org,
      bucket: config.bucket || credentials.bucket,
      timeout: config.timeout || 30000,
    };

    this.client = new InfluxDB({
      url: this.config.url,
      token: this.config.token,
      timeout: this.config.timeout,
    });
  }

  async testConnection(): Promise<{
    success: boolean;
    message: string;
    responseTime: number;
    error?: string;
  }> {
    if (!this.client || !this.config) {
      throw new Error('Not connected to InfluxDB');
    }

    const startTime = Date.now();

    try {
      // Test with a simple bucket list query
      const queryApi = this.client.getQueryApi(this.config.org);
      const testQuery = `
        from(bucket: "${this.config.bucket}")
          |> range(start: -1h)
          |> limit(n: 1)
      `;

      await queryApi.collectRows(testQuery);
      const responseTime = Date.now() - startTime;

      return {
        success: true,
        message: 'Connection successful',
        responseTime,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      return {
        success: false,
        message: 'Connection failed',
        responseTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async discoverPortfolio(): Promise<PortfolioSummary> {
    if (!this.client || !this.config) {
      throw new Error('Not connected to InfluxDB');
    }

    const queryApi = this.client.getQueryApi(this.config.org);

    // Discover plants
    const plantsQuery = `
      import "influxdata/influxdb/schema"
      schema.tagValues(
        bucket: "${this.config.bucket}",
        tag: "plant_id",
        start: -30d
      )
    `;

    const plants = await queryApi.collectRows(plantsQuery);
    const plantIds = plants.map((row: any) => row._value);

    // Discover measurements and fields
    const measurementsQuery = `
      import "influxdata/influxdb/schema"
      schema.measurements(bucket: "${this.config.bucket}")
    `;

    const measurements = await queryApi.collectRows(measurementsQuery);
    const dataTypes = measurements.map((row: any) => row._value);

    // Get time range
    const timeRangeQuery = `
      from(bucket: "${this.config.bucket}")
        |> range(start: -2y)
        |> group()
        |> min()
        |> keep(columns: ["_time"])
        |> rename(columns: {_time: "start"})
        |> union(tables: [
          from(bucket: "${this.config.bucket}")
            |> range(start: -30d)
            |> group()
            |> max()
            |> keep(columns: ["_time"])
            |> rename(columns: {_time: "end"})
        ])
    `;

    const timeRange = await queryApi.collectRows(timeRangeQuery);
    const timeRangeRows = timeRange as any[];
    const startTime = new Date(timeRangeRows.find((row: any) => row.start)?.start || Date.now() - 86400000);
    const endTime = new Date(timeRangeRows.find((row: any) => row.end)?.end || Date.now());

    // Estimate data points
    const estimateQuery = `
      from(bucket: "${this.config.bucket}")
        |> range(start: -7d)
        |> group()
        |> count()
    `;

    const countResult = await queryApi.collectRows(estimateQuery);
    const weeklyPoints = (countResult as any[])[0]?._value || 0;
    const estimatedDataPoints = Math.round(weeklyPoints * 52); // Extrapolate to yearly

    // Calculate total capacity (if available)
    let totalCapacityMW = 0;
    try {
      const capacityQuery = `
        from(bucket: "${this.config.bucket}")
          |> range(start: -30d)
          |> filter(fn: (r) => r._field == "capacity_mw" or r._field == "rated_power")
          |> group(columns: ["plant_id"])
          |> max()
          |> group()
          |> sum()
      `;

      const capacity = await queryApi.collectRows(capacityQuery);
      totalCapacityMW = (capacity[0] as any)?._value || 0;
    } catch (error) {
      // Capacity data might not be available
      console.warn('Could not determine portfolio capacity:', error);
    }

    return {
      plantCount: plantIds.length,
      totalCapacityMW,
      dataTypes,
      timeRange: {
        start: startTime,
        end: endTime,
        totalPoints: estimatedDataPoints,
      },
      estimatedDataPoints,
      qualityScore: await this.calculateQualityScore(),
    };
  }

  async discoverPlants(): Promise<DiscoveredPlant[]> {
    if (!this.client || !this.config) {
      throw new Error('Not connected to InfluxDB');
    }

    const queryApi = this.client.getQueryApi(this.config.org);

    // Get all unique plant IDs
    const plantsQuery = `
      import "influxdata/influxdb/schema"
      schema.tagValues(
        bucket: "${this.config.bucket}",
        tag: "plant_id",
        start: -30d
      )
    `;

    const plantRows = await queryApi.collectRows(plantsQuery);
    const plantIds = plantRows.map((row: any) => row._value);

    const plants: DiscoveredPlant[] = [];

    // Get details for each plant
    for (const plantId of plantIds) {
      try {
        const plantDetailsQuery = `
          from(bucket: "${this.config.bucket}")
            |> range(start: -30d)
            |> filter(fn: (r) => r.plant_id == "${plantId}")
            |> group(columns: ["_field"])
            |> first()
            |> group()
            |> pivot(rowKey: ["plant_id"], columnKey: ["_field"], valueColumn: "_value")
        `;

        const details = await queryApi.collectRows(plantDetailsQuery);
        const plantData = details[0] || {};

        // Get time range for this plant
        const timeRangeQuery = `
          from(bucket: "${this.config.bucket}")
            |> range(start: -2y)
            |> filter(fn: (r) => r.plant_id == "${plantId}")
            |> group()
            |> min()
            |> keep(columns: ["_time"])
            |> rename(columns: {_time: "first_time"})
            |> union(tables: [
              from(bucket: "${this.config.bucket}")
                |> range(start: -30d)
                |> filter(fn: (r) => r.plant_id == "${plantId}")
                |> group()
                |> max()
                |> keep(columns: ["_time"])
                |> rename(columns: {_time: "last_time"})
            ])
        `;

        const timeRange = await queryApi.collectRows(timeRangeQuery);

        plants.push({
          id: plantId,
          name: (plantData as any).plant_name || (plantData as any).name || `Plant ${plantId}`,
          location: {
            lat: (plantData as any).latitude,
            lng: (plantData as any).longitude,
            country: (plantData as any).country,
            region: (plantData as any).region,
          },
          capacity_mw: (plantData as any).capacity_mw || (plantData as any).rated_power,
          inverter_count: (plantData as any).inverter_count,
          inverter_types: (plantData as any).inverter_types ? [(plantData as any).inverter_types] : [],
          commissioning_date: (plantData as any).commissioning_date ? new Date((plantData as any).commissioning_date) : undefined,
          timezone: (plantData as any).timezone,
          metadata: {
            technology: (plantData as any).technology,
            developer: (plantData as any).developer,
            owner: (plantData as any).owner,
          },
          first_data_timestamp: timeRange.find((row: any) => (row as any).first_time) ? 
            new Date((timeRange.find((row: any) => (row as any).first_time) as any).first_time) : undefined,
          last_data_timestamp: timeRange.find((row: any) => (row as any).last_time) ? 
            new Date((timeRange.find((row: any) => (row as any).last_time) as any).last_time) : undefined,
        });
      } catch (error) {
        console.warn(`Failed to get details for plant ${plantId}:`, error);
        // Add plant with minimal info
        plants.push({
          id: plantId,
          name: `Plant ${plantId}`,
        });
      }
    }

    return plants;
  }

  async discoverFields(): Promise<DiscoveredField[]> {
    if (!this.client || !this.config) {
      throw new Error('Not connected to InfluxDB');
    }

    const queryApi = this.client.getQueryApi(this.config.org);

    // Get all field names
    const fieldsQuery = `
      import "influxdata/influxdb/schema"
      schema.fieldKeys(bucket: "${this.config.bucket}")
    `;

    const fieldRows = await queryApi.collectRows(fieldsQuery);
    const fieldNames = fieldRows.map((row: any) => row._value);

    const discoveredFields: DiscoveredField[] = [];

    for (const fieldName of fieldNames) {
      // Get sample values for field mapping
      const sampleQuery = `
        from(bucket: "${this.config.bucket}")
          |> range(start: -24h)
          |> filter(fn: (r) => r._field == "${fieldName}")
          |> sample(n: 10)
      `;

      try {
        const samples = await queryApi.collectRows(sampleQuery);
        const sampleValues = samples.map((row: any) => row._value);

        // Map field to our standard types
        const mapping = this.mapFieldName(fieldName, sampleValues);

        discoveredFields.push({
          originalName: fieldName,
          mappedType: mapping.type,
          unit: mapping.unit,
          scalingFactor: mapping.scalingFactor,
          offset: mapping.offset,
          validationRules: mapping.validationRules,
          confidenceScore: mapping.confidence,
          sampleValues: sampleValues.slice(0, 5), // First 5 samples
        });
      } catch (error) {
        // Field might not have data in last 24h
        const mapping = this.mapFieldName(fieldName, []);
        discoveredFields.push({
          originalName: fieldName,
          mappedType: mapping.type,
          unit: mapping.unit,
          confidenceScore: mapping.confidence * 0.5, // Lower confidence without samples
          sampleValues: [],
        });
      }
    }

    return discoveredFields.sort((a, b) => b.confidenceScore - a.confidenceScore);
  }

  private mapFieldName(fieldName: string, sampleValues: any[]): {
    type: DataFieldType;
    unit?: string;
    scalingFactor?: number;
    offset?: number;
    validationRules?: any;
    confidence: number;
  } {
    const field = fieldName.toLowerCase();
    
    // Power AC mappings
    if (field.includes('power_ac') || field.includes('pac') || field.includes('active_power')) {
      return {
        type: 'power_ac',
        unit: 'kW',
        validationRules: { min: 0, max: 50000 },
        confidence: 0.95,
      };
    }

    // Power DC mappings
    if (field.includes('power_dc') || field.includes('pdc') || field.includes('dc_power')) {
      return {
        type: 'power_dc',
        unit: 'kW',
        validationRules: { min: 0, max: 50000 },
        confidence: 0.95,
      };
    }

    // Voltage mappings
    if (field.includes('voltage') || field.includes('volt') || field.includes('vdc')) {
      return {
        type: 'voltage_dc',
        unit: 'V',
        validationRules: { min: 0, max: 2000 },
        confidence: 0.90,
      };
    }

    // Current mappings
    if (field.includes('current') || field.includes('amp') || field.includes('idc')) {
      return {
        type: 'current_dc',
        unit: 'A',
        validationRules: { min: 0, max: 5000 },
        confidence: 0.90,
      };
    }

    // Irradiance mappings
    if (field.includes('irradiance') || field.includes('poa') || field.includes('ghi') || field.includes('solar')) {
      const type = field.includes('ghi') ? 'irradiance_ghi' : 'irradiance_poa';
      return {
        type,
        unit: 'W/m²',
        validationRules: { min: 0, max: 1500 },
        confidence: 0.85,
      };
    }

    // Temperature mappings
    if (field.includes('temp') || field.includes('temperature')) {
      const type = field.includes('module') || field.includes('cell') || field.includes('pv') 
        ? 'temp_module' 
        : 'temp_ambient';
      return {
        type,
        unit: '°C',
        validationRules: { min: -20, max: 90 },
        confidence: 0.80,
      };
    }

    // Energy mappings
    if (field.includes('energy') || field.includes('kwh') || field.includes('yield')) {
      const type = field.includes('daily') || field.includes('day') ? 'energy_daily' : 'energy_total';
      return {
        type,
        unit: 'kWh',
        validationRules: { min: 0 },
        confidence: 0.75,
      };
    }

    // Default to power_ac with low confidence
    return {
      type: 'power_ac',
      confidence: 0.30,
    };
  }

  async getDataPreview(plantId?: string, limit: number = 100): Promise<any[]> {
    if (!this.client || !this.config) {
      throw new Error('Not connected to InfluxDB');
    }

    const queryApi = this.client.getQueryApi(this.config.org);

    const previewQuery = `
      from(bucket: "${this.config.bucket}")
        |> range(start: -24h)
        ${plantId ? `|> filter(fn: (r) => r.plant_id == "${plantId}")` : ''}
        |> limit(n: ${limit})
        |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
    `;

    return await queryApi.collectRows(previewQuery);
  }

  private async calculateQualityScore(): Promise<number> {
    if (!this.client || !this.config) {
      return 0;
    }

    try {
      const queryApi = this.client.getQueryApi(this.config.org);

      // Check data completeness in last 7 days
      const completenessQuery = `
        from(bucket: "${this.config.bucket}")
          |> range(start: -7d)
          |> aggregateWindow(every: 15m, fn: count)
          |> group()
          |> mean()
      `;

      const completeness = await queryApi.collectRows(completenessQuery);
      const avgPointsPer15Min = (completeness[0] as any)?._value || 0;

      // Expected data points (assuming 15-min intervals)
      const expectedPointsPer15Min = 96 * 7; // 96 intervals per day * 7 days
      const completenessScore = Math.min(avgPointsPer15Min / expectedPointsPer15Min, 1.0);

      // Simple quality score based on completeness
      return Math.round(completenessScore * 100);
    } catch (error) {
      console.warn('Could not calculate quality score:', error);
      return 75; // Default reasonable score
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client = null;
      this.config = null;
    }
  }
}