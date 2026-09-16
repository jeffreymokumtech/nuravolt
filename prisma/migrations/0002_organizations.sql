-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "clerk_org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan_type" TEXT NOT NULL DEFAULT 'free',
    "max_plants" INTEGER NOT NULL DEFAULT 5,
    "max_users" INTEGER NOT NULL DEFAULT 5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "user_clerk_id" TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "DataConnection" ADD COLUMN "organization_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_clerk_org_id_key" ON "Organization"("clerk_org_id");

-- CreateIndex
CREATE INDEX "UserRole_user_clerk_id_idx" ON "UserRole"("user_clerk_id");

-- CreateIndex
CREATE INDEX "UserRole_org_clerk_id_idx" ON "UserRole"("org_clerk_id");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_user_clerk_id_org_clerk_id_key" ON "UserRole"("user_clerk_id", "org_clerk_id");

-- CreateIndex
CREATE INDEX "DataConnection_organization_id_idx" ON "DataConnection"("organization_id");

-- AddForeignKey
ALTER TABLE "DataConnection" ADD CONSTRAINT "DataConnection_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;