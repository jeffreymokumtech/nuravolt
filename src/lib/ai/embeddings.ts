import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

/**
 * Bedrock Titan Text Embeddings v2.
 * - Model: `amazon.titan-embed-text-v2:0`
 * - Default output dim: 1024 (also supports 256/512 via dimensions parameter)
 * - Auth: AWS_BEARER_TOKEN_BEDROCK / region from AWS_REGION (default eu-west-1)
 *
 * Keep dim aligned with KBChunk.embedding column (vector(1024)).
 */

export const EMBEDDING_DIM = 1024;
export const EMBEDDING_MODEL_ID =
  process.env.BEDROCK_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0';

const REGION = process.env.AWS_REGION || 'eu-west-1';

let _client: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region: REGION });
  return _client;
}

export async function embedText(text: string): Promise<number[]> {
  const body = JSON.stringify({
    inputText: text.slice(0, 8000), // Titan v2 input limit ~8K tokens
    dimensions: EMBEDDING_DIM,
    normalize: true,
  });

  const res = await client().send(
    new InvokeModelCommand({
      modelId: EMBEDDING_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    })
  );

  const payload = JSON.parse(new TextDecoder().decode(res.body));
  const vec = payload.embedding as number[] | undefined;
  if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `Unexpected embedding shape: got length ${vec?.length}, expected ${EMBEDDING_DIM}`
    );
  }
  return vec;
}

/**
 * Sequential embed for simplicity. Bedrock has per-account TPS limits, so
 * batching with a small concurrency would help large uploads — left as
 * follow-up.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of texts) {
    out.push(await embedText(t));
  }
  return out;
}

/** Format a number[] for the Postgres vector(N) literal. */
export function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
