-- Additive enum values so LLMInteraction rows can be stamped with the model
-- that actually served the call (Bedrock Qwen) instead of the Haiku proxy.
ALTER TYPE "LLMProvider" ADD VALUE IF NOT EXISTS 'BEDROCK_QWEN';
ALTER TYPE "LLMModel" ADD VALUE IF NOT EXISTS 'QWEN3_NEXT_80B';
