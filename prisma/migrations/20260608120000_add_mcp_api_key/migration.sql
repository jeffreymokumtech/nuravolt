-- MCP server: external API keys
--
-- Org-scoped bearer tokens consumed by /api/mcp/[transport]. Only the
-- SHA-256 hash of the raw token is persisted.

CREATE TABLE "ApiKey" (
    "id"             TEXT NOT NULL,
    "org_clerk_id"   TEXT NOT NULL,
    "hashed_key"     TEXT NOT NULL,
    "key_prefix"     TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "scopes"         TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by"     TEXT NOT NULL,
    "last_used_at"   TIMESTAMP(3),
    "expires_at"     TIMESTAMP(3),
    "revoked_at"     TIMESTAMP(3),
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiKey_hashed_key_key" ON "ApiKey"("hashed_key");
CREATE INDEX "ApiKey_org_clerk_id_idx" ON "ApiKey"("org_clerk_id");
CREATE INDEX "ApiKey_hashed_key_idx" ON "ApiKey"("hashed_key");
