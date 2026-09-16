import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { DataFieldType, type DataConnection } from '@prisma/client';
import {
  FieldMappingIntelligence,
  analyzeDataStructureAuto,
  type DataStructureResult,
  type FieldMappingResult,
} from '@/lib/services/field-mapping-intelligence';
import {
  llmPolishMappings,
  LLM_FALLBACK_THRESHOLD,
} from '@/lib/services/field-mapping-llm';
import { HuaweiFusionSolarService } from '@/lib/services/huawei-api-service';
import { SolarEdgeMonitoringService } from '@/lib/services/solaredge-api-service';
import { SungrowISolarCloudService } from '@/lib/services/sungrow-api-service';
import { CredentialService } from '@/lib/services/credentials';
import type { NormalizedDevice } from '@/lib/services/cloud-connector';
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

interface DiscoveryResult {
  status: 'completed' | 'in_progress' | 'failed';
  progress?: number;
  structure?: DataStructureResult;
  plants?: Array<{
    id: string;
    name: string;
    location?: { lat?: number; lng?: number; country?: string };
    capacity_mw?: number;
    inverter_count?: number;
    data_range?: { start?: string; end?: string };
  }>;
  fieldMappings?: FieldMappingResult[];
  recommendations?: string[];
  error?: string;
  /**
   * Cloud connectors (fixed vendor schemas) persist their own results —
   * skip the generic heuristic-mapper persistence block for those.
   */
  persisted?: boolean;
}

