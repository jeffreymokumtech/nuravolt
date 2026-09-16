-- MCP server: per-tool-call audit log + idempotency store

CREATE TABLE "McpToolCall" (
    "id"                   TEXT NOT NULL,
    "api_key_id"           TEXT NOT NULL,
    "org_clerk_id"         TEXT NOT NULL,
    "tool_name"            TEXT NOT NULL,
    "args_json"            JSONB NOT NULL,
    "status"               TEXT NOT NULL,
    "error_reason"         TEXT,
    "duration_ms"          INTEGER NOT NULL,
    "idempotency_key"      TEXT,
    "result_json"          JSONB,
    "ticket_id"            TEXT,
    "cleaning_schedule_id" TEXT,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpToolCall_pkey" PRIMARY KEY ("id")
);

-- Idempotency: same (key, tool, idempotency_key) must collapse to one row.
-- Postgres NULL semantics mean rows without an idempotency_key are not
-- considered duplicates of each other. This is the behaviour we want:
-- only callers who provide an explicit key opt into replay protection.
CREATE UNIQUE INDEX "McpToolCall_api_key_tool_idemp_key"
  ON "McpToolCall"("api_key_id", "tool_name", "idempotency_key");

CREATE INDEX "McpToolCall_api_key_id_idx" ON "McpToolCall"("api_key_id");
CREATE INDEX "McpToolCall_org_clerk_id_idx" ON "McpToolCall"("org_clerk_id");
CREATE INDEX "McpToolCall_created_at_idx" ON "McpToolCall"("created_at");
