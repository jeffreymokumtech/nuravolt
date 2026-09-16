import prisma from '@/libs/prisma';
import type { DataFieldType } from '@prisma/client';
import { S3ParquetStorage, PlantMetric, ParquetLakeWriter, LakeReadingRow } from './s3-storage';
import { InfluxDBService } from './influxdb-service';
import { SQLScadaService } from './sql-scada-service';
import { ModbusService } from './modbus-service';
import { HuaweiFusionSolarService } from './huawei-api-service';
import { SolarEdgeMonitoringService } from './solaredge-api-service';
import { SungrowISolarCloudService } from './sungrow-api-service';
import { SampleApiService, type SamplePlantContext } from './sample-api-service';
import { defaultFleet } from '@/lib/sample/inverter-feed';
import type { NormalizedDevice, NormalizedReading } from './cloud-connector';
import { ConnectionAuditService } from './connection-audit';

export interface PollingJob {
  id: string;
  connectionId: string;
  startedAt: Date;
  status: 'running' | 'completed' | 'failed';
  recordsFetched?: number;
  recordsProcessed?: number;
  bytesProcessed?: number;
  errorMessage?: string;
}

export class PollingService {
  private s3Storage: S3ParquetStorage;
  private lakeWriter: ParquetLakeWriter;
  private auditService: ConnectionAuditService;
  private activeJobs: Map<string, AbortController> = new Map();

  /** Log the missing-snapshot-table warning once per process, not per poll. */
  private static snapshotTableWarned = false;

  /** Log the unmapped-field persistence warning once per process, not per poll. */
  private static unmappedFieldWarned = false;

  constructor() {
    this.s3Storage = new S3ParquetStorage({
      bucket: process.env.S3_DATA_BUCKET || 'heliosiq-plant-data',
      region: process.env.AWS_REGION || 'eu-west-1',
      keyPrefix: 'metrics',
    });

    // Lake landing zone for cloud connectors (Huawei et al.):
    // s3://{LAKE_BUCKET}/bronze/live/{connection_id}/{date}/{epoch}.parquet
    this.lakeWriter = new ParquetLakeWriter({
      bucket: process.env.LAKE_BUCKET || 'nuravolt-lake',
      region: process.env.AWS_REGION || 'eu-west-1',
      keyPrefix: 'bronze/live',
    });

    this.auditService = new ConnectionAuditService();
  }

  // NOTE: there is no long-lived polling loop. On serverless a setInterval loop
  // cannot survive between invocations, so polling is driven one pass at a time
  // by the cron route (src/app/api/cron/poll-connections/route.ts), which calls
  // pollConnections() directly.

  async pollConnections(): Promise<void> {
    try {
      const dueConnections = await this.getDueConnections();
      
      console.log(`Found ${dueConnections.length} connections due for polling`);
      
      for (const connection of dueConnections) {
        // Skip if already polling this connection
        if (this.activeJobs.has(connection.id)) {
          continue;
        }
        
        // Start polling job (don't await - run in parallel)
        this.pollConnection(connection).catch(error => {
          console.error(`Failed to poll connection ${connection.id}:`, error);
        });
      }
    } catch (error) {
      console.error('Error in polling cycle:', error);
    }
  }

  private async getDueConnections(): Promise<any[]> {
    return await prisma.dataConnection.findMany({
      where: {
        enabled: true,
        status: 'connected',
        OR: [
          { last_poll_time: null },
          {
            last_poll_time: {
              lt: new Date(Date.now() - this.getPollingIntervalMs()),
            },
          },
        ],
      },
      include: {
        field_mappings: {
          where: { is_confirmed: true },
        },
      },
    });
  }

  private getPollingIntervalMs(): number {
    // Default to 15 minutes if not specified
    return 15 * 60 * 1000;
  }

