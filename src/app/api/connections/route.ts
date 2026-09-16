import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { Prisma, ConnectionType, ConnectionStatus } from '@prisma/client';
import { requireOrg, hasOrgManageRole, forbidden } from '@/lib/api/tenant';
import { getOrgBilling } from '@/lib/billing/plan';

// Type definitions
interface ConnectionFilters {
  type?: ConnectionType[];
  status?: ConnectionStatus[];
  search?: string;
}

interface CreateConnectionRequest {
  name: string;
  description?: string;
  type: ConnectionType;
  config: Record<string, any>;
  polling_interval?: number;
}

// GET /api/connections - List all connections
export async function GET(request: NextRequest) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;

    const { searchParams } = new URL(request.url);

    // Parse query parameters
    const page = parseInt(searchParams.get('page') || '1', 10);
    const pageSize = Math.min(parseInt(searchParams.get('page_size') || '20', 10), 100);
    const skip = (page - 1) * pageSize;

    // Build filters
    const filters: ConnectionFilters = {
      type: searchParams.get('type')?.split(',') as ConnectionType[] | undefined,
      status: searchParams.get('status')?.split(',') as ConnectionStatus[] | undefined,
      search: searchParams.get('search') || undefined,
    };

    // Build Prisma where clause. Tenancy filter is nested under AND so the
    // search OR below can't clobber the demo legacy-row OR. Demo identity
    // also sees legacy 'demo_customer' rows so local dev/demo keeps working.
    const where: Prisma.DataConnectionWhereInput = {
      AND: [
        ctx.isDemo
          ? { OR: [{ organization_id: ctx.org.id }, { customer_id: 'demo_customer' }] }
          : { organization_id: ctx.org.id },
      ],
    };

    if (filters.type && filters.type.length > 0) {
      where.type = { in: filters.type };
    }

    if (filters.status && filters.status.length > 0) {
      where.status = { in: filters.status };
    }

    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    // Execute queries in parallel
    const [connections, total] = await Promise.all([
      prisma.dataConnection.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [
          { status: 'asc' },
          { updated_at: 'desc' },
        ],
        include: {
          _count: {
            select: {
              field_mappings: true,
              discovered_plants: true,
              polling_jobs: true,
            },
          },
          // Linked plants (via PlantDataSource) so the UI can cross-link
          // connections ↔ plants without a second request.
          plant_data_sources: {
            select: {
              purpose: true,
              is_primary: true,
              plant: { select: { id: true, name: true, slug: true } },
            },
          },
        },
      }),
      prisma.dataConnection.count({ where }),
    ]);

    // Remove sensitive config data from response; flatten linked plants
    // (deduped by plant id — a plant can attach one connection several times).
    const sanitizedConnections = connections.map(conn => {
      const { plant_data_sources, ...rest } = conn as typeof conn & {
        plant_data_sources: Array<{
          purpose: string;
          is_primary: boolean;
          plant: { id: string; name: string; slug: string } | null;
        }>;
      };
      const plantsById = new Map<string, { id: string; name: string; slug: string; purpose: string; is_primary: boolean }>();
      for (const source of plant_data_sources ?? []) {
        if (source.plant && !plantsById.has(source.plant.id)) {
          plantsById.set(source.plant.id, {
            ...source.plant,
            purpose: source.purpose,
            is_primary: source.is_primary,
          });
        }
      }
      return {
        ...rest,
        config: sanitizeConfig(rest.config as Record<string, any>),
        plants: Array.from(plantsById.values()),
      };
    });

    return NextResponse.json({
      data: sanitizedConnections,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error('Error fetching connections:', error);
    return NextResponse.json(
      { error: 'Failed to fetch connections' },
      { status: 500 }
    );
  }
}

