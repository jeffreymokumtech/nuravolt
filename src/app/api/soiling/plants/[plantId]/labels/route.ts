/**
 * API Route: /api/soiling/plants/[plantId]/labels
 *
 * Manages user labels/annotations for soiling data points.
 * Labels are stored in JSON files for simplicity (export/import friendly).
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { DataLabel } from '@/types/soiling';
import { resolvePlantForRead, requireOrg, requirePlantAccess } from '@/lib/api/tenant';

interface RouteParams {
  params: Promise<{ plantId: string }>;
}

interface LabelsFile {
  plantId: string;
  labels: DataLabel[];
  createdAt: string;
  lastModified: string;
}

function getLabelsPath(plantId: string): string {
  return path.join(process.cwd(), 'public/data/soiling', plantId, 'labels.json');
}

function readLabelsFile(labelsPath: string): LabelsFile {
  if (!fs.existsSync(labelsPath)) {
    return {
      plantId: '',
      labels: [],
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString(),
    };
  }
  const content = fs.readFileSync(labelsPath, 'utf-8');
  return JSON.parse(content);
}

function writeLabelsFile(labelsPath: string, data: LabelsFile): void {
  data.lastModified = new Date().toISOString();
  fs.writeFileSync(labelsPath, JSON.stringify(data, null, 2));
}

/**
 * GET /api/soiling/plants/[plantId]/labels
 *
 * Returns all labels for a plant
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { plantId } = await params;

    if (!plantId) {
      return NextResponse.json({ error: 'Invalid plant ID' }, { status: 400 });
    }

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    const labelsPath = getLabelsPath(plantId);
    const labelsData = readLabelsFile(labelsPath);
    labelsData.plantId = plantId;

    return NextResponse.json(labelsData);
  } catch (error) {
    console.error('Error reading labels:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/soiling/plants/[plantId]/labels
 *
 * Create a new label
 */
export async function POST(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { plantId } = await params;

    if (!plantId) {
      return NextResponse.json({ error: 'Invalid plant ID' }, { status: 400 });
    }

    // Tenancy: label creation is a write — require org + OPERATE access.
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const plantResult = await requirePlantAccess(orgResult.ctx, plantId, 'OPERATE');
    if (!plantResult.ok) return plantResult.response;

    const body = await request.json();
    const { date, type, label, notes, createdBy } = body;

    // Validate required fields
    if (!date || !type || !label) {
      return NextResponse.json(
        { error: 'Missing required fields: date, type, label' },
        { status: 400 }
      );
    }

    // Validate label type
    const validTypes = ['rain_cleaning', 'dust_event', 'manual_cleaning', 'anomaly', 'other'];
    if (!validTypes.includes(type)) {
      return NextResponse.json(
        { error: `Invalid label type. Must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    const labelsPath = getLabelsPath(plantId);
    const labelsData = readLabelsFile(labelsPath);
    labelsData.plantId = plantId;

    // Create new label
    const newLabel: DataLabel = {
      id: uuidv4(),
      date,
      type,
      label,
      notes: notes || undefined,
      createdAt: new Date().toISOString(),
      createdBy: createdBy || undefined,
    };

    labelsData.labels.push(newLabel);
    writeLabelsFile(labelsPath, labelsData);

    return NextResponse.json(newLabel, { status: 201 });
  } catch (error) {
    console.error('Error creating label:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PUT /api/soiling/plants/[plantId]/labels
 *
 * Update an existing label (requires id in body)
 */
export async function PUT(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { plantId } = await params;

    if (!plantId) {
      return NextResponse.json({ error: 'Invalid plant ID' }, { status: 400 });
    }

    // Tenancy: label update is a write — require org + OPERATE access.
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const plantResult = await requirePlantAccess(orgResult.ctx, plantId, 'OPERATE');
    if (!plantResult.ok) return plantResult.response;

    const body = await request.json();
    const { id, date, type, label, notes } = body;

    if (!id) {
      return NextResponse.json({ error: 'Missing label ID' }, { status: 400 });
    }

    const labelsPath = getLabelsPath(plantId);
    const labelsData = readLabelsFile(labelsPath);

    const labelIndex = labelsData.labels.findIndex(l => l.id === id);
    if (labelIndex === -1) {
      return NextResponse.json({ error: 'Label not found' }, { status: 404 });
    }

    // Update label fields
    const updatedLabel = {
      ...labelsData.labels[labelIndex],
      ...(date && { date }),
      ...(type && { type }),
      ...(label && { label }),
      notes: notes !== undefined ? notes : labelsData.labels[labelIndex].notes,
    };

    labelsData.labels[labelIndex] = updatedLabel;
    writeLabelsFile(labelsPath, labelsData);

    return NextResponse.json(updatedLabel);
  } catch (error) {
    console.error('Error updating label:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/soiling/plants/[plantId]/labels
 *
 * Delete a label (requires id in query params)
 */
export async function DELETE(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { plantId } = await params;

    if (!plantId) {
      return NextResponse.json({ error: 'Invalid plant ID' }, { status: 400 });
    }

    // Tenancy: label deletion is a write — require org + OPERATE access.
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const plantResult = await requirePlantAccess(orgResult.ctx, plantId, 'OPERATE');
    if (!plantResult.ok) return plantResult.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Missing label ID' }, { status: 400 });
    }

    const labelsPath = getLabelsPath(plantId);
    const labelsData = readLabelsFile(labelsPath);

    const initialLength = labelsData.labels.length;
    labelsData.labels = labelsData.labels.filter(l => l.id !== id);

    if (labelsData.labels.length === initialLength) {
      return NextResponse.json({ error: 'Label not found' }, { status: 404 });
    }

    writeLabelsFile(labelsPath, labelsData);

    return NextResponse.json({ success: true, deletedId: id });
  } catch (error) {
    console.error('Error deleting label:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