  async pollConnection(connection: any): Promise<PollingJob> {
    const jobId = `${connection.id}-${Date.now()}`;
    const abortController = new AbortController();
    this.activeJobs.set(connection.id, abortController);

    // Create polling job record
    const pollingJob = await prisma.pollingJob.create({
      data: {
        connection_id: connection.id,
        status: 'running',
      },
    });

    try {
      console.log(`Starting polling job ${pollingJob.id} for connection ${connection.name}`);
      
      // Get the last poll time for incremental fetching
      const lastPollTime = connection.last_poll_time || new Date(Date.now() - 24 * 60 * 60 * 1000);
      const currentTime = new Date();
      
      // Poll based on connection type
      const pollResult = await this.pollByType(connection, lastPollTime, currentTime, abortController.signal);

      // Records processed: cloud connectors write to the lake themselves and
      // report the count via recordsProcessed; legacy paths return raw rows.
      const recordsProcessed = pollResult.recordsProcessed ?? pollResult.data.length;

      // Store data in S3 (legacy path — cloud connectors return data: [])
      if (pollResult.data.length > 0) {
        await this.s3Storage.addMetrics(pollResult.data);
      }

      // Update connection status
      await prisma.dataConnection.update({
        where: { id: connection.id },
        data: {
          last_poll_time: currentTime,
          last_poll_status: 'success',
          last_error: null,
        },
      });
      
      // Update polling job
      await prisma.pollingJob.update({
        where: { id: pollingJob.id },
        data: {
          status: 'completed',
          completed_at: new Date(),
          records_fetched: pollResult.recordsFetched,
          records_processed: recordsProcessed,
          bytes_processed: pollResult.bytesProcessed,
        },
      });

      // Audit log
      await this.auditService.logAction({
        connectionId: connection.id,
        action: 'polled',
        success: true,
        newValues: {
          records_fetched: pollResult.recordsFetched,
          records_processed: recordsProcessed,
        },
      });

      console.log(`Completed polling job ${pollingJob.id}: ${recordsProcessed} records processed`);

      return {
        id: pollingJob.id,
        connectionId: connection.id,
        startedAt: pollingJob.started_at,
        status: 'completed',
        recordsFetched: pollResult.recordsFetched,
        recordsProcessed,
        bytesProcessed: pollResult.bytesProcessed,
      };
      
    } catch (error) {
      console.error(`Polling job ${pollingJob.id} failed:`, error);
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Update connection with error
      await prisma.dataConnection.update({
        where: { id: connection.id },
        data: {
          last_poll_status: 'error',
          last_error: errorMessage,
        },
      });
      
      // Update polling job
      await prisma.pollingJob.update({
        where: { id: pollingJob.id },
        data: {
          status: 'failed',
          completed_at: new Date(),
          error_message: errorMessage,
        },
      });

      // Audit log
      await this.auditService.logAction({
        connectionId: connection.id,
        action: 'polling_failed',
        success: false,
        errorMessage,
      });
      
      return {
        id: pollingJob.id,
        connectionId: connection.id,
        startedAt: pollingJob.started_at,
        status: 'failed',
        errorMessage,
      };
      
    } finally {
      this.activeJobs.delete(connection.id);
    }
  }

  private async pollByType(
    connection: any,
    fromTime: Date,
    toTime: Date,
    signal: AbortSignal
  ): Promise<{
    data: PlantMetric[];
    recordsFetched: number;
    bytesProcessed: number;
    /** Cloud connectors persist readings themselves; this overrides data.length. */
    recordsProcessed?: number;
  }> {
    switch (connection.type) {
      case 'influxdb':
        return await this.pollInfluxDB(connection, fromTime, toTime, signal);
      case 'sql_scada':
        return await this.pollSQLScada(connection, fromTime, toTime, signal);
      case 'modbus_tcp':
        return await this.pollModbus(connection, fromTime, toTime, signal);
      case 'huawei_api':
        return await this.pollHuaweiAPI(connection, fromTime, toTime, signal);
      case 'solaredge_api':
        return await this.pollSolarEdge(connection, fromTime, toTime, signal);
      case 'sungrow_api':
        return await this.pollSungrowAPI(connection, fromTime, toTime, signal);
      case 'sample_api':
        return await this.pollSampleApi(connection, fromTime, toTime, signal);
      default:
        throw new Error(`Unsupported connection type: ${connection.type}`);
    }
  }

