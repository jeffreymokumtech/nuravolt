-- CreateEnum
CREATE TYPE "PlantAccessLevel" AS ENUM ('VIEW', 'OPERATE', 'MANAGE');

-- CreateTable
CREATE TABLE "PlantAccess" (
    "id" TEXT NOT NULL,
    "user_clerk_id" TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "access_level" "PlantAccessLevel" NOT NULL DEFAULT 'VIEW',
    "granted_by" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "PlantAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlantAccess_user_clerk_id_idx" ON "PlantAccess"("user_clerk_id");

-- CreateIndex
CREATE INDEX "PlantAccess_org_clerk_id_idx" ON "PlantAccess"("org_clerk_id");

-- CreateIndex
CREATE INDEX "PlantAccess_plant_id_idx" ON "PlantAccess"("plant_id");

-- CreateIndex
CREATE INDEX "PlantAccess_expires_at_idx" ON "PlantAccess"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "PlantAccess_user_clerk_id_plant_id_key" ON "PlantAccess"("user_clerk_id", "plant_id");

-- AddForeignKey
ALTER TABLE "PlantAccess" ADD CONSTRAINT "PlantAccess_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "DiscoveredPlant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
