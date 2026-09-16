import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type {
  WarrantyViolationsResponse,
  WarrantyViolation,
  WarrantyViolationType,
  ViolationSeverity,
} from '@/types/bess';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import prisma from '@/libs/prisma';

const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * GET /api/bess/plants/[plantId]/assets/[assetId]/warranty/violations
 *
 * Returns warranty violations list with summary.
 * DB-first: plants with BessAsset rows are served from Postgres
 * (BessWarrantyViolation); an asset with no violations gets an honest empty
 * list, never fixtures.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string; assetId: string } }
) {
  try {
    const { plantId, assetId } = params;

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;
    if (readAccess.access === 'org') {
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:bess');
      if (gate) return gate;
    }

    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get('active') === 'true';

    // Database branch.
    if (readAccess.plant) {
      const dbAsset =
        (await prisma.bessAsset.findFirst({
          where: {
            plant_id: readAccess.plant.id,
            OR: [{ id: assetId }, { external_asset_id: assetId }],
          },
        })) ??
        (await prisma.bessAsset.findFirst({
          where: { plant_id: readAccess.plant.id },
          orderBy: { created_at: 'asc' },
        }));

      if (dbAsset) {
        const allViolations = await prisma.bessWarrantyViolation.findMany({
          where: { asset_id: dbAsset.id },
          orderBy: { started_at: 'desc' },
        });

        const violations: WarrantyViolation[] = allViolations
          .filter((v) => !activeOnly || !v.is_resolved)
          .map((v) => ({
            id: v.id,
            assetId: dbAsset.id,
            violationType: v.violation_type as WarrantyViolationType,
            startedAt: v.started_at.toISOString(),
            endedAt: v.ended_at ? v.ended_at.toISOString() : null,
            durationMinutes: v.duration_minutes,
            severity: v.severity as ViolationSeverity,
            measuredValue: numOrNull(v.measured_value),
            thresholdValue: numOrNull(v.threshold_value),
            unit: v.unit,
            description: v.description,
            rootCause: v.root_cause,
            affectedModules: v.affected_modules,
            isResolved: v.is_resolved,
            resolutionNotes: v.resolution_notes,
            resolvedAt: v.resolved_at ? v.resolved_at.toISOString() : null,
            resolvedBy: v.resolved_by,
            ticketId: v.ticket_id,
          }));

        // Summary is computed over ALL violations (matches fixture path).
        const totalViolations = allViolations.length;
        const activeViolations = allViolations.filter(
          (v) => !v.is_resolved
        ).length;
        const byType: Record<WarrantyViolationType, number> = {} as Record<
          WarrantyViolationType,
          number
        >;
        allViolations.forEach((v) => {
          const type = v.violation_type as WarrantyViolationType;
          byType[type] = (byType[type] || 0) + 1;
        });

        const response: WarrantyViolationsResponse & { _source: string } = {
          assetId: dbAsset.id,
          violations,
          summary: {
            total: totalViolations,
            active: activeViolations,
            resolved: totalViolations - activeViolations,
            bySeverity: {
              warning: allViolations.filter((v) => v.severity === 'warning')
                .length,
              critical: allViolations.filter((v) => v.severity === 'critical')
                .length,
            },
            byType,
          },
          metadata: {
            generatedAt: new Date().toISOString(),
          },
          _source: 'database',
        };
        return NextResponse.json(response);
      }
    }

    const violationsPath = path.join(
      process.cwd(),
      'public',
      'data',
      'bess',
      plantId,
      'warranty_violations.json'
    );

    // Load asset info for asset ID
    const assetPath = path.join(
      process.cwd(),
      'public',
      'data',
      'bess',
      plantId,
      'asset_info.json'
    );

    const [violationsData, assetData] = await Promise.all([
      fs.readFile(violationsPath, 'utf-8').catch(() => '[]'),
      fs.readFile(assetPath, 'utf-8').catch(() => null),
    ]);

    const rawViolations = JSON.parse(violationsData);
    const assetInfo = assetData ? JSON.parse(assetData) : { asset_id: 'unknown' };

    // Transform violations
    const violations: WarrantyViolation[] = rawViolations
      .filter((v: any) => !activeOnly || !v.is_resolved)
      .map((v: any) => ({
        id: v.id,
        assetId: assetInfo.asset_id,
        violationType: v.type as WarrantyViolationType,
        startedAt: v.started_at,
        endedAt: v.ended_at || null,
        durationMinutes: v.duration_minutes || null,
        severity: v.severity,
        measuredValue: v.measured_value || null,
        thresholdValue: v.threshold_value || null,
        unit: v.unit || null,
        description: v.description || null,
        rootCause: v.root_cause || null,
        affectedModules: v.affected_modules || [],
        isResolved: v.is_resolved || false,
        resolutionNotes: v.resolution_notes || null,
        resolvedAt: v.resolved_at || null,
        resolvedBy: v.resolved_by || null,
        ticketId: v.ticket_id || null,
      }));

    // Calculate summary
    const totalViolations = rawViolations.length;
    const activeViolations = rawViolations.filter((v: any) => !v.is_resolved).length;
    const resolvedViolations = totalViolations - activeViolations;
    const warningCount = rawViolations.filter((v: any) => v.severity === 'warning').length;
    const criticalCount = rawViolations.filter((v: any) => v.severity === 'critical').length;

    // Count by type
    const byType: Record<WarrantyViolationType, number> = {} as Record<WarrantyViolationType, number>;
    rawViolations.forEach((v: any) => {
      const type = v.type as WarrantyViolationType;
      byType[type] = (byType[type] || 0) + 1;
    });

    const response: WarrantyViolationsResponse = {
      assetId: assetInfo.asset_id,
      violations,
      summary: {
        total: totalViolations,
        active: activeViolations,
        resolved: resolvedViolations,
        bySeverity: {
          warning: warningCount,
          critical: criticalCount,
        },
        byType,
      },
      metadata: {
        generatedAt: new Date().toISOString(),
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/bess/plants/[plantId]/assets/[assetId]/warranty/violations:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
