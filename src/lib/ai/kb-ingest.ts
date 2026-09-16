import crypto from 'crypto';
import prisma from '@/libs/prisma';
import { embedText, vectorLiteral } from '@/lib/ai/embeddings';

/**
 * Ingestion pipeline for the knowledge base:
 *   parseFile(buffer, ext) -> raw text
 *   chunkText(text)        -> Array<{ content, tokenCount }>
 *   ingestKBDocument(...)  -> KBDocument + N KBChunk rows with embeddings
 */

export const SUPPORTED_FILE_TYPES = ['txt', 'md', 'pdf'] as const;
export type SupportedFileType = (typeof SUPPORTED_FILE_TYPES)[number];

const CHUNK_CHAR_TARGET = 1000;
const CHUNK_CHAR_OVERLAP = 200;

export async function parseFile(
  buffer: Buffer,
  fileType: SupportedFileType
): Promise<string> {
  if (fileType === 'txt' || fileType === 'md') {
    return buffer.toString('utf8');
  }
  if (fileType === 'pdf') {
    // pdf-parse's root index.js runs a self-test when `module.parent` is
    // null (no test fixture is bundled), which triggers
    // ENOENT under tsx / dynamic-import paths. Importing the inner file
    // directly bypasses the debug guard.
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default as (
      b: Buffer
    ) => Promise<{ text: string }>;
    const result = await pdfParse(buffer);
    return result.text;
  }
  throw new Error(`Unsupported file type: ${fileType}`);
}

/**
 * Naive paragraph-aware chunker. Splits on blank lines first, then packs
 * paragraphs into ~1000-char chunks with ~200-char overlap.
 */
export function chunkText(
  text: string
): Array<{ content: string; tokenCount: number }> {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return [];

  const paragraphs = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  let buf = '';

  for (const p of paragraphs) {
    if ((buf + '\n\n' + p).length <= CHUNK_CHAR_TARGET) {
      buf = buf ? `${buf}\n\n${p}` : p;
    } else {
      if (buf) chunks.push(buf);
      if (p.length <= CHUNK_CHAR_TARGET) {
        buf = p;
      } else {
        // Long paragraph: hard-split into windows with overlap.
        for (let i = 0; i < p.length; i += CHUNK_CHAR_TARGET - CHUNK_CHAR_OVERLAP) {
          chunks.push(p.slice(i, i + CHUNK_CHAR_TARGET));
        }
        buf = '';
      }
    }
  }
  if (buf) chunks.push(buf);

  return chunks.map((content) => ({
    content,
    // ~1 token per 4 chars heuristic — close enough for budgeting.
    tokenCount: Math.ceil(content.length / 4),
  }));
}

export interface IngestArgs {
  /** null = global/shared document (public vendor manuals every org may read). */
  orgClerkId: string | null;
  uploadedBy: string;
  title: string;
  fileName: string;
  fileType: SupportedFileType;
  buffer: Buffer;
  plantId?: string | null;
  equipmentType?: string | null;
  manufacturer?: string | null;
  modelNumber?: string | null;
  /** Where the file was fetched from (doc-agent ingestion). */
  sourceUrl?: string | null;
}

export interface IngestResult {
  document: {
    id: string;
    title: string;
    file_name: string;
    file_type: string;
    chunk_count: number;
    processing_status: string;
  };
  duplicate?: boolean;
}

export async function ingestKBDocument(
  args: IngestArgs
): Promise<IngestResult> {
  const fileHash = crypto.createHash('sha256').update(args.buffer).digest('hex');

  // De-duplicate by content hash within the org.
  const existing = await prisma.kBDocument.findFirst({
    where: { org_clerk_id: args.orgClerkId, file_hash: fileHash },
  });
  if (existing) {
    return {
      document: {
        id: existing.id,
        title: existing.title,
        file_name: existing.file_name,
        file_type: existing.file_type,
        chunk_count: existing.chunk_count,
        processing_status: existing.processing_status,
      },
      duplicate: true,
    };
  }

  const created = await prisma.kBDocument.create({
    data: {
      org_clerk_id: args.orgClerkId,
      plant_id: args.plantId ?? null,
      title: args.title,
      file_name: args.fileName,
      file_type: args.fileType,
      file_size_bytes: args.buffer.byteLength,
      file_hash: fileHash,
      source_url: args.sourceUrl ?? null,
      equipment_type: args.equipmentType ?? null,
      manufacturer: args.manufacturer ?? null,
      model_number: args.modelNumber ?? null,
      uploaded_by: args.uploadedBy,
      processing_status: 'processing',
    },
  });

  try {
    const text = await parseFile(args.buffer, args.fileType);
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      await prisma.kBDocument.update({
        where: { id: created.id },
        data: { processing_status: 'failed', processing_error: 'No text extracted from file' },
      });
      return {
        document: {
          id: created.id,
          title: created.title,
          file_name: created.file_name,
          file_type: created.file_type,
          chunk_count: 0,
          processing_status: 'failed',
        },
      };
    }

    // Embed + insert chunks one at a time. Bedrock Titan v2 doesn't take
    // batches; this also keeps memory predictable for big PDFs.
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const vec = await embedText(c.content);
      // Raw SQL because Prisma can't bind the vector(N) type natively.
      await prisma.$executeRawUnsafe(
        `INSERT INTO "KBChunk" (id, document_id, chunk_index, content, token_count, embedding, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::vector, NOW())`,
        created.id,
        i,
        c.content,
        c.tokenCount,
        vectorLiteral(vec)
      );
    }

    await prisma.kBDocument.update({
      where: { id: created.id },
      data: { processing_status: 'completed', chunk_count: chunks.length },
    });

    // Log the embedding spend (Titan v2 ≈ $0.00002 / 1K tokens). Provider and
    // model enum values follow the repo convention of mapping Bedrock calls
    // onto the closest existing enum entries.
    const totalTokens = chunks.reduce((s, c) => s + c.tokenCount, 0);
    await prisma.lLMInteraction
      .create({
        data: {
          org_clerk_id: args.orgClerkId,
          provider: 'BEDROCK_ANTHROPIC',
          model: 'CLAUDE_3_HAIKU',
          interaction_type: 'EMBEDDING',
          input_tokens: totalTokens,
          output_tokens: 0,
          cost_usd: (totalTokens / 1000) * 0.00002,
          latency_ms: 0,
          plant_id: args.plantId ?? null,
          success: true,
        },
      })
      .catch(() => {}); // cost logging must never fail ingestion

    return {
      document: {
        id: created.id,
        title: created.title,
        file_name: created.file_name,
        file_type: created.file_type,
        chunk_count: chunks.length,
        processing_status: 'completed',
      },
    };
  } catch (e) {
    await prisma.kBDocument.update({
      where: { id: created.id },
      data: {
        processing_status: 'failed',
        processing_error: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  }
}
