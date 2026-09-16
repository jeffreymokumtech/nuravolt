-- Better Auth OIDC/MCP provider tables (OAuth for MCP clients).
-- Purely additive.

CREATE TABLE "OauthApplication" (
    "id"           TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "icon"         TEXT,
    "metadata"     TEXT,
    "clientId"     TEXT NOT NULL,
    "clientSecret" TEXT,
    "redirectUrls" TEXT NOT NULL,
    "type"         TEXT NOT NULL,
    "disabled"     BOOLEAN NOT NULL DEFAULT false,
    "userId"       TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OauthApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OauthApplication_clientId_key" ON "OauthApplication"("clientId");
CREATE INDEX "OauthApplication_userId_idx" ON "OauthApplication"("userId");

CREATE TABLE "OauthAccessToken" (
    "id"                    TEXT NOT NULL,
    "accessToken"           TEXT NOT NULL,
    "refreshToken"          TEXT,
    "accessTokenExpiresAt"  TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "clientId"              TEXT NOT NULL,
    "userId"                TEXT,
    "scopes"                TEXT NOT NULL,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OauthAccessToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OauthAccessToken_accessToken_key" ON "OauthAccessToken"("accessToken");
CREATE UNIQUE INDEX "OauthAccessToken_refreshToken_key" ON "OauthAccessToken"("refreshToken");
CREATE INDEX "OauthAccessToken_clientId_idx" ON "OauthAccessToken"("clientId");
CREATE INDEX "OauthAccessToken_userId_idx" ON "OauthAccessToken"("userId");

CREATE TABLE "OauthConsent" (
    "id"           TEXT NOT NULL,
    "clientId"     TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "scopes"       TEXT NOT NULL,
    "consentGiven" BOOLEAN NOT NULL DEFAULT false,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OauthConsent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OauthConsent_clientId_idx" ON "OauthConsent"("clientId");
CREATE INDEX "OauthConsent_userId_idx" ON "OauthConsent"("userId");