// POST /api/connections/[connectionId]/discover - Trigger discovery
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

    // Get connection and verify org ownership
    const connection = await prisma.dataConnection.findUnique({
      where: {
        id: connectionId,
      },
    });

    if (!connection || !ownsConnection(ctx, connection)) {
      return NextResponse.json(
        { error: 'Connection not found' },
        { status: 404 }
      );
    }

    // Check connection status
    if (connection.status !== 'connected' && connection.status !== 'pending') {
      return NextResponse.json(
        { error: `Cannot discover from connection with status: ${connection.status}` },
        { status: 400 }
      );
    }

    // Run discovery based on connection type
    const config = connection.config as Record<string, any>;
    let result: DiscoveryResult;

    switch (connection.type) {
      case 'influxdb':
        result = await discoverInfluxDB(connectionId, config);
        break;
      case 'sql_scada':
        result = await discoverSQLScada(connectionId, config);
        break;
      case 'modbus_tcp':
        result = await discoverModbus(connectionId, config);
        break;
      case 'csv_upload':
        result = await discoverCSV(connectionId, config);
        break;
      case 'huawei_api':
        result = await discoverHuaweiAPI(connection);
        break;
      case 'solaredge_api':
        result = await discoverSolarEdge(connection);
        break;
      case 'sungrow_api':
        result = await discoverSungrowAPI(connection);
        break;
      default:
        result = {
          status: 'failed',
          error: `Unknown connection type: ${connection.type}`,
        };
    }

    // LLM polish pass: catch ambiguous columns the regex couldn't classify.
    // Runs against any result that has field mappings, regardless of which
    // connector produced it. Failures fall back to the regex result — never
    // blocks the discovery flow.
    if (
      result.status === 'completed' &&
      result.fieldMappings &&
      result.fieldMappings.length > 0 &&
      process.env.NURAVOLT_LLM_FIELD_MAPPING_ENABLED !== '0'
    ) {
      const lowConfCount = result.fieldMappings.filter(
        m => m.confidence < LLM_FALLBACK_THRESHOLD
      ).length;
      if (lowConfCount > 0) {
        try {
          const sampleMap = new Map<string, any[]>();
          for (const m of result.fieldMappings) {
            sampleMap.set(m.originalField, m.sampleValues || []);
          }
          const detectedVendor = result.structure?.hierarchy?.pattern?.vendor;
          const polished = await llmPolishMappings(result.fieldMappings, sampleMap, {
            contextHints: { vendor: detectedVendor },
            concurrency: 3,
          });
          result.fieldMappings = polished.polished;
          if (result.structure) {
            result.structure.fieldMappings = polished.polished;
          }
          console.log(
            `[discover] LLM polish: ${polished.llmCallsMade} calls, ` +
            `${polished.llmAcceptedCount} accepted, ${polished.llmRejectedCount} kept-regex`
          );
        } catch (err) {
          console.warn('[discover] LLM polish failed, keeping regex results:', err);
        }
      }
    }

    // If discovery succeeded, store results (cloud connectors with fixed
    // vendor schemas persist their own results and set result.persisted)
    if (result.status === 'completed' && result.structure && !result.persisted) {
      // Store data structure analysis
      await prisma.dataStructureAnalysis.upsert({
        where: { connection_id: connectionId },
        create: {
          connection_id: connectionId,
          data_format: result.structure.format,
          timestamp_format: result.structure.timestampFormat?.strptime,
          timestamp_column: result.structure.timestampColumn,
          total_columns: result.structure.columns.length,
          numeric_columns: result.structure.columns.filter(c => c.type === 'numeric').length,
          string_columns: result.structure.columns.filter(c => c.type === 'string').length,
          datetime_columns: result.structure.columns.filter(c => c.type === 'datetime').length,
          detected_plants: result.structure.hierarchy?.plants || [],
          detected_inverters: result.structure.hierarchy?.inverters
            ? Object.fromEntries(result.structure.hierarchy.inverters)
            : null,
          hierarchy_pattern: result.structure.hierarchy?.hierarchyString,
          column_statistics: result.structure.columns.map(c => ({
            name: c.column,
            type: c.type,
            nullRate: c.nullCount / c.count,
            uniqueCount: c.uniqueCount,
          })),
        },
        update: {
          data_format: result.structure.format,
          timestamp_format: result.structure.timestampFormat?.strptime,
          timestamp_column: result.structure.timestampColumn,
          total_columns: result.structure.columns.length,
          numeric_columns: result.structure.columns.filter(c => c.type === 'numeric').length,
          string_columns: result.structure.columns.filter(c => c.type === 'string').length,
          datetime_columns: result.structure.columns.filter(c => c.type === 'datetime').length,
          detected_plants: result.structure.hierarchy?.plants || [],
          detected_inverters: result.structure.hierarchy?.inverters
            ? Object.fromEntries(result.structure.hierarchy.inverters)
            : null,
          hierarchy_pattern: result.structure.hierarchy?.hierarchyString,
          column_statistics: result.structure.columns.map(c => ({
            name: c.column,
            type: c.type,
            nullRate: c.nullCount / c.count,
            uniqueCount: c.uniqueCount,
          })),
          analyzed_at: new Date(),
        },
      });

      // Store field mappings
      if (result.fieldMappings) {
        for (const mapping of result.fieldMappings) {
          if (mapping.mappedType !== 'unmapped') {
            await prisma.fieldMapping.upsert({
              where: {
                connection_id_original_field: {
                  connection_id: connectionId,
                  original_field: mapping.originalField,
                },
              },
              create: {
                connection_id: connectionId,
                original_field: mapping.originalField,
                mapped_field: mapping.mappedType as DataFieldType,
                unit: mapping.unit,
                scaling_factor: mapping.scalingFactor || 1.0,
                offset: mapping.offset || 0.0,
                validation_rules: mapping.validationRules,
                confidence_score: mapping.confidence,
                is_confirmed: mapping.confidence >= 0.85, // Auto-confirm high confidence
              },
              update: {
                mapped_field: mapping.mappedType as DataFieldType,
                unit: mapping.unit,
                scaling_factor: mapping.scalingFactor || 1.0,
                offset: mapping.offset || 0.0,
                validation_rules: mapping.validationRules,
                confidence_score: mapping.confidence,
              },
            });
          }
        }
      }

      // Store discovered plants
      if (result.plants) {
        for (const plant of result.plants) {
          await prisma.discoveredPlant.upsert({
            where: {
              connection_id_external_plant_id: {
                connection_id: connectionId,
                external_plant_id: plant.id,
              },
            },
            create: {
              connection_id: connectionId,
              external_plant_id: plant.id,
              name: plant.name,
              location: plant.location,
              capacity_mw: plant.capacity_mw,
              inverter_count: plant.inverter_count,
              first_data_timestamp: plant.data_range?.start ? new Date(plant.data_range.start) : undefined,
              last_data_timestamp: plant.data_range?.end ? new Date(plant.data_range.end) : undefined,
            },
            update: {
              name: plant.name,
              location: plant.location,
              capacity_mw: plant.capacity_mw,
              inverter_count: plant.inverter_count,
              first_data_timestamp: plant.data_range?.start ? new Date(plant.data_range.start) : undefined,
              last_data_timestamp: plant.data_range?.end ? new Date(plant.data_range.end) : undefined,
            },
          });
        }

        // Update connection with plant count
        await prisma.dataConnection.update({
          where: { id: connectionId },
          data: {
            plants_connected: result.plants.length,
            status: 'connected',
          },
        });
      }
    }

    // Log audit event
    await prisma.connectionAudit.create({
      data: {
        connection_id: connectionId,
        action: 'discovered',
        user_id: ctx.userId,
        success: result.status === 'completed',
        error_message: result.error,
        new_values: {
          plantsFound: result.plants?.length || 0,
          fieldsFound: result.fieldMappings?.length || 0,
          qualityScore: result.structure?.qualityScore,
        },
      },
    });

    return NextResponse.json({
      data: result,
    });
  } catch (error) {
    console.error('Error running discovery:', error);
    return NextResponse.json(
      { error: 'Failed to run discovery' },
      { status: 500 }
    );
  }
}

