-- Manual DDL for chat persistence (Conversation, ChatMessage, ChatRole)
-- and extensions to the existing LLM enums. Run this directly via psql when
-- prisma migrate is unavailable due to TimescaleDB drift.
--
-- Idempotent: safe to re-run.

BEGIN;

-- 1. New ChatRole enum (no-op if already exists)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChatRole') THEN
    CREATE TYPE "ChatRole" AS ENUM ('USER', 'ASSISTANT', 'TOOL', 'SYSTEM');
  END IF;
END$$;

-- 2. Extend existing LLM enums (ALTER TYPE ... ADD VALUE IF NOT EXISTS is
--    idempotent; the IF NOT EXISTS keyword prevents errors on rerun.)
ALTER TYPE "LLMProvider" ADD VALUE IF NOT EXISTS 'BEDROCK_ANTHROPIC';
ALTER TYPE "LLMModel" ADD VALUE IF NOT EXISTS 'CLAUDE_HAIKU_4_5';
ALTER TYPE "LLMInteractionType" ADD VALUE IF NOT EXISTS 'CHAT';

-- 3. Conversation table
CREATE TABLE IF NOT EXISTS "Conversation" (
  "id"                    TEXT PRIMARY KEY,
  "org_clerk_id"          TEXT NOT NULL,
  "user_clerk_id"         TEXT NOT NULL,
  "title"                 TEXT NOT NULL DEFAULT 'New conversation',
  "pinned"                BOOLEAN NOT NULL DEFAULT FALSE,
  "archived"              BOOLEAN NOT NULL DEFAULT FALSE,
  "plant_id"              TEXT,
  "system_prompt_version" TEXT NOT NULL DEFAULT 'v1',
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "Conversation_user_clerk_id_updated_at_idx"
  ON "Conversation" ("user_clerk_id", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "Conversation_org_clerk_id_idx"
  ON "Conversation" ("org_clerk_id");
CREATE INDEX IF NOT EXISTS "Conversation_plant_id_idx"
  ON "Conversation" ("plant_id");

-- 4. ChatMessage table
CREATE TABLE IF NOT EXISTS "ChatMessage" (
  "id"                  TEXT PRIMARY KEY,
  "conversation_id"     TEXT NOT NULL,
  "role"                "ChatRole" NOT NULL,
  "content"             TEXT NOT NULL,
  "parts"               JSONB,
  "tool_name"           TEXT,
  "tool_call_id"        TEXT,
  "llm_interaction_id"  TEXT,
  "input_tokens"        INTEGER,
  "output_tokens"       INTEGER,
  "finish_reason"       TEXT,
  "error"               TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatMessage_conversation_fk"
    FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "ChatMessage_conversation_id_created_at_idx"
  ON "ChatMessage" ("conversation_id", "created_at");
CREATE INDEX IF NOT EXISTS "ChatMessage_llm_interaction_id_idx"
  ON "ChatMessage" ("llm_interaction_id");

COMMIT;