  private async pollInfluxDB(
    connection: any,
    fromTime: Date,
    toTime: Date,
    signal: AbortSignal
  ): Promise<{ data: PlantMetric[]; recordsFetched: number; bytesProcessed: number }> {
    const influxService = new InfluxDBService();
    
    try {
      await influxService.connect(connection);
      
      // Get all plants for this connection
      const plants = await prisma.discoveredPlant.findMany({
        where: { connection_id: connection.id, enabled: true },
      });
      
      const allData: PlantMetric[] = [];
      let totalRecords = 0;
      let totalBytes = 0;
      
      for (const plant of plants) {
        if (signal.aborted) break;
        
        // Query data for this plant
        const plantData = await this.queryInfluxDBPlantData(
          influxService,
          plant.external_plant_id,
          fromTime,
          toTime,
          connection.field_mappings
        );
        
        allData.push(...plantData);
        totalRecords += plantData.length;
        totalBytes += JSON.stringify(plantData).length;
      }
      
      return {
        data: allData,
        recordsFetched: totalRecords,
        bytesProcessed: totalBytes,
      };
      
    } finally {
      await influxService.close();
    }
  }

  private async queryInfluxDBPlantData(
    influxService: InfluxDBService,
    plantId: string,
    fromTime: Date,
    toTime: Date,
    fieldMappings: any[]
  ): Promise<PlantMetric[]> {
    // This is a simplified version - in production, you'd build more sophisticated queries
    const rawData = await influxService.getDataPreview(plantId, 10000);
    
    // Transform raw data using field mappings
    return rawData.map(row => {
      const metric: PlantMetric = {
        plant_id: plantId,
        timestamp: new Date(row._time || row.timestamp || Date.now()),
      };
      
      // Apply field mappings
      for (const mapping of fieldMappings) {
        const rawValue = row[mapping.original_field];
        if (rawValue !== undefined && rawValue !== null) {
          // Apply scaling and offset
          const scaledValue = (rawValue * (mapping.scaling_factor || 1)) + (mapping.offset || 0);
          metric[mapping.mapped_field] = scaledValue;
        }
      }
      
      return metric;
    }).filter(metric => 
      metric.timestamp >= fromTime && metric.timestamp <= toTime
    );
  }

  private async pollSQLScada(
    connection: any,
    fromTime: Date,
    toTime: Date,
    signal: AbortSignal
  ): Promise<{ data: PlantMetric[]; recordsFetched: number; bytesProcessed: number }> {
    const sqlService = new SQLScadaService();
    
    try {
      await sqlService.connect(connection);
      
      // TODO: Implement SQL SCADA polling
      // This would query the SQL database for data in the time range
      
      return {
        data: [],
        recordsFetched: 0,
        bytesProcessed: 0,
      };
      
    } finally {
      await sqlService.close();
    }
  }

  private async pollModbus(
    connection: any,
    fromTime: Date,
    toTime: Date,
    signal: AbortSignal
  ): Promise<{ data: PlantMetric[]; recordsFetched: number; bytesProcessed: number }> {
    const modbusService = new ModbusService();
    
    try {
      await modbusService.connect(connection);
      
      // For Modbus, we typically get current values, not historical data
      const currentData = await modbusService.readDeviceInfo();
      
      const metric: PlantMetric = {
        plant_id: connection.id, // Use connection ID as plant ID for Modbus
        timestamp: new Date(),
        // Map Modbus data to metrics based on field mappings
      };
      
      return {
        data: [metric],
        recordsFetched: 1,
        bytesProcessed: JSON.stringify(metric).length,
      };
      
    } finally {
      await modbusService.close();
    }
  }

