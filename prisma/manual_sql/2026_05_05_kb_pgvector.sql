-- Knowledge-base / RAG: enable pgvector, add embedding column + ANN index.
-- Bedrock Titan v2 returns 1024-dim embeddings (the model's default, configurable).
--
-- Idempotent.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "KBChunk"
  ADD COLUMN IF NOT EXISTS "embedding" vector(1024);

-- ivfflat is the simplest ANN index supported in pgvector 0.8 and is plenty
-- fast for the volumes a single-org KB will see (<<1M chunks). Cosine distance
-- matches the way Titan v2 embeddings are normalized.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'KBChunk_embedding_cosine_idx') THEN
    -- lists=100 is a reasonable default for tens of thousands of rows.
    CREATE INDEX "KBChunk_embedding_cosine_idx"
      ON "KBChunk"
      USING ivfflat ("embedding" vector_cosine_ops)
      WITH (lists = 100);
  END IF;
END$$;

COMMIT;
