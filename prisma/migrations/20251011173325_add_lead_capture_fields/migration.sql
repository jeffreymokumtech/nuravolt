-- AlterTable
ALTER TABLE "public"."Lead" ADD COLUMN     "hubspot_contact_id" TEXT,
ADD COLUMN     "linkedin_campaign_id" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "role" TEXT,
ADD COLUMN     "utm_content" TEXT,
ADD COLUMN     "utm_medium" TEXT;

-- CreateTable
CREATE TABLE "public"."ResourceDownload" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "resource_slug" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_title" TEXT,
    "downloaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "utm_params" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "ResourceDownload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResourceDownload_lead_id_idx" ON "public"."ResourceDownload"("lead_id");

-- CreateIndex
CREATE INDEX "ResourceDownload_resource_slug_idx" ON "public"."ResourceDownload"("resource_slug");

-- CreateIndex
CREATE INDEX "ResourceDownload_resource_type_idx" ON "public"."ResourceDownload"("resource_type");

-- CreateIndex
CREATE INDEX "ResourceDownload_downloaded_at_idx" ON "public"."ResourceDownload"("downloaded_at");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_hubspot_contact_id_key" ON "public"."Lead"("hubspot_contact_id");

-- AddForeignKey
ALTER TABLE "public"."ResourceDownload" ADD CONSTRAINT "ResourceDownload_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