// POST /api/connections - Create a new connection
export async function POST(request: NextRequest) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    if (!hasOrgManageRole(ctx)) return forbidden('org_manage_role_required');

    const body = await request.json() as CreateConnectionRequest;

    // Validate required fields
    if (!body.name || !body.type || !body.config) {
      return NextResponse.json(
        { error: 'Missing required fields: name, type, config' },
        { status: 400 }
      );
    }

    // Validate connection type
    const validTypes: ConnectionType[] = ['influxdb', 'sql_scada', 'modbus_tcp', 'csv_upload', 'huawei_api', 'sungrow_api', 'solaredge_api', 'sample_api'];
    if (!validTypes.includes(body.type)) {
      return NextResponse.json(
        { error: `Invalid connection type. Must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    // Plan limit: data connections per organization.
    const { plan, limits } = await getOrgBilling(ctx.authOrgId);
    if (plan === 'free') {
      return NextResponse.json(
        {
          error: 'plan_required',
          detail:
            'Pick a plan to connect data sources — Residential starts at €9/mo with a 14-day free trial.',
          upgrade_url: '/pricing',
        },
        { status: 402 }
      );
    }
    if (Number.isFinite(limits.connections)) {
      const connectionCount = await prisma.dataConnection.count({
        where: { organization_id: ctx.org.id },
      });
      if (connectionCount >= limits.connections) {
        return NextResponse.json(
          {
            error: 'connection_limit_reached',
            detail: `The ${plan} plan includes ${limits.connections} data connection${limits.connections === 1 ? '' : 's'}. Upgrade to add more.`,
            upgrade_url: '/pricing',
          },
          { status: 402 }
        );
      }
    }

    // Validate config based on type
    const configValidation = validateConfig(body.type, body.config);
    if (!configValidation.valid) {
      return NextResponse.json(
        { error: configValidation.error },
        { status: 400 }
      );
    }

    // Create connection
    const connection = await prisma.dataConnection.create({
      data: {
        customer_id: ctx.authOrgId,
        organization_id: ctx.org.id,
        name: body.name,
        description: body.description,
        type: body.type,
        status: 'pending',
        config: body.config,
        polling_interval: body.polling_interval || 900, // Default 15 minutes
        enabled: true,
      },
    });

    // Log audit event
    await prisma.connectionAudit.create({
      data: {
        connection_id: connection.id,
        action: 'created',
        user_id: ctx.userId,
        success: true,
        new_values: {
          name: connection.name,
          type: connection.type,
        },
      },
    });

    return NextResponse.json({
      data: {
        ...connection,
        config: sanitizeConfig(connection.config as Record<string, any>),
      },
      message: 'Connection created successfully',
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating connection:', error);
    return NextResponse.json(
      { error: 'Failed to create connection' },
      { status: 500 }
    );
  }
}

// Helper: Validate config based on connection type
function validateConfig(type: ConnectionType, config: Record<string, any>): { valid: boolean; error?: string } {
  switch (type) {
    case 'influxdb':
      if (!config.url || !config.token || !config.org || !config.bucket) {
        return { valid: false, error: 'InfluxDB requires: url, token, org, bucket' };
      }
      break;

    case 'sql_scada':
      if (!config.host || !config.database || !config.username || !config.password) {
        return { valid: false, error: 'SQL SCADA requires: host, database, username, password' };
      }
      break;

    case 'modbus_tcp':
      if (!config.host || !config.port) {
        return { valid: false, error: 'Modbus TCP requires: host, port' };
      }
      break;

    case 'csv_upload':
      // No required config for CSV upload
      break;

    case 'sample_api':
      // Sandbox synthetic feed — no credentials required.
      break;

    case 'huawei_api':
      // The wizard historically sent huawei_username / huawei_password; accept
      // both the prefixed and the canonical keys so real Huawei connects don't
      // dead-end on a key mismatch.
      if (
        !(config.username || config.userName || config.huawei_username) ||
        !(config.password || config.systemCode || config.huawei_password)
      ) {
        return { valid: false, error: 'Huawei API requires: username, password' };
      }
      break;

    case 'solaredge_api':
      if (!config.api_key && !config.apiKey) {
        return { valid: false, error: 'SolarEdge monitoring API requires: api_key' };
      }
      break;

    case 'sungrow_api':
      // iSolarCloud needs the issued appkey plus the x-access-key value. The
      // portal account (or a pre-issued token) is checked by the connector at
      // authenticate() time, since either form is valid.
      if (!(config.appkey || config.app_key || config.appKey)) {
        return { valid: false, error: 'Sungrow iSolarCloud API requires: appkey' };
      }
      if (!(config.access_key || config.accessKey || config.x_access_key)) {
        return { valid: false, error: 'Sungrow iSolarCloud API requires: access_key' };
      }
      break;
  }

  return { valid: true };
}

// Helper: Remove sensitive data from config
function sanitizeConfig(config: Record<string, any>): Record<string, any> {
  if (!config) return {};

  // Sungrow ships two credentials that do not match any of the older patterns
  // ('appkey' and 'access_key'), so they are listed explicitly rather than left
  // to leak through the connection list response.
  const sensitiveKeys = [
    'password',
    'token',
    'secret',
    'api_key',
    'apiKey',
    'credentials',
    'appkey',
    'app_key',
    'access_key',
    'accesskey',
  ];
  const sanitized = { ...config };

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      sanitized[key] = '********';
    }
  }

  return sanitized;
}
