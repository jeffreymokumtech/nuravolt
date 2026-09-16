-- Plant alerts: threshold breaches from /api/cron/evaluate-alerts.

CREATE TYPE "PlantAlertKind" AS ENUM ('SOILING_LOSS', 'PERFORMANCE_RATIO', 'DATA_STALE', 'CRITICAL_FAULT');
CREATE TYPE "PlantAlertSeverity" AS ENUM ('WARNING', 'CRITICAL');
CREATE TYPE "PlantAlertStatus" AS ENUM ('ACTIVE', 'RESOLVED');

CREATE TABLE "PlantAlert" (
    "id" TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "kind" "PlantAlertKind" NOT NULL,
    "severity" "PlantAlertSeverity" NOT NULL,
    "status" "PlantAlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "dedup_key" TEXT,
    "metric_value" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "triggered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "notified_at" TIMESTAMP(3),
    "ticket_id" TEXT,
    CONSTRAINT "PlantAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlantAlert_org_clerk_id_status_idx" ON "PlantAlert"("org_clerk_id", "status");
CREATE INDEX "PlantAlert_plant_id_kind_status_idx" ON "PlantAlert"("plant_id", "kind", "status");
CREATE INDEX "PlantAlert_triggered_at_idx" ON "PlantAlert"("triggered_at");

-- One ACTIVE alert per plant+kind(+dedup); Prisma cannot express partial indexes.
CREATE UNIQUE INDEX "PlantAlert_active_dedup"
  ON "PlantAlert"("plant_id", "kind", COALESCE("dedup_key", ''))
  WHERE "status" = 'ACTIVE';

ALTER TABLE "PlantAlert" ADD CONSTRAINT "PlantAlert_plant_id_fkey"
  FOREIGN KEY ("plant_id") REFERENCES "Plant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
