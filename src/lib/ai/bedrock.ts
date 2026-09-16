import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

/**
 * AWS Bedrock client supporting multiple model families.
 *
 * Auth: Uses bearer token via AWS_BEARER_TOKEN_BEDROCK env var (SDK v3 picks up
 * automatically). Falls back to standard AWS credentials if not set.
 *
 * Supported model families (auto-detected from modelId):
 *  - Qwen / DeepSeek / Mistral / Amazon Nova — OpenAI-compatible (default)
 *  - Anthropic Claude (anthropic.*, eu.anthropic.*) — messages API (needs the
 *    Bedrock Anthropic use-case form; not enabled on this account)
 *
 * Config:
 *  - AWS_REGION (default: eu-west-1)
 *  - BEDROCK_MODEL_ID (default: qwen.qwen3-next-80b-a3b)
 */

const REGION = process.env.AWS_REGION || 'eu-west-1';
const MODEL_ID =
  process.env.BEDROCK_MODEL_ID || 'qwen.qwen3-next-80b-a3b';

/**
 * The RESOLVED model id, for response `model` fields. Routes must use this
 * instead of hardcoding a name — a BEDROCK_MODEL_ID override would otherwise
 * make the reported model a lie.
 */
export function modelLabel(): string {
  return MODEL_ID;
}

let _client: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region: REGION });
  return _client;
}

export interface BedrockOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

function isAnthropic(modelId: string): boolean {
  return modelId.toLowerCase().includes('anthropic');
}

export interface BedrockDetailedResult {
  text: string;
  /** Real token usage from the response payload when the model returns it
   * (OpenAI-compatible families do; undefined → caller falls back to len/4). */
  inputTokens?: number;
  outputTokens?: number;
}

export async function invokeBedrock(
  userPrompt: string,
  opts: BedrockOptions = {}
): Promise<string> {
  return (await invokeBedrockDetailed(userPrompt, opts)).text;
}

export async function invokeBedrockDetailed(
  userPrompt: string,
  opts: BedrockOptions = {}
): Promise<BedrockDetailedResult> {
  const modelId = MODEL_ID;
  const finalUser = opts.jsonMode
    ? `${userPrompt}\n\nRespond with ONLY valid JSON. No markdown, no code fences, no preamble.`
    : userPrompt;

  let body: string;
  if (isAnthropic(modelId)) {
    // Anthropic messages API (Claude family on Bedrock)
    body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: opts.maxTokens ?? 800,
      temperature: opts.temperature ?? 0.2,
      system: opts.system,
      messages: [{ role: 'user', content: finalUser }],
    });
  } else {
    // OpenAI-compatible (DeepSeek, Mistral, Qwen, Nova)
    const messages: { role: string; content: string }[] = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: finalUser });
    body = JSON.stringify({
      messages,
      max_tokens: opts.maxTokens ?? 800,
      temperature: opts.temperature ?? 0.2,
    });
  }

  const res = await client().send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    })
  );
  const payload = JSON.parse(new TextDecoder().decode(res.body));

  // Parse response — format varies by model family
  if (isAnthropic(modelId)) {
    // Claude: { content: [{ type: "text", text: "..." }], usage: { input_tokens, output_tokens } }
    const first = payload.content?.[0];
    return {
      text: first?.text ?? JSON.stringify(payload),
      inputTokens: numberOrUndefined(payload.usage?.input_tokens),
      outputTokens: numberOrUndefined(payload.usage?.output_tokens),
    };
  } else {
    // OpenAI-compatible: { choices: [{ message: { content } }], usage: { prompt_tokens, completion_tokens } }
    const text =
      payload.choices?.[0]?.message?.content ??
      payload.output?.message?.content ??
      payload.generation ??
      '';
    return {
      text: typeof text === 'string' ? text : JSON.stringify(text),
      inputTokens: numberOrUndefined(payload.usage?.prompt_tokens),
      outputTokens: numberOrUndefined(payload.usage?.completion_tokens),
    };
  }
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Extract a JSON object from LLM response (handles code fences, preambles).
 */
export function extractJson<T = any>(text: string): T | null {
  if (!text) return null;
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const jsonStr = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return null;
  }
}
