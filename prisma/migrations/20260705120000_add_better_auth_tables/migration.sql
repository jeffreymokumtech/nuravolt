-- Better Auth core + organization plugin tables (replaced Clerk).
--
-- Purely additive: no existing table is touched. Legacy multi-tenant tables
-- (Organization, UserRole, PlantAccess, ...) keep their user_clerk_id /
-- org_clerk_id string columns, which now store Better Auth user/org ids.

CREATE TABLE "User" (
    "id"            TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "email"         TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image"         TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "Session" (
    "id"                   TEXT NOT NULL,
    "expiresAt"            TIMESTAMP(3) NOT NULL,
    "token"                TEXT NOT NULL,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    "ipAddress"            TEXT,
    "userAgent"            TEXT,
    "userId"               TEXT NOT NULL,
    "activeOrganizationId" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

CREATE TABLE "Account" (
    "id"                    TEXT NOT NULL,
    "accountId"             TEXT NOT NULL,
    "providerId"            TEXT NOT NULL,
    "userId"                TEXT NOT NULL,
    "accessToken"           TEXT,
    "refreshToken"          TEXT,
    "idToken"               TEXT,
    "accessTokenExpiresAt"  TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope"                 TEXT,
    "password"              TEXT,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Account_userId_idx" ON "Account"("userId");

CREATE TABLE "Verification" (
    "id"         TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value"      TEXT NOT NULL,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

CREATE TABLE "AuthOrganization" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "slug"      TEXT NOT NULL,
    "logo"      TEXT,
    "metadata"  TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthOrganization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthOrganization_slug_key" ON "AuthOrganization"("slug");

CREATE TABLE "Member" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "role"           TEXT NOT NULL DEFAULT 'member',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "AuthOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Member_organizationId_userId_key" ON "Member"("organizationId", "userId");
CREATE INDEX "Member_userId_idx" ON "Member"("userId");

CREATE TABLE "Invitation" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email"          TEXT NOT NULL,
    "role"           TEXT,
    "status"         TEXT NOT NULL DEFAULT 'pending',
    "expiresAt"      TIMESTAMP(3) NOT NULL,
    "inviterId"      TEXT NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "AuthOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Invitation_organizationId_idx" ON "Invitation"("organizationId");
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");