// GET /api/connections/[connectionId]/discover - Get discovery results
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;

    const { connectionId } = await params;

    // Get connection with discovery data and verify org ownership
    const connection = await prisma.dataConnection.findUnique({
      where: {
        id: connectionId,
      },
      include: {
        structure_analysis: true,
        field_mappings: {
          orderBy: { confidence_score: 'desc' },
        },
        discovered_plants: {
          orderBy: { name: 'asc' },
        },
      },
    });

    if (!connection || !ownsConnection(ctx, connection)) {
      return NextResponse.json(
        { error: 'Connection not found' },
        { status: 404 }
      );
    }

    // Format response
    const result: DiscoveryResult = {
      status: connection.structure_analysis ? 'completed' : 'pending' as any,
      structure: connection.structure_analysis ? {
        format: connection.structure_analysis.data_format as 'wide' | 'long' | 'mixed',
        timestampColumn: connection.structure_analysis.timestamp_column || undefined,
        timestampFormat: connection.structure_analysis.timestamp_format ? {
          name: 'detected',
          regex: /.*/,
          strptime: connection.structure_analysis.timestamp_format,
        } : undefined,
        columns: (connection.structure_analysis.column_statistics as any[] || []).map((c: any) => ({
          column: c.name,
          type: c.type,
          count: 0,
          nullCount: 0,
          uniqueCount: c.uniqueCount,
          sampleValues: [] as any[],
        })),
        hierarchy: {
          pattern: null,
          plants: connection.structure_analysis.detected_plants as string[] || [],
          groups: new Map(),
          inverters: new Map(Object.entries(connection.structure_analysis.detected_inverters as Record<string, string[]> || {})),
          hierarchyString: connection.structure_analysis.hierarchy_pattern || undefined,
        },
        fieldMappings: connection.field_mappings.map(m => ({
          originalField: m.original_field,
          mappedType: m.mapped_field,
          confidence: Number(m.confidence_score) || 0,
          unit: m.unit || undefined,
          scalingFactor: Number(m.scaling_factor) || 1,
          offset: Number(m.offset) || 0,
          validationRules: m.validation_rules as any,
        })),
        qualityScore: 0,
        recommendations: [],
      } : undefined,
      plants: connection.discovered_plants.map(p => ({
        id: p.external_plant_id,
        name: p.name || p.external_plant_id,
        location: p.location as any,
        capacity_mw: p.capacity_mw ? Number(p.capacity_mw) : undefined,
        inverter_count: p.inverter_count || undefined,
        data_range: {
          start: p.first_data_timestamp?.toISOString(),
          end: p.last_data_timestamp?.toISOString(),
        },
      })),
      fieldMappings: connection.field_mappings.map(m => ({
        originalField: m.original_field,
        mappedType: m.mapped_field,
        confidence: Number(m.confidence_score) || 0,
        unit: m.unit || undefined,
        scalingFactor: Number(m.scaling_factor) || 1,
        offset: Number(m.offset) || 0,
        validationRules: m.validation_rules as any,
      })),
    };

    return NextResponse.json({ data: result });
  } catch (error) {
    console.error('Error fetching discovery results:', error);
    return NextResponse.json(
      { error: 'Failed to fetch discovery results' },
      { status: 500 }
    );
  }
}

// ============================================================================
// Discovery implementations for each connection type
// ============================================================================

