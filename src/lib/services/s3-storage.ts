import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import parquetjs from 'parquetjs';

export interface PlantMetric {
  plant_id: string;
  inverter_id?: string;
  timestamp: Date;
  power_ac?: number;
  power_dc?: number;
  voltage_dc?: number;
  current_dc?: number;
  power_loss?: number;
  financial_impact?: number;
  irradiance_poa?: number;
  irradiance_ghi?: number;
  temp_module?: number;
  temp_ambient?: number;
  energy_daily?: number;
  energy_total?: number;
  [key: string]: any;
}

export interface S3StorageConfig {
  bucket: string;
  region: string;
  keyPrefix: string;
}

export class S3ParquetStorage {
  private s3Client: S3Client;
  private config: S3StorageConfig;
  private dataBuffer: Map<string, PlantMetric[]> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 1000;
  private readonly FLUSH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  constructor(config: S3StorageConfig) {
    this.config = config;
    this.s3Client = new S3Client({
      region: config.region,
    });

    // Start automatic flushing
    this.startAutoFlush();
  }

  async addMetrics(metrics: PlantMetric[]): Promise<void> {
    for (const metric of metrics) {
      const partitionKey = this.getPartitionKey(metric);
      
      if (!this.dataBuffer.has(partitionKey)) {
        this.dataBuffer.set(partitionKey, []);
      }
      
      const buffer = this.dataBuffer.get(partitionKey)!;
      buffer.push(metric);
      
      // Flush if buffer is full
      if (buffer.length >= this.BATCH_SIZE) {
        await this.flushPartition(partitionKey);
      }
    }
  }

  async addSingleMetric(metric: PlantMetric): Promise<void> {
    await this.addMetrics([metric]);
  }

  private getPartitionKey(metric: PlantMetric): string {
    const date = new Date(metric.timestamp);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');
    
    return `plant_id=${metric.plant_id}/year=${year}/month=${month}/day=${day}/hour=${hour}`;
  }

  private async flushPartition(partitionKey: string): Promise<void> {
    const buffer = this.dataBuffer.get(partitionKey);
    if (!buffer || buffer.length === 0) {
      return;
    }

    try {
      const parquetData = await this.convertToParquet(buffer);
      const timestamp = Date.now();
      const filename = `${partitionKey}/batch_${timestamp}.parquet`;
      const s3Key = `${this.config.keyPrefix}/${filename}`;

      const putCommand = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: s3Key,
        Body: parquetData,
        ContentType: 'application/octet-stream',
        Metadata: {
          'records-count': buffer.length.toString(),
          'created-at': new Date().toISOString(),
          'partition': partitionKey,
        },
        ServerSideEncryption: 'AES256',
      });

      await this.s3Client.send(putCommand);
      
      console.log(`Successfully stored ${buffer.length} metrics to ${s3Key}`);
      
