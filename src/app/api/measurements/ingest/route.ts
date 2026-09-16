import { NextRequest, NextResponse } from 'next/server';
import { insertMeasurements, type MeasurementInsert } from '@/lib/db/timeseries';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

interface IngestPayload {
  plant_id: string;
  source_id?: string;
  records: Array<{
    time: string;
    device_id: string;
    metric: string;
    value: number;
    unit?: string;
    quality?: number;
  }>;
}

function validatePayload(body: unknown): { valid: true; data: IngestPayload } | { valid: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const obj = body as Record<string, unknown>;

  if (!obj.plant_id || typeof obj.plant_id !== 'string') {
    return { valid: false, error: 'Missing or invalid plant_id (UUID string required)' };
  }
  if (!isValidUUID(obj.plant_id)) {
    return { valid: false, error: 'plant_id must be a valid UUID' };
  }

  if (obj.source_id !== undefined && obj.source_id !== null) {
    if (typeof obj.source_id !== 'string' || !isValidUUID(obj.source_id)) {
      return { valid: false, error: 'source_id must be a valid UUID when provided' };
    }
  }

  if (!Array.isArray(obj.records) || obj.records.length === 0) {
    return { valid: false, error: 'records must be a non-empty array' };
  }

  if (obj.records.length > 10_000) {
    return { valid: false, error: 'Maximum 10,000 records per request' };
  }

  for (let i = 0; i < obj.records.length; i++) {
    const rec = obj.records[i] as Record<string, unknown>;

    if (!rec.time || typeof rec.time !== 'string') {
      return { valid: false, error: `records[${i}].time is required (ISO 8601 string)` };
    }
    if (isNaN(new Date(rec.time).getTime())) {
      return { valid: false, error: `records[${i}].time is not a valid ISO 8601 date` };
    }
    if (!rec.device_id || typeof rec.device_id !== 'string') {
      return { valid: false, error: `records[${i}].device_id is required` };
    }
    if (!rec.metric || typeof rec.metric !== 'string') {
      return { valid: false, error: `records[${i}].metric is required` };
    }
    if (typeof rec.value !== 'number' || !isFinite(rec.value)) {
      return { valid: false, error: `records[${i}].value must be a finite number` };
    }
    if (rec.quality !== undefined && (typeof rec.quality !== 'number' || rec.quality < 0 || rec.quality > 100)) {
      return { valid: false, error: `records[${i}].quality must be a number between 0 and 100` };
    }
  }

  return { valid: true, data: obj as unknown as IngestPayload };
}

// ---------------------------------------------------------------------------
// POST /api/measurements/ingest
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // Auth: shared API key. Fail closed — if INGEST_API_KEY is not configured,
  // the endpoint is disabled rather than open.
  const ingestApiKey = process.env.INGEST_API_KEY;
  if (!ingestApiKey) {
    return NextResponse.json(
      { error: 'ingest disabled' },
      { status: 503 },
    );
  }
  if (request.headers.get('x-api-key') !== ingestApiKey) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }

  try {
    const body = await request.json();
    const validation = validatePayload(body);

    if (validation.valid === false) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 },
      );
    }

    const { data } = validation;

    // Map payload records to insert format
    const inserts: MeasurementInsert[] = data.records.map((rec) => ({
      time: new Date(rec.time),
      plant_id: data.plant_id,
      device_id: rec.device_id,
      metric: rec.metric,
      value: rec.value,
      unit: rec.unit,
      quality: rec.quality,
      source_id: data.source_id,
    }));

    const count = await insertMeasurements(inserts);

    return NextResponse.json(
      {
        inserted: count,
        plant_id: data.plant_id,
        record_count: data.records.length,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('Measurement ingest error:', error);
    return NextResponse.json(
      { error: 'Failed to ingest measurements' },
      { status: 500 },
    );
  }
}