  private async pollHuaweiAPI(
    connection: any,
    fromTime: Date,
    toTime: Date,
    signal: AbortSignal
  ): Promise<{
    data: PlantMetric[];
    recordsFetched: number;
    bytesProcessed: number;
    recordsProcessed: number;
  }> {
    const huaweiService = new HuaweiFusionSolarService();

    try {
      await huaweiService.connect(connection);

      // Restore device inventory captured at discovery time (stored on
      // DiscoveredPlant.metadata.devices). Fall back to a live discovery if
      // the connection was never discovered or predates device storage.
      const plants = await prisma.discoveredPlant.findMany({
        where: { connection_id: connection.id, enabled: true },
      });

      let devices: NormalizedDevice[] = plants.flatMap(plant => {
        const meta = plant.metadata as Record<string, any> | null;
        return Array.isArray(meta?.devices) ? (meta!.devices as NormalizedDevice[]) : [];
      });

      if (devices.length > 0) {
        huaweiService.setDeviceInventory(devices);
      } else {
        let plantIds = plants.map(p => p.external_plant_id);
        if (plantIds.length === 0) {
          const discovered = await huaweiService.discoverPlants();
          plantIds = discovered.map(p => p.external_plant_id);
        }
        devices = await huaweiService.discoverDevices(plantIds);
      }

      if (signal.aborted) {
        return { data: [], recordsFetched: 0, bytesProcessed: 0, recordsProcessed: 0 };
      }

      // Realtime KPIs for all inverter + EMI devices of the connection.
      const readings = await huaweiService.pollRealtime();

      // Land readings in the lake as Parquet (long format).
      let bytesProcessed = 0;
      if (readings.length > 0) {
        const rows: LakeReadingRow[] = readings.map(r => ({
          ts: r.ts,
          plant_ext_id: r.plant_ext_id,
          device_ext_id: r.device_ext_id,
          device_type: r.device_type,
          metric: r.metric,
          value: r.value,
          unit: r.unit,
        }));
        const written = await this.lakeWriter.writeReadings(connection.id, rows);
        bytesProcessed = written.bytes;
      }

      // Best-effort latest-KPI snapshots (dashboard cache). A missing table
      // (migration not applied yet) must not fail the poll.
      await this.upsertDeviceSnapshots(connection.id, readings);

      // FusionSolar battery dataItemMap keys were never verified, so none are
      // in the static vendor mapping. Persisting what the wire actually carried
      // is the only way those key names ever become known — in memory they die
      // with the service instance.
      await this.recordUnmappedFields(
        connection.id,
        huaweiService.getUnmappedKeys().map(k => ({
          original_field: k.scoped_field,
          field_path: k.key,
          observation: {
            vendor: 'huawei_fusionsolar',
            scope: k.scope,
            vendor_key: k.key,
            sample_value: k.sample_value,
            times_seen: k.seen,
          },
        }))
      );

      return {
        data: [], // lake write replaces the legacy S3 metrics path
        recordsFetched: readings.length,
        recordsProcessed: readings.length,
        bytesProcessed,
      };

    } finally {
      await huaweiService.close();
    }
  }

  private async pollSolarEdge(
    connection: any,
    fromTime: Date,
    toTime: Date,
    signal: AbortSignal
  ): Promise<{
    data: PlantMetric[];
    recordsFetched: number;
    bytesProcessed: number;
    recordsProcessed: number;
  }> {
    const solarEdgeService = new SolarEdgeMonitoringService();

    try {
      await solarEdgeService.connect(connection);

      // Restore device inventory captured at discovery time (stored on
      // DiscoveredPlant.metadata.devices — includes each site's timezone,
      // which SolarEdge data calls require). Fall back to a live discovery if
      // the connection was never discovered or predates device storage.
      const plants = await prisma.discoveredPlant.findMany({
        where: { connection_id: connection.id, enabled: true },
      });

      let devices: NormalizedDevice[] = plants.flatMap(plant => {
        const meta = plant.metadata as Record<string, any> | null;
        return Array.isArray(meta?.devices) ? (meta!.devices as NormalizedDevice[]) : [];
      });

      if (devices.length > 0) {
        solarEdgeService.setDeviceInventory(devices);
      } else {
        let plantIds = plants.map(p => p.external_plant_id);
        if (plantIds.length === 0) {
          const discovered = await solarEdgeService.discoverPlants();
          plantIds = discovered.map(p => p.external_plant_id);
        }
        devices = await solarEdgeService.discoverDevices(plantIds);
      }

      if (signal.aborted) {
        return { data: [], recordsFetched: 0, bytesProcessed: 0, recordsProcessed: 0 };
      }

      // Site-level KPIs + trailing per-inverter telemetry window.
      const readings = await solarEdgeService.pollRealtime();

      // Land readings in the lake as Parquet (long format).
      let bytesProcessed = 0;
      if (readings.length > 0) {
        const rows: LakeReadingRow[] = readings.map(r => ({
          ts: r.ts,
          plant_ext_id: r.plant_ext_id,
          device_ext_id: r.device_ext_id,
          device_type: r.device_type,
          metric: r.metric,
          value: r.value,
          unit: r.unit,
        }));
        const written = await this.lakeWriter.writeReadings(connection.id, rows);
        bytesProcessed = written.bytes;
      }

      // Best-effort latest-KPI snapshots (dashboard cache). A missing table
      // (migration not applied yet) must not fail the poll.
      await this.upsertDeviceSnapshots(connection.id, readings);

      return {
        data: [], // lake write replaces the legacy S3 metrics path
        recordsFetched: readings.length,
        recordsProcessed: readings.length,
        bytesProcessed,
      };

    } finally {
      await solarEdgeService.close();
    }
  }