      // Clear the buffer
      this.dataBuffer.set(partitionKey, []);
    } catch (error) {
      console.error(`Failed to flush partition ${partitionKey}:`, error);
      // Keep the data in buffer for retry
      throw error;
    }
  }

  private async convertToParquet(metrics: PlantMetric[]): Promise<Buffer> {
    // For now, we'll store as JSON until we can add a proper Parquet library
    // In production, you'd use a library like parquetjs or arrow-js
    const jsonData = metrics.map(metric => ({
      ...metric,
      timestamp: metric.timestamp.toISOString(),
    }));

    // Simple compression using gzip-like approach
    const jsonString = JSON.stringify(jsonData);
    return Buffer.from(jsonString, 'utf-8');
  }

  async flushAll(): Promise<void> {
    const flushPromises = Array.from(this.dataBuffer.keys()).map(
      partitionKey => this.flushPartition(partitionKey)
    );
    
    await Promise.all(flushPromises);
  }

  private startAutoFlush(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }

    this.flushInterval = setInterval(async () => {
      try {
        await this.flushAll();
      } catch (error) {
        console.error('Auto-flush failed:', error);
      }
    }, this.FLUSH_INTERVAL_MS);
  }

  async queryMetrics(
    plantId: string,
    startDate: Date,
    endDate: Date
  ): Promise<PlantMetric[]> {
    const s3Objects = await this.listS3Objects(plantId, startDate, endDate);
    const metrics: PlantMetric[] = [];

    for (const object of s3Objects) {
      if (object.Key) {
        try {
          const data = await this.getS3Object(object.Key);
          const parsedMetrics = await this.parseParquetData(data);
          metrics.push(...parsedMetrics);
        } catch (error) {
          console.warn(`Failed to read object ${object.Key}:`, error);
        }
      }
    }

    return metrics.filter(metric => 
      metric.timestamp >= startDate && metric.timestamp <= endDate
    ).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  private async listS3Objects(
    plantId: string,
    startDate: Date,
    endDate: Date
  ): Promise<any[]> {
    const objects: any[] = [];
    
    // Generate potential partition prefixes
    const prefixes = this.generatePartitionPrefixes(plantId, startDate, endDate);
    
    for (const prefix of prefixes) {
      const listCommand = new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: `${this.config.keyPrefix}/${prefix}`,
        MaxKeys: 1000,
      });

      try {
        const response = await this.s3Client.send(listCommand);
        if (response.Contents) {
          objects.push(...response.Contents);
        }
      } catch (error) {
        console.warn(`Failed to list objects for prefix ${prefix}:`, error);
      }
    }

    return objects;
  }

  private generatePartitionPrefixes(
    plantId: string,
    startDate: Date,
    endDate: Date
  ): string[] {
    const prefixes: string[] = [];
    const current = new Date(startDate);
    
    while (current <= endDate) {
      const year = current.getUTCFullYear();
      const month = String(current.getUTCMonth() + 1).padStart(2, '0');
      const day = String(current.getUTCDate()).padStart(2, '0');
      
      prefixes.push(`plant_id=${plantId}/year=${year}/month=${month}/day=${day}`);
      
      current.setUTCDate(current.getUTCDate() + 1);
    }
    
    return prefixes;
  }

  private async getS3Object(key: string): Promise<Buffer> {
    const getCommand = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
    });

    const response = await this.s3Client.send(getCommand);
    
    if (response.Body instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } else if (response.Body) {
      return Buffer.from(await response.Body.transformToByteArray());
    } else {
      throw new Error('No data received from S3');
    }
  }

  private async parseParquetData(data: Buffer): Promise<PlantMetric[]> {
    // For now, parse as JSON (in production, use proper Parquet parser)
    try {
      const jsonString = data.toString('utf-8');
      const parsed = JSON.parse(jsonString);
      
      return parsed.map((item: any) => ({
        ...item,
        timestamp: new Date(item.timestamp),
      }));
    } catch (error) {
      console.error('Failed to parse data:', error);
      return [];
    }
  }

  async getStorageStats(plantId?: string): Promise<{
    totalObjects: number;
    totalSizeBytes: number;
    oldestData: Date | null;
    newestData: Date | null;
  }> {
    const prefix = plantId 
      ? `${this.config.keyPrefix}/plant_id=${plantId}/`
      : `${this.config.keyPrefix}/`;

    const listCommand = new ListObjectsV2Command({
      Bucket: this.config.bucket,
      Prefix: prefix,
    });

    const response = await this.s3Client.send(listCommand);
    const objects = response.Contents || [];

    const totalSizeBytes = objects.reduce((sum, obj) => sum + (obj.Size || 0), 0);
    const dates = objects
      .map(obj => obj.LastModified)
      .filter(date => date !== undefined) as Date[];

    return {
      totalObjects: objects.length,
      totalSizeBytes,
      oldestData: dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))) : null,
      newestData: dates.length > 0 ? new Date(Math.max(...dates.map(d => d.getTime()))) : null,
    };
  }

  async cleanup(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    
    // Flush any remaining data
    await this.flushAll();
  }

  // Method for testing/development
  async debugBuffer(): Promise<Record<string, number>> {
    const bufferSizes: Record<string, number> = {};
    this.dataBuffer.forEach((metrics, partition) => {
      bufferSizes[partition] = metrics.length;
    });
    return bufferSizes;
  }
}

