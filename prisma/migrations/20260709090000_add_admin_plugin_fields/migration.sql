-- Better Auth admin plugin fields (platform admin role + impersonation)
ALTER TABLE "User"    ADD COLUMN IF NOT EXISTS "role" TEXT DEFAULT 'user';
ALTER TABLE "User"    ADD COLUMN IF NOT EXISTS "banned" BOOLEAN DEFAULT false;
ALTER TABLE "User"    ADD COLUMN IF NOT EXISTS "banReason" TEXT;
ALTER TABLE "User"    ADD COLUMN IF NOT EXISTS "banExpires" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "impersonatedBy" TEXT;