  private async pollSungrowAPI(
    connection: any,
    fromTime: Date,
    toTime: Date,
    signal: AbortSignal
  ): Promise<{
    data: PlantMetric[];
    recordsFetched: number;
    bytesProcessed: number;
    recordsProcessed: number;
  }> {
    const sungrowService = new SungrowISolarCloudService();

    try {
      await sungrowService.connect(connection);

      // Restore device inventory captured at discovery time (stored on
      // DiscoveredPlant.metadata.devices). Fall back to a live discovery if
      // the connection was never discovered or predates device storage.
      const plants = await prisma.discoveredPlant.findMany({
        where: { connection_id: connection.id, enabled: true },
      });

      let devices: NormalizedDevice[] = plants.flatMap(plant => {
        const meta = plant.metadata as Record<string, any> | null;
        return Array.isArray(meta?.devices) ? (meta!.devices as NormalizedDevice[]) : [];
      });

      if (devices.length > 0) {
        sungrowService.setDeviceInventory(devices);
      } else {
        let plantIds = plants.map(p => p.external_plant_id);
        if (plantIds.length === 0) {
          const discovered = await sungrowService.discoverPlants();
          plantIds = discovered.map(p => p.external_plant_id);
        }
        devices = await sungrowService.discoverDevices(plantIds);
      }

      if (signal.aborted) {
        return { data: [], recordsFetched: 0, bytesProcessed: 0, recordsProcessed: 0 };
      }

      // Realtime measurement points for every plant this connection can see.
      // Returns nothing until an operator supplies a point map: iSolarCloud
      // point ids are account specific, so there is no default catalogue.
      const readings = await sungrowService.pollRealtime();

      // Land readings in the lake as Parquet (long format).
      let bytesProcessed = 0;
      if (readings.length > 0) {
        const rows: LakeReadingRow[] = readings.map(r => ({
          ts: r.ts,
          plant_ext_id: r.plant_ext_id,
          device_ext_id: r.device_ext_id,
          device_type: r.device_type,
          metric: r.metric,
          value: r.value,
          unit: r.unit,
        }));
        const written = await this.lakeWriter.writeReadings(connection.id, rows);
        bytesProcessed = written.bytes;
      }

      // Best-effort latest-KPI snapshots (dashboard cache).
      await this.upsertDeviceSnapshots(connection.id, readings);

      // Points the API described that the operator's point map does not cover.
      // This is how an unconfigured Sungrow connection gets a real, account
      // specific point catalogue to map from instead of a guessed one.
      await this.recordUnmappedFields(
        connection.id,
        sungrowService.getUnmappedPoints().map(p => ({
          original_field: `sungrow.p${p.point_id}`,
          field_path: `p${p.point_id}`,
          unit: p.point_unit,
          observation: {
            vendor: 'sungrow_isolarcloud',
            point_id: p.point_id,
            point_name: p.point_name,
            point_unit: p.point_unit,
          },
        }))
      );

      return {
        data: [], // lake write replaces the legacy S3 metrics path
        recordsFetched: readings.length,
        recordsProcessed: readings.length,
        bytesProcessed,
      };

    } finally {
      await sungrowService.close();
    }
  }