async function discoverInfluxDB(
  connectionId: string,
  config: Record<string, any>
): Promise<DiscoveryResult> {
  const { url, token, org, bucket } = config;

  try {
    const { InfluxDB } = await import('@influxdata/influxdb-client');
    const client = new InfluxDB({ url, token });
    const queryApi = client.getQueryApi(org);

    // Get all fields
    const fieldsQuery = `
      import "influxdata/influxdb/schema"
      schema.fieldKeys(bucket: "${bucket}")
    `;
    const fieldRows = await queryApi.collectRows(fieldsQuery);
    const fieldNames = fieldRows.map((row: any) => row._value);

    // Get sample data for each field
    const columns: Array<{ name: string; sampleValues: any[] }> = [];

    for (const fieldName of fieldNames) {
      try {
        const sampleQuery = `
          from(bucket: "${bucket}")
            |> range(start: -7d)
            |> filter(fn: (r) => r._field == "${fieldName}")
            |> limit(n: 20)
        `;
        const samples = await queryApi.collectRows(sampleQuery);
        columns.push({
          name: fieldName,
          sampleValues: samples.map((s: any) => s._value),
        });
      } catch {
        columns.push({ name: fieldName, sampleValues: [] });
      }
    }

    // Analyze structure with field mapping intelligence
    const structure = analyzeDataStructureAuto(columns);

    // Get plants
    const plants: DiscoveryResult['plants'] = [];
    try {
      const plantsQuery = `
        import "influxdata/influxdb/schema"
        schema.tagValues(bucket: "${bucket}", tag: "plant_id", start: -30d)
      `;
      const plantRows = await queryApi.collectRows(plantsQuery);

      for (const row of plantRows) {
        const plantId = (row as any)._value;
        plants.push({
          id: plantId,
          name: plantId,
        });
      }
    } catch {
      // plant_id tag might not exist
    }

    return {
      status: 'completed',
      structure,
      plants,
      fieldMappings: structure.fieldMappings,
      recommendations: structure.recommendations,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: `InfluxDB discovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function discoverSQLScada(
  connectionId: string,
  config: Record<string, any>
): Promise<DiscoveryResult> {
  // The SQL SCADA connector backend does not exist yet. Report a real failure
  // rather than a "completed" discovery with zero plants (which dead-ended the
  // wizard at an empty Confirm step with no honest signal).
  return {
    status: 'failed',
    error:
      'SQL SCADA connector is not available yet. To get data in now, use CSV upload or the measurements ingest API.',
  };
}

async function discoverModbus(
  connectionId: string,
  config: Record<string, any>
): Promise<DiscoveryResult> {
  // Not built yet; report honestly (see discoverSQLScada).
  return {
    status: 'failed',
    error:
      'Modbus TCP connector is not available yet. To get data in now, use CSV upload or the measurements ingest API.',
  };
}

async function discoverCSV(
  connectionId: string,
  config: Record<string, any>
): Promise<DiscoveryResult> {
  // CSV discovery happens when file is uploaded
  return {
    status: 'completed',
    structure: {
      format: 'wide',
      columns: [],
      fieldMappings: [],
      qualityScore: 0,
      recommendations: ['Upload a CSV file to analyze its structure'],
    },
    plants: [],
    fieldMappings: [],
    recommendations: ['Upload a CSV file to start'],
  };
}

const HUAWEI_INVERTER_DEV_TYPE_IDS = [1, 38];

/**
 * Real Huawei FusionSolar discovery: authenticate → stations → devices →
 * persist plants (device inventory in metadata), static field mappings
 * (vendor schema is fixed — heuristic/LLM mapper bypassed), structure
 * analysis and connection status. Sets `persisted` so the generic
 * persistence block is skipped.
 */
async function discoverHuaweiAPI(connection: DataConnection): Promise<DiscoveryResult> {
  const connectionId = connection.id;
  const config = (connection.config ?? {}) as Record<string, any>;
  const service = new HuaweiFusionSolarService();

  try {
    // Best-effort migration of plaintext config credentials to Secrets
    // Manager (per-customer KMS). Failure is non-fatal — the service falls
    // back to config credentials.
    if (!connection.secret_arn && (config.userName || config.username)) {
      try {
        const arn = await new CredentialService().storeCredentials(connection.customer_id, {
          userName: config.userName || config.username,
          systemCode: config.systemCode || config.password,
        });
        await prisma.dataConnection.update({
          where: { id: connectionId },
          data: { secret_arn: arn },
        });
        connection = { ...connection, secret_arn: arn };
      } catch (err) {
        console.warn('[discover] Huawei credential migration to Secrets Manager failed, using config:', err);
      }
    }

    await service.connect(connection);
    await service.authenticate();

    const plants = await service.discoverPlants();
    const devices = await service.discoverDevices(plants.map(p => p.external_plant_id));
    const mappings = service.staticFieldMappings();

    // Group device inventory per plant
    const devicesByPlant = new Map<string, NormalizedDevice[]>();
    for (const device of devices) {
      const list = devicesByPlant.get(device.external_plant_id) ?? [];
      list.push(device);
      devicesByPlant.set(device.external_plant_id, list);
    }

    // Upsert DiscoveredPlant rows (device inventory stored in metadata so the
    // poll path doesn't need to re-discover)
    for (const plant of plants) {
      const plantDevices = devicesByPlant.get(plant.external_plant_id) ?? [];
      const inverters = plantDevices.filter(
        d => d.vendor_type_id != null && HUAWEI_INVERTER_DEV_TYPE_IDS.includes(d.vendor_type_id)
      );
      const inverterTypes = Array.from(
        new Set(inverters.map(d => d.model).filter((m): m is string => !!m))
      );

      await prisma.discoveredPlant.upsert({
        where: {
          connection_id_external_plant_id: {
            connection_id: connectionId,
            external_plant_id: plant.external_plant_id,
          },
        },
        create: {
          connection_id: connectionId,
          external_plant_id: plant.external_plant_id,
          name: plant.name,
          location: plant.location as any,
          capacity_mw: plant.capacity_mw,
          inverter_count: inverters.length,
          inverter_types: inverterTypes,
          commissioning_date:
            plant.commissioning_date && !isNaN(Date.parse(plant.commissioning_date))
              ? new Date(plant.commissioning_date)
              : undefined,
          timezone: plant.timezone,
          metadata: { ...plant.metadata, devices: plantDevices } as any,
        },
        update: {
          name: plant.name,
          location: plant.location as any,
          capacity_mw: plant.capacity_mw,
          inverter_count: inverters.length,
          inverter_types: inverterTypes,
          metadata: { ...plant.metadata, devices: plantDevices } as any,
        },
      });
    }

    // Bulk-create confirmed field mappings from the static vendor schema.
    // skipDuplicates keeps re-discovery idempotent and preserves any manual edits.
    await prisma.fieldMapping.createMany({
      data: mappings.map(m => ({
        connection_id: connectionId,
        original_field: m.original_field,
        mapped_field: m.mapped_field as DataFieldType,
        unit: m.unit,
        scaling_factor: m.scaling_factor ?? 1.0,
        confidence_score: 1.0,
        is_confirmed: true,
      })),
      skipDuplicates: true,
    });

    // Structure analysis — fixed vendor schema, described for the UI
    const plantIds = plants.map(p => p.external_plant_id);
    const detectedInverters: Record<string, string[]> = {};
    for (const [plantId, plantDevices] of Array.from(devicesByPlant.entries())) {
      detectedInverters[plantId] = plantDevices
        .filter(d => d.vendor_type_id != null && HUAWEI_INVERTER_DEV_TYPE_IDS.includes(d.vendor_type_id))
        .map(d => d.external_device_id);
    }
    const structureData = {
      data_format: 'long',
      timestamp_column: 'collectTime',
      total_columns: mappings.length,
      numeric_columns: mappings.length,
      string_columns: 0,
      datetime_columns: 1,
      detected_plants: plantIds,
      detected_inverters: detectedInverters,
      hierarchy_pattern: 'FusionSolar: station / device / dataItem',
      column_statistics: mappings.map(m => ({
        name: m.original_field,
        type: 'numeric',
        nullRate: 0,
        uniqueCount: 0,
      })),
    };
    await prisma.dataStructureAnalysis.upsert({
      where: { connection_id: connectionId },
      create: { connection_id: connectionId, ...structureData },
      update: { ...structureData, analyzed_at: new Date() },
    });

    // Update connection status like the InfluxDB path does
    await prisma.dataConnection.update({
      where: { id: connectionId },
      data: {
        plants_connected: plants.length,
        status: 'connected',
        last_error: null,
      },
    });

    // Build the API response (mirrors what the generic path returns)
    const fieldMappings: FieldMappingResult[] = mappings.map(m => ({
      originalField: m.original_field,
      mappedType: m.mapped_field as DataFieldType,
      confidence: 1.0,
      unit: m.unit,
      scalingFactor: m.scaling_factor ?? 1,
      offset: 0,
    }));

    const structure: DataStructureResult = {
      format: 'long',
      timestampColumn: 'collectTime',
      columns: mappings.map(m => ({
        column: m.original_field,
        type: 'numeric' as const,
        count: 0,
        nullCount: 0,
        uniqueCount: 0,
        sampleValues: [] as any[],
      })),
      hierarchy: {
        pattern: null,
        plants: plantIds,
        groups: new Map(),
        inverters: new Map(Object.entries(detectedInverters)),
        hierarchyString: 'FusionSolar: station / device / dataItem',
      },
      fieldMappings,
      qualityScore: 1,
      recommendations: [],
    };

    return {
      status: 'completed',
      persisted: true,
      structure,
      plants: plants.map(p => ({
        id: p.external_plant_id,
        name: p.name,
        location: p.location,
        capacity_mw: p.capacity_mw,
        inverter_count: (devicesByPlant.get(p.external_plant_id) ?? []).filter(
          d => d.vendor_type_id != null && HUAWEI_INVERTER_DEV_TYPE_IDS.includes(d.vendor_type_id)
        ).length,
      })),
      fieldMappings,
      recommendations: [
        `Discovered ${plants.length} plant(s) and ${devices.length} device(s) from FusionSolar`,
        'Field mappings are vendor-fixed (confidence 1.0) — no manual confirmation needed',
      ],
    };
  } catch (error) {
    return {
      status: 'failed',
      error: `Huawei FusionSolar discovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  } finally {
    await service.close();
  }
}

/** Device classes the Sungrow connector treats as inverters when counting. */
const SUNGROW_INVERTER_CLASSES = ['string_inverter', 'residential_inverter'];

/**
 * Sungrow iSolarCloud discovery: authenticate → power stations → devices →
 * persist plants (device inventory in metadata), the operator-supplied point
 * map as field mappings, structure analysis and connection status. Sets
 * `persisted` so the generic persistence block is skipped. Mirrors
 * discoverSolarEdge().
 *
 * Unlike Huawei and SolarEdge there is no built-in vendor schema: iSolarCloud
 * returns measurements as account-specific `p<point_id>` keys whose catalogue
 * is not public, so field mappings come only from the operator's point map.
 * With no point map the discovery still succeeds (stations and devices are
 * real) and says plainly that no measurement points are mapped yet. The poll
 * path then records every point the API describes so the map can be filled in
 * from real traffic rather than guessed.
 */
async function discoverSungrowAPI(connection: DataConnection): Promise<DiscoveryResult> {
  const connectionId = connection.id;
  const config = (connection.config ?? {}) as Record<string, any>;
  const service = new SungrowISolarCloudService();

  try {
    // Best-effort migration of plaintext config credentials to Secrets Manager
    // (per-customer KMS). Failure is non-fatal — the service falls back to
    // config credentials.
    const appkey = config.appkey || config.app_key || config.appKey;
    const accessKey = config.access_key || config.accessKey || config.x_access_key;
    if (!connection.secret_arn && appkey && accessKey) {
      try {
        const arn = await new CredentialService().storeCredentials(connection.customer_id, {
          appkey,
          access_key: accessKey,
          user_account: config.user_account || config.userAccount || config.username,
          user_password: config.user_password || config.userPassword || config.password,
          token: config.token,
        });
        await prisma.dataConnection.update({
          where: { id: connectionId },
          data: { secret_arn: arn },
        });
        connection = { ...connection, secret_arn: arn };
      } catch (err) {
        console.warn('[discover] Sungrow credential migration to Secrets Manager failed, using config:', err);
      }
    }

    await service.connect(connection);
    await service.authenticate();

    const plants = await service.discoverPlants();
    const devices = await service.discoverDevices(plants.map(p => p.external_plant_id));
    const mappings = service.staticFieldMappings();

    // Group device inventory per plant
    const devicesByPlant = new Map<string, NormalizedDevice[]>();
    for (const device of devices) {
      const list = devicesByPlant.get(device.external_plant_id) ?? [];
      list.push(device);
      devicesByPlant.set(device.external_plant_id, list);
    }

    // Upsert DiscoveredPlant rows (device inventory stored in metadata so the
    // poll path doesn't need to re-discover)
    for (const plant of plants) {
      const plantDevices = devicesByPlant.get(plant.external_plant_id) ?? [];
      const inverters = plantDevices.filter(
        d => d.device_type != null && SUNGROW_INVERTER_CLASSES.includes(d.device_type)
      );
      const inverterTypes = Array.from(
        new Set(inverters.map(d => d.model).filter((m): m is string => !!m))
      );

      await prisma.discoveredPlant.upsert({
        where: {
          connection_id_external_plant_id: {
            connection_id: connectionId,
            external_plant_id: plant.external_plant_id,
          },
        },
        create: {
          connection_id: connectionId,
          external_plant_id: plant.external_plant_id,
          name: plant.name,
          location: plant.location as any,
          capacity_mw: plant.capacity_mw,
          inverter_count: inverters.length,
          inverter_types: inverterTypes,
          commissioning_date:
            plant.commissioning_date && !isNaN(Date.parse(plant.commissioning_date))
              ? new Date(plant.commissioning_date)
              : undefined,
          timezone: plant.timezone,
          metadata: { ...plant.metadata, devices: plantDevices } as any,
        },
        update: {
          name: plant.name,
          location: plant.location as any,
          capacity_mw: plant.capacity_mw,
          inverter_count: inverters.length,
          inverter_types: inverterTypes,
          metadata: { ...plant.metadata, devices: plantDevices } as any,
        },
      });
    }

    // Field mappings come from the operator's point map only. Confidence is 1.0
    // because the operator declared the meaning; nothing here is inferred.
    if (mappings.length > 0) {
      await prisma.fieldMapping.createMany({
        data: mappings.map(m => ({
          connection_id: connectionId,
          original_field: m.original_field,
          mapped_field: m.mapped_field as DataFieldType,
          unit: m.unit,
          scaling_factor: m.scaling_factor ?? 1.0,
          confidence_score: 1.0,
          is_confirmed: true,
        })),
        skipDuplicates: true,
      });
    }

    // Structure analysis — described for the UI
    const plantIds = plants.map(p => p.external_plant_id);
    const detectedInverters: Record<string, string[]> = {};
    for (const [plantId, plantDevices] of Array.from(devicesByPlant.entries())) {
      detectedInverters[plantId] = plantDevices
        .filter(d => d.device_type != null && SUNGROW_INVERTER_CLASSES.includes(d.device_type))
        .map(d => d.external_device_id);
    }
    const hierarchyString = 'iSolarCloud: station / device / measurement point';
    const structureData = {
      data_format: 'long',
      timestamp_column: 'time_stamp',
      total_columns: mappings.length,
      numeric_columns: mappings.length,
      string_columns: 0,
      datetime_columns: 1,
      detected_plants: plantIds,
      detected_inverters: detectedInverters,
      hierarchy_pattern: hierarchyString,
      column_statistics: mappings.map(m => ({
        name: m.original_field,
        type: 'numeric',
        nullRate: 0,
        uniqueCount: 0,
      })),
    };
    await prisma.dataStructureAnalysis.upsert({
      where: { connection_id: connectionId },
      create: { connection_id: connectionId, ...structureData },
      update: { ...structureData, analyzed_at: new Date() },
    });

    await prisma.dataConnection.update({
      where: { id: connectionId },
      data: {
        plants_connected: plants.length,
        status: 'connected',
        last_error: null,
      },
    });

    const fieldMappings: FieldMappingResult[] = mappings.map(m => ({
      originalField: m.original_field,
      mappedType: m.mapped_field as DataFieldType,
      confidence: 1.0,
      unit: m.unit,
      scalingFactor: m.scaling_factor ?? 1,
      offset: 0,
    }));

    const structure: DataStructureResult = {
      format: 'long',
      timestampColumn: 'time_stamp',
      columns: mappings.map(m => ({
        column: m.original_field,
        type: 'numeric' as const,
        count: 0,
        nullCount: 0,
        uniqueCount: 0,
        sampleValues: [] as any[],
      })),
      hierarchy: {
        pattern: null,
        plants: plantIds,
        groups: new Map(),
        inverters: new Map(Object.entries(detectedInverters)),
        hierarchyString,
      },
      fieldMappings,
      qualityScore: mappings.length > 0 ? 1 : 0,
      recommendations: [],
    };

    const recommendations = [
      `Discovered ${plants.length} station(s) and ${devices.length} device(s) from iSolarCloud`,
    ];
    if (mappings.length === 0) {
      recommendations.push(
        'No measurement points are mapped yet. iSolarCloud point ids are specific to your account, so add a point map to the connection config before polling stores any readings.'
      );
    } else {
      recommendations.push(
        `${mappings.length} measurement point(s) mapped from the connection point map.`
      );
    }
    if (devices.some(d => d.device_type === 'other')) {
      recommendations.push(
        'Some devices could not be classified. Add a device type map to the connection config to name them.'
      );
    }

    return {
      status: 'completed',
      persisted: true,
      structure,
      plants: plants.map(p => ({
        id: p.external_plant_id,
        name: p.name,
        location: p.location,
        capacity_mw: p.capacity_mw,
        inverter_count: (devicesByPlant.get(p.external_plant_id) ?? []).filter(
          d => d.device_type != null && SUNGROW_INVERTER_CLASSES.includes(d.device_type)
        ).length,
      })),
      fieldMappings,
      recommendations,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: `Sungrow iSolarCloud discovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  } finally {
    await service.close();
  }
}

/**
 * Real SolarEdge monitoring-API discovery: verify api_key → sites (paginated)
 * → per-site inventory → persist plants (device inventory in metadata), static
 * field mappings (vendor schema is fixed — heuristic/LLM mapper bypassed),
 * structure analysis and connection status. Sets `persisted` so the generic
 * persistence block is skipped. Mirrors discoverHuaweiAPI().
 */
async function discoverSolarEdge(connection: DataConnection): Promise<DiscoveryResult> {
  const connectionId = connection.id;
  const config = (connection.config ?? {}) as Record<string, any>;
  const service = new SolarEdgeMonitoringService();

  try {
    // Best-effort migration of a plaintext config api_key to Secrets Manager
    // (per-customer KMS). Failure is non-fatal — the service falls back to
    // config credentials.
    if (!connection.secret_arn && (config.api_key || config.apiKey)) {
      try {
        const arn = await new CredentialService().storeCredentials(connection.customer_id, {
          api_key: config.api_key || config.apiKey,
        });
        await prisma.dataConnection.update({
          where: { id: connectionId },
          data: { secret_arn: arn },
        });
        connection = { ...connection, secret_arn: arn };
      } catch (err) {
        console.warn('[discover] SolarEdge credential migration to Secrets Manager failed, using config:', err);
      }
    }

    await service.connect(connection);
    await service.authenticate();

    const plants = await service.discoverPlants();
    const devices = await service.discoverDevices(plants.map(p => p.external_plant_id));
    const mappings = service.staticFieldMappings();

    // Group device inventory per plant
    const devicesByPlant = new Map<string, NormalizedDevice[]>();
    for (const device of devices) {
      const list = devicesByPlant.get(device.external_plant_id) ?? [];
      list.push(device);
      devicesByPlant.set(device.external_plant_id, list);
    }

    // Upsert DiscoveredPlant rows (device inventory stored in metadata so the
    // poll path doesn't need to re-discover)
    for (const plant of plants) {
      const plantDevices = devicesByPlant.get(plant.external_plant_id) ?? [];
      const inverters = plantDevices.filter(d => d.device_type === 'string_inverter');
      const inverterTypes = Array.from(
        new Set(inverters.map(d => d.model).filter((m): m is string => !!m))
      );

      await prisma.discoveredPlant.upsert({
        where: {
          connection_id_external_plant_id: {
            connection_id: connectionId,
            external_plant_id: plant.external_plant_id,
          },
        },
        create: {
          connection_id: connectionId,
          external_plant_id: plant.external_plant_id,
          name: plant.name,
          location: plant.location as any,
          capacity_mw: plant.capacity_mw,
          inverter_count: inverters.length,
          inverter_types: inverterTypes,
          commissioning_date:
            plant.commissioning_date && !isNaN(Date.parse(plant.commissioning_date))
              ? new Date(plant.commissioning_date)
              : undefined,
          timezone: plant.timezone,
          metadata: { ...plant.metadata, devices: plantDevices } as any,
        },
        update: {
          name: plant.name,
          location: plant.location as any,
          capacity_mw: plant.capacity_mw,
          inverter_count: inverters.length,
          inverter_types: inverterTypes,
          metadata: { ...plant.metadata, devices: plantDevices } as any,
        },
      });
    }

    // Bulk-create confirmed field mappings from the static vendor schema.
    // skipDuplicates keeps re-discovery idempotent and preserves any manual edits.
    await prisma.fieldMapping.createMany({
      data: mappings.map(m => ({
        connection_id: connectionId,
        original_field: m.original_field,
        mapped_field: m.mapped_field as DataFieldType,
        unit: m.unit,
        scaling_factor: m.scaling_factor ?? 1.0,
        confidence_score: 1.0,
        is_confirmed: true,
      })),
      skipDuplicates: true,
    });

    // Structure analysis — fixed vendor schema, described for the UI
    const plantIds = plants.map(p => p.external_plant_id);
    const detectedInverters: Record<string, string[]> = {};
    for (const [plantId, plantDevices] of Array.from(devicesByPlant.entries())) {
      detectedInverters[plantId] = plantDevices
        .filter(d => d.device_type === 'string_inverter')
        .map(d => d.external_device_id);
    }
    const structureData = {
      data_format: 'long',
      timestamp_column: 'date',
      total_columns: mappings.length,
      numeric_columns: mappings.length,
      string_columns: 0,
      datetime_columns: 1,
      detected_plants: plantIds,
      detected_inverters: detectedInverters,
      hierarchy_pattern: 'SolarEdge: site / inverter / telemetry',
      column_statistics: mappings.map(m => ({
        name: m.original_field,
        type: 'numeric',
        nullRate: 0,
        uniqueCount: 0,
      })),
    };
    await prisma.dataStructureAnalysis.upsert({
      where: { connection_id: connectionId },
      create: { connection_id: connectionId, ...structureData },
      update: { ...structureData, analyzed_at: new Date() },
    });

    // Update connection status like the Huawei path does
    await prisma.dataConnection.update({
      where: { id: connectionId },
      data: {
        plants_connected: plants.length,
        status: 'connected',
        last_error: null,
      },
    });

    // Build the API response (mirrors what the generic path returns)
    const fieldMappings: FieldMappingResult[] = mappings.map(m => ({
      originalField: m.original_field,
      mappedType: m.mapped_field as DataFieldType,
      confidence: 1.0,
      unit: m.unit,
      scalingFactor: m.scaling_factor ?? 1,
      offset: 0,
    }));

    const structure: DataStructureResult = {
      format: 'long',
      timestampColumn: 'date',
      columns: mappings.map(m => ({
        column: m.original_field,
        type: 'numeric' as const,
        count: 0,
        nullCount: 0,
        uniqueCount: 0,
        sampleValues: [] as any[],
      })),
      hierarchy: {
        pattern: null,
        plants: plantIds,
        groups: new Map(),
        inverters: new Map(Object.entries(detectedInverters)),
        hierarchyString: 'SolarEdge: site / inverter / telemetry',
      },
      fieldMappings,
      qualityScore: 1,
      recommendations: [],
    };

    return {
      status: 'completed',
      persisted: true,
      structure,
      plants: plants.map(p => ({
        id: p.external_plant_id,
        name: p.name,
        location: p.location,
        capacity_mw: p.capacity_mw,
        inverter_count: (devicesByPlant.get(p.external_plant_id) ?? []).filter(
          d => d.device_type === 'string_inverter'
        ).length,
      })),
      fieldMappings,
      recommendations: [
        `Discovered ${plants.length} site(s) and ${devices.length} device(s) from SolarEdge`,
        'Field mappings are vendor-fixed (confidence 1.0) — no manual confirmation needed',
      ],
    };
  } catch (error) {
    return {
      status: 'failed',
      error: `SolarEdge discovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  } finally {
    await service.close();
  }
}
