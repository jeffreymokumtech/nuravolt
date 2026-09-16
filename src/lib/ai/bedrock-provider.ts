import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';

/**
 * AI SDK provider wired to AWS Bedrock with the same auth used by
 * src/lib/ai/bedrock.ts (bearer token via AWS_BEARER_TOKEN_BEDROCK,
 * region via AWS_REGION). Used by /api/chat and other AI SDK callers.
 */

const REGION = process.env.AWS_REGION || 'eu-west-1';

export const CHAT_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ||
  'qwen.qwen3-next-80b-a3b';

export const bedrock = createAmazonBedrock({
  region: REGION,
});

export const chatModel = bedrock(CHAT_MODEL_ID);