  private async pollSampleApi(
    connection: any,
    fromTime: Date,
    toTime: Date,
    signal: AbortSignal
  ): Promise<{
    data: PlantMetric[];
    recordsFetched: number;
    bytesProcessed: number;
    recordsProcessed: number;
  }> {
    const sampleService = new SampleApiService();
    await sampleService.connect(connection);

    // Plant/fleet context comes from the connection's linked PlantDataSource
    // rows (created by the sample-feed provisioner or the onboarding wizard).
    // A bare, unlinked sample connection falls back to the service's built-in
    // default plant so it still polls.
    const sources = await prisma.plantDataSource.findMany({
      where: { connection_id: connection.id, enabled: true },
      include: {
        plant: {
          include: {
            inverter_groups: { include: { inverters: { where: { enabled: true } } } },
          },
        },
      },
    });

    const contexts: SamplePlantContext[] = [];
    const seenPlantIds = new Set<string>();
    for (const source of sources) {
      const plant = source.plant;
      if (!plant || seenPlantIds.has(plant.id)) continue;
      seenPlantIds.add(plant.id);

      const inverters = plant.inverter_groups.flatMap(group =>
        group.inverters.map(inv => ({
          externalId: inv.external_id,
          nominalPowerKw: Number(inv.nominal_power_kw ?? group.inverter_nominal_power_kw ?? 200),
        }))
      );

      contexts.push({
        plant_ext_id: plant.slug,
        name: plant.name,
        latitude: Number(plant.latitude),
        longitude: Number(plant.longitude),
        timezone: plant.timezone,
        capacity_mw: Number(plant.capacity_mw),
        seedKey: plant.id,
        devices: inverters.length > 0 ? inverters : defaultFleet(Number(plant.capacity_mw)),
      });
    }
    sampleService.setPlantContexts(contexts);

    if (signal.aborted) {
      return { data: [], recordsFetched: 0, bytesProcessed: 0, recordsProcessed: 0 };
    }

    // Synthetic realtime KPIs — same downstream handling as the vendor paths.
    const readings = await sampleService.pollRealtime();

    // Land readings in the lake as Parquet (long format).
    let bytesProcessed = 0;
    if (readings.length > 0) {
      const rows: LakeReadingRow[] = readings.map(r => ({
        ts: r.ts,
        plant_ext_id: r.plant_ext_id,
        device_ext_id: r.device_ext_id,
        device_type: r.device_type,
        metric: r.metric,
        value: r.value,
        unit: r.unit,
      }));
      const written = await this.lakeWriter.writeReadings(connection.id, rows);
      bytesProcessed = written.bytes;
    }

    // Best-effort latest-KPI snapshots (dashboard cache).
    await this.upsertDeviceSnapshots(connection.id, readings);

    return {
      data: [], // lake write replaces the legacy S3 metrics path
      recordsFetched: readings.length,
      recordsProcessed: readings.length,
      bytesProcessed,
    };
  }

  /**
   * Upsert LatestDeviceSnapshot rows (one per device) from a batch of
   * normalized readings. Degrades gracefully: if the table doesn't exist yet
   * or the Prisma client is stale, log once and continue.
   */
  private async upsertDeviceSnapshots(
    connectionId: string,
    readings: NormalizedReading[]
  ): Promise<void> {
    if (readings.length === 0) return;

    interface SnapshotAccumulator {
      plant_ext_id: string;
      device_type?: string;
      ts: number;
      active_power_kw?: number;
      daily_energy_kwh?: number;
      extra: Record<string, number>;
    }

    const byDevice = new Map<string, SnapshotAccumulator>();
    for (const reading of readings) {
      let snap = byDevice.get(reading.device_ext_id);
      if (!snap) {
        snap = {
          plant_ext_id: reading.plant_ext_id,
          device_type: reading.device_type,
          ts: reading.ts,
          extra: {},
        };
        byDevice.set(reading.device_ext_id, snap);
      }
      snap.ts = Math.max(snap.ts, reading.ts);
      if (reading.metric === 'power_ac') {
        snap.active_power_kw = reading.value;
      } else if (reading.metric === 'energy_daily') {
        snap.daily_energy_kwh = reading.value;
      } else {
        snap.extra[reading.metric] = reading.value;
      }
    }

    try {
      const snapshotModel = (prisma as any).latestDeviceSnapshot;
      if (!snapshotModel) {
        throw new Error('latestDeviceSnapshot model not present on Prisma client (run prisma generate)');
      }
      for (const [deviceId, snap] of Array.from(byDevice.entries())) {
        await snapshotModel.upsert({
          where: {
            connection_id_device_ext_id: {
              connection_id: connectionId,
              device_ext_id: deviceId,
            },
          },
          create: {
            connection_id: connectionId,
            plant_ext_id: snap.plant_ext_id,
            device_ext_id: deviceId,
            device_type: snap.device_type,
            ts: new Date(snap.ts),
            active_power_kw: snap.active_power_kw,
            daily_energy_kwh: snap.daily_energy_kwh,
            extra: snap.extra,
          },
          update: {
            plant_ext_id: snap.plant_ext_id,
            device_type: snap.device_type,
            ts: new Date(snap.ts),
            active_power_kw: snap.active_power_kw,
            daily_energy_kwh: snap.daily_energy_kwh,
            extra: snap.extra,
          },
        });
      }
    } catch (error) {
      if (!PollingService.snapshotTableWarned) {
        console.warn(
          'LatestDeviceSnapshot upsert failed (table missing or Prisma client stale) — polls continue without snapshots:',
          error instanceof Error ? error.message : error
        );
        PollingService.snapshotTableWarned = true;
      }
    }
  }

