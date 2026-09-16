import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { ConnectionType } from '@prisma/client';
import { requireOrg, hasOrgManageRole, forbidden } from '@/lib/api/tenant';

interface TestResult {
  success: boolean;
  message: string;
  responseTime?: number;
  details?: {
    plantsFound?: number;
    fieldsFound?: number;
    dataPointsEstimated?: number;
    timeRange?: {
      start?: string;
      end?: string;
    };
    sampleData?: any[];
  };
  warnings?: string[];
  errors?: string[];
}

// POST /api/connections/[connectionId]/test - Test connection
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const startTime = Date.now();

  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    if (!hasOrgManageRole(ctx)) return forbidden('org_manage_role_required');

    const { connectionId } = await params;

    // Get connection and verify org ownership (demo identity may also see
    // legacy demo rows)
    const connection = await prisma.dataConnection.findUnique({
      where: {
        id: connectionId,
      },
    });

    if (
      !connection ||
      !(
        connection.organization_id === ctx.org.id ||
        (ctx.isDemo && connection.customer_id === 'demo_customer')
      )
    ) {
      return NextResponse.json(
        { error: 'Connection not found' },
        { status: 404 }
      );
    }

    // Test based on connection type
    const config = connection.config as Record<string, any>;
    let result: TestResult;

    switch (connection.type) {
      case 'influxdb':
        result = await testInfluxDB(config);
        break;
      case 'sql_scada':
        result = await testSQLScada(config);
        break;
      case 'modbus_tcp':
        result = await testModbus(config);
        break;
      case 'csv_upload':
        result = await testCSVUpload(config);
        break;
      case 'huawei_api':
        result = await testHuaweiAPI(connection);
        break;
      case 'solaredge_api':
        result = await testSolarEdgeAPI(config);
        break;
      case 'sungrow_api':
        result = await testSungrowAPI(connection);
        break;
      default:
        result = {
          success: false,
          message: `Unknown connection type: ${connection.type}`,
        };
    }

    result.responseTime = Date.now() - startTime;

    // Update connection status based on test result
    const newStatus = result.success ? 'connected' : 'error';
    await prisma.dataConnection.update({
      where: { id: connectionId },
      data: {
        status: newStatus,
        last_poll_time: new Date(),
        last_poll_status: result.success ? 'success' : 'failed',
        last_error: result.success ? null : result.message,
      },
    });

    // Log audit event
    await prisma.connectionAudit.create({
      data: {
        connection_id: connectionId,
        action: 'tested',
        user_id: ctx.userId,
        success: result.success,
        error_message: result.success ? undefined : result.message,
        new_values: {
          responseTime: result.responseTime,
          plantsFound: result.details?.plantsFound,
          fieldsFound: result.details?.fieldsFound,
        },
      },
    });

    return NextResponse.json({
      data: result,
    });
  } catch (error) {
    console.error('Error testing connection:', error);

    const responseTime = Date.now() - startTime;

    return NextResponse.json({
      data: {
        success: false,
        message: `Test failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        responseTime,
      },
    });
  }
}

// Test InfluxDB connection
async function testInfluxDB(config: Record<string, any>): Promise<TestResult> {
  const { url, token, org, bucket } = config;

  if (!url || !token || !org || !bucket) {
    return {
      success: false,
      message: 'Missing required configuration: url, token, org, bucket',
    };
  }

  try {
    // Import InfluxDB client dynamically
    const { InfluxDB } = await import('@influxdata/influxdb-client');

    const client = new InfluxDB({ url, token });
    const queryApi = client.getQueryApi(org);

    // Test query to check connection and get basic info
    const testQuery = `
      from(bucket: "${bucket}")
        |> range(start: -1d)
        |> limit(n: 1)
    `;

    let dataPoints = 0;
    const rows: any[] = [];

    await queryApi.collectRows(testQuery).then(result => {
      dataPoints = result.length;
      rows.push(...result.slice(0, 5));
    });

    // Get field count
    const fieldsQuery = `
      import "influxdata/influxdb/schema"
      schema.fieldKeys(bucket: "${bucket}")
    `;
    const fieldsResult = await queryApi.collectRows(fieldsQuery);

    // Get plant count (if plant_id tag exists)
    let plantsFound = 0;
    try {
      const plantsQuery = `
        import "influxdata/influxdb/schema"
        schema.tagValues(bucket: "${bucket}", tag: "plant_id", start: -30d)
      `;
      const plantsResult = await queryApi.collectRows(plantsQuery);
      plantsFound = plantsResult.length;
    } catch {
      // plant_id tag might not exist
    }

    return {
      success: true,
      message: 'Successfully connected to InfluxDB',
      details: {
        plantsFound,
        fieldsFound: fieldsResult.length,
        sampleData: rows,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: `InfluxDB connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      errors: [error instanceof Error ? error.message : 'Unknown error'],
    };
  }
}

// Test SQL SCADA connection.
// The SQL SCADA connector backend is not built yet, so we report that honestly
// rather than faking a green check (which used to mark the connection
// "connected" and leave the poll cron retrying a connector that does nothing).
async function testSQLScada(_config: Record<string, any>): Promise<TestResult> {
  return {
    success: false,
    message:
      'SQL SCADA connector is not available yet. To get data in now, use CSV upload or the measurements ingest API.',
    warnings: ['SQL SCADA is on our roadmap. Contact us if you need it prioritised for your site.'],
  };
}

// Test Modbus TCP connection. Not built yet; report honestly (see testSQLScada).
async function testModbus(_config: Record<string, any>): Promise<TestResult> {
  return {
    success: false,
    message:
      'Modbus TCP connector is not available yet. To get data in now, use CSV upload or the measurements ingest API.',
    warnings: ['Modbus is on our roadmap. Contact us if you need it prioritised for your site.'],
  };
}

// Test CSV Upload (just validates config)
async function testCSVUpload(config: Record<string, any>): Promise<TestResult> {
  return {
    success: true,
    message: 'CSV upload is ready to receive files',
    details: {
      plantsFound: 0,
      fieldsFound: 0,
    },
  };
}

// Test Huawei FusionSolar API. Real authentication against the NorthBound API
// (mirrors testSolarEdgeAPI): resolve credentials from the secret or config,
// log in, and list stations. A bad credential now fails honestly instead of
// returning a green check and leaving the connection marked "connected".
async function testHuaweiAPI(
  connection: { secret_arn: string | null; config: any }
): Promise<TestResult> {
  const config = (connection.config || {}) as Record<string, any>;

  const { resolveHuaweiCredentials, HuaweiFusionSolarService } = await import(
    '@/lib/services/huawei-api-service'
  );

  let credentials;
  try {
    credentials = await resolveHuaweiCredentials(connection);
  } catch (error) {
    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : 'Huawei FusionSolar credentials not found (need userName and systemCode)',
    };
  }

  const service = new HuaweiFusionSolarService({
    credentials,
    baseUrl: config.baseUrl || config.base_url || undefined,
    useLegacyStationList:
      config.useLegacyStationList === true || config.use_legacy_station_list === true,
  });

  try {
    const plants = await service.getPlantList();
    return {
      success: true,
      message: `Huawei FusionSolar API connection successful (${plants.length} station(s) visible)`,
      details: {
        plantsFound: plants.length,
        sampleData: plants.slice(0, 5),
      },
    };
  } catch (error) {
    return {
      success: false,
      message: `Huawei FusionSolar API test failed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    };
  } finally {
    await service.close();
  }
}

// Test Sungrow iSolarCloud OpenAPI. Mirrors testHuaweiAPI: resolve credentials
// from the secret or config, authenticate, and list power stations.
//
// The connector has never executed against a live iSolarCloud account (OpenAPI
// access needs a signed agreement with Sungrow), so a pass is reported with a
// caveat rather than as a settled integration.
async function testSungrowAPI(
  connection: { secret_arn: string | null; config: any }
): Promise<TestResult> {
  const config = (connection.config || {}) as Record<string, any>;

  const { resolveSungrowCredentials, SungrowISolarCloudService, SUNGROW_GATEWAYS } = await import(
    '@/lib/services/sungrow-api-service'
  );

  let credentials;
  try {
    credentials = await resolveSungrowCredentials(connection);
  } catch (error) {
    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : 'Sungrow iSolarCloud credentials not found (need appkey and access_key)',
    };
  }

  const region = config.region ? String(config.region).toLowerCase() : undefined;
  const service = new SungrowISolarCloudService({
    credentials,
    baseUrl: config.baseUrl || config.base_url || undefined,
    region: region && SUNGROW_GATEWAYS[region] ? region : undefined,
    sysCode:
      config.sys_code || config.sysCode ? String(config.sys_code || config.sysCode) : undefined,
    lang: config.lang ? String(config.lang) : undefined,
  });

  try {
    const plants = await service.getPlantList();
    return {
      success: true,
      message: `Sungrow iSolarCloud API connection successful (${plants.length} station(s) visible)`,
      details: {
        plantsFound: plants.length,
        sampleData: plants.slice(0, 5),
      },
      warnings: [
        'Sungrow support is new and has not yet been exercised against a live iSolarCloud account. Review the discovered stations and measurement points before you rely on this feed.',
      ],
    };
  } catch (error) {
    return {
      success: false,
      message: `Sungrow iSolarCloud API test failed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    };
  } finally {
    await service.close();
  }
}

async function testSolarEdgeAPI(config: Record<string, any>): Promise<TestResult> {
  const apiKey = config.api_key || config.apiKey;

  if (!apiKey) {
    return {
      success: false,
      message: 'Missing required configuration: api_key',
    };
  }

  const { SolarEdgeMonitoringService } = await import('@/lib/services/solaredge-api-service');
  const service = new SolarEdgeMonitoringService({
    credentials: { apiKey },
    siteId: config.site_id || config.siteId ? String(config.site_id || config.siteId) : undefined,
  });

  try {
    const plants = await service.getPlantList();
    return {
      success: true,
      message: `SolarEdge monitoring API connection successful — ${plants.length} site(s) visible`,
      details: {
        plantsFound: plants.length,
        sampleData: plants.slice(0, 5),
      },
    };
  } catch (error) {
    return {
      success: false,
      message: `SolarEdge monitoring API test failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  } finally {
    await service.close();
  }
}
