-- Interactive dashboards + link from ScheduledReport
CREATE TABLE "Dashboard" (
  "id" TEXT PRIMARY KEY,
  "slug" TEXT NOT NULL UNIQUE,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "owner_id" TEXT,
  "organization_id" TEXT,
  "scope_plant_ids" TEXT[] NOT NULL DEFAULT '{}',
  "scope_device_ids" TEXT[] NOT NULL DEFAULT '{}',
  "default_range" TEXT NOT NULL DEFAULT 'last_30d',
  "default_from" TIMESTAMP(3),
  "default_to" TIMESTAMP(3),
  "widgets" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "share_token" TEXT UNIQUE,
  "share_expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "Dashboard_owner_id_idx" ON "Dashboard"("owner_id");
CREATE INDEX "Dashboard_organization_id_idx" ON "Dashboard"("organization_id");

ALTER TABLE "ScheduledReport"
  ADD COLUMN "dashboard_id" TEXT,
  ADD CONSTRAINT "ScheduledReport_dashboard_id_fkey"
    FOREIGN KEY ("dashboard_id") REFERENCES "Dashboard"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ScheduledReport_dashboard_id_idx" ON "ScheduledReport"("dashboard_id");