  /**
   * Persist vendor fields seen on the wire that no mapping covers.
   *
   * Cloud connectors collect these in memory (HuaweiFusionSolarService
   * .getUnmappedKeys(), SungrowISolarCloudService.getUnmappedPoints()) and
   * would otherwise discard them when the service instance dies. They are the
   * only honest route from real traffic to a real mapping: nothing here guesses
   * what a field means.
   *
   * Surface: unconfirmed FieldMapping rows with mapped_field 'unmapped' (the
   * enum member that exists precisely for "requires user input"). Chosen over
   * DiscoveredPlant.metadata because these are connection scoped rather than
   * plant scoped, because @@unique([connection_id, original_field]) makes the
   * write idempotent across polls, and because the row lands in exactly the
   * table the mapping UI already reads — an operator maps it in place. The poll
   * itself only ever loads confirmed mappings, so these rows cannot leak into
   * ingestion.
   *
   * Cost: one createMany per poll, skipDuplicates, and only when something new
   * was observed. skipDuplicates also guarantees a mapping an operator has
   * already confirmed is never overwritten.
   */
  private async recordUnmappedFields(
    connectionId: string,
    fields: Array<{
      original_field: string;
      field_path?: string;
      unit?: string;
      observation: Record<string, any>;
    }>
  ): Promise<void> {
    if (fields.length === 0) return;

    // A misbehaving account should not turn one poll into an unbounded write.
    const MAX_PER_POLL = 200;
    const batch = fields.slice(0, MAX_PER_POLL);

    // Prisma rejects undefined inside a Json value, and an absent observation
    // detail should simply be absent rather than recorded as null.
    const defined = (record: Record<string, any>): Record<string, any> => {
      const out: Record<string, any> = {};
      for (const [key, value] of Array.from(Object.entries(record))) {
        if (value !== undefined) out[key] = value;
      }
      return out;
    };

    try {
      await prisma.fieldMapping.createMany({
        data: batch.map(field => ({
          connection_id: connectionId,
          original_field: field.original_field,
          mapped_field: 'unmapped' as DataFieldType,
          field_path: field.field_path,
          unit: field.unit,
          confidence_score: 0,
          is_confirmed: false,
          validation_rules: { observed_during_poll: defined(field.observation) },
        })),
        skipDuplicates: true,
      });
    } catch (error) {
      // Never fail a poll over an observation record.
      if (!PollingService.unmappedFieldWarned) {
        console.warn(
          'Unmapped-field observation write failed — polls continue without it:',
          error instanceof Error ? error.message : error
        );
        PollingService.unmappedFieldWarned = true;
      }
    }
  }

  async stopPolling(connectionId: string): Promise<void> {
    const abortController = this.activeJobs.get(connectionId);
    if (abortController) {
      abortController.abort();
      this.activeJobs.delete(connectionId);
      
      console.log(`Stopped polling for connection ${connectionId}`);
    }
  }

  async getPollingStatus(): Promise<{
    activeJobs: number;
    totalConnections: number;
    healthyConnections: number;
    errorConnections: number;
  }> {
    const totalConnections = await prisma.dataConnection.count({
      where: { enabled: true },
    });
    
    const healthyConnections = await prisma.dataConnection.count({
      where: { 
        enabled: true,
        status: 'connected',
        last_poll_status: { not: 'error' },
      },
    });
    
    const errorConnections = await prisma.dataConnection.count({
      where: { 
        enabled: true,
        last_poll_status: 'error',
      },
    });
    
    return {
      activeJobs: this.activeJobs.size,
      totalConnections,
      healthyConnections,
      errorConnections,
    };
  }

  async cleanup(): Promise<void> {
    // Stop all active jobs
    this.activeJobs.forEach((controller, connectionId) => {
      controller.abort();
    });
    this.activeJobs.clear();
    
    // Cleanup S3 storage
    await this.s3Storage.cleanup();
    
    console.log('Polling service cleaned up');
  }
}