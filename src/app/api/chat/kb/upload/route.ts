import { NextRequest } from 'next/server';
import { getChatIds } from '@/lib/ai/chat-auth';
import { requireFeature } from '@/lib/billing/gate';
import {
  ingestKBDocument,
  SUPPORTED_FILE_TYPES,
  type SupportedFileType,
} from '@/lib/ai/kb-ingest';

export const runtime = 'nodejs';
export const maxDuration = 300; // PDF parsing + many embed calls can be slow

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

export async function POST(request: NextRequest) {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gate = await requireFeature(orgId, 'ai:copilot');
  if (gate) return gate;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: 'Invalid multipart payload' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof Blob) || !('name' in file)) {
    return Response.json({ error: 'No file uploaded under field "file"' }, { status: 400 });
  }
  const named = file as File;

  if (named.size > MAX_FILE_BYTES) {
    return Response.json(
      { error: `File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)` },
      { status: 413 }
    );
  }

  const ext = named.name.split('.').pop()?.toLowerCase();
  if (!ext || !SUPPORTED_FILE_TYPES.includes(ext as SupportedFileType)) {
    return Response.json(
      {
        error: `Unsupported file type "${ext ?? '(none)'}" — supported: ${SUPPORTED_FILE_TYPES.join(', ')}`,
      },
      { status: 415 }
    );
  }

  const title = (formData.get('title') as string | null)?.trim() || named.name;
  const plantId = (formData.get('plantId') as string | null) || null;
  const equipmentType = (formData.get('equipmentType') as string | null) || null;
  const manufacturer = (formData.get('manufacturer') as string | null) || null;
  const modelNumber = (formData.get('modelNumber') as string | null) || null;

  const buffer = Buffer.from(await named.arrayBuffer());

  try {
    const result = await ingestKBDocument({
      orgClerkId: orgId,
      uploadedBy: userId,
      title,
      fileName: named.name,
      fileType: ext as SupportedFileType,
      buffer,
      plantId,
      equipmentType,
      manufacturer,
      modelNumber,
    });
    return Response.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (e) {
    console.error('[kb/upload] ingest failed:', e);
    return Response.json(
      {
        error: 'Ingestion failed',
        detail: e instanceof Error ? e.message : 'unknown',
      },
      { status: 500 }
    );
  }
}