// ============================================================================
// Lake landing zone writer (bronze/live) — real Parquet via parquetjs.
//
// Separate from the legacy S3ParquetStorage above (which buffers PlantMetric
// JSON blobs into the legacy 'heliosiq-plant-data' bucket). This writer emits
// genuine Parquet files, one object per poll run, in long format:
//   ts | plant_ext_id | device_ext_id | device_type | metric | value | unit
// at s3://{LAKE_BUCKET}/bronze/live/{connection_id}/{YYYY-MM-DD}/{epoch_ms}.parquet
// ============================================================================

export interface LakeReadingRow {
  /** Epoch milliseconds or Date. */
  ts: number | Date;
  plant_ext_id: string;
  device_ext_id: string;
  device_type?: string;
  /** DataFieldType member name. */
  metric: string;
  value: number;
  unit?: string;
}

export interface ParquetLakeWriterConfig {
  bucket?: string;
  region?: string;
  /** Key prefix before {connection_id}/{date}/{epoch}.parquet. Default 'bronze/live'. */
  keyPrefix?: string;
}

const LAKE_PARQUET_SCHEMA = new parquetjs.ParquetSchema({
  ts: { type: 'TIMESTAMP_MILLIS' },
  plant_ext_id: { type: 'UTF8' },
  device_ext_id: { type: 'UTF8' },
  device_type: { type: 'UTF8', optional: true },
  metric: { type: 'UTF8' },
  value: { type: 'DOUBLE' },
  unit: { type: 'UTF8', optional: true },
});

export class ParquetLakeWriter {
  private s3Client: S3Client;
  private bucket: string;
  private keyPrefix: string;

  constructor(config: ParquetLakeWriterConfig = {}) {
    this.bucket = config.bucket || process.env.LAKE_BUCKET || 'nuravolt-lake';
    this.keyPrefix = (config.keyPrefix ?? 'bronze/live').replace(/\/+$/, '');
    this.s3Client = new S3Client({
      region: config.region || process.env.AWS_REGION || 'eu-west-1',
    });
  }

  /** Encode rows as a Parquet buffer (exposed for tests). */
  static async toParquetBuffer(rows: LakeReadingRow[]): Promise<Buffer> {
    if (rows.length === 0) {
      throw new Error('Cannot build a Parquet file with zero rows');
    }
    const chunks: Buffer[] = [];
    const sink = {
      write(buf: Buffer, cb: (err?: Error | null) => void) {
        chunks.push(buf);
        cb();
      },
      close(cb: (err?: Error | null) => void) {
        cb();
      },
    };
    const writer = await parquetjs.ParquetWriter.openStream(
      LAKE_PARQUET_SCHEMA,
      sink as any
    );
    for (const row of rows) {
      await writer.appendRow({
        ts: row.ts instanceof Date ? row.ts : new Date(row.ts),
        plant_ext_id: row.plant_ext_id,
        device_ext_id: row.device_ext_id,
        device_type: row.device_type ?? null,
        metric: row.metric,
        value: row.value,
        unit: row.unit ?? null,
      });
    }
    await writer.close();
    return Buffer.concat(chunks);
  }

  buildKey(connectionId: string, epochMs: number): string {
    const d = new Date(epochMs);
    const day = [
      d.getUTCFullYear(),
      String(d.getUTCMonth() + 1).padStart(2, '0'),
      String(d.getUTCDate()).padStart(2, '0'),
    ].join('-');
    return `${this.keyPrefix}/${connectionId}/${day}/${epochMs}.parquet`;
  }

  /** Write one Parquet object for a poll run. Returns key + byte size. */
  async writeReadings(
    connectionId: string,
    rows: LakeReadingRow[],
    epochMs: number = Date.now()
  ): Promise<{ key: string; bytes: number; records: number }> {
    if (rows.length === 0) {
      return { key: '', bytes: 0, records: 0 };
    }
    const body = await ParquetLakeWriter.toParquetBuffer(rows);
    const key = this.buildKey(connectionId, epochMs);

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
        Metadata: {
          'records-count': rows.length.toString(),
          'created-at': new Date().toISOString(),
          'connection-id': connectionId,
        },
        ServerSideEncryption: 'AES256',
      })
    );

    console.log(`Lake write: ${rows.length} readings → s3://${this.bucket}/${key}`);
    return { key, bytes: body.length, records: rows.length };
  }
}