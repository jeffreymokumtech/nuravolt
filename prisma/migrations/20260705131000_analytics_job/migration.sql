-- AnalyticsJob: per-plant pipeline run status (Phase 3 closed loop).

CREATE TABLE "AnalyticsJob" (
    "id"            TEXT NOT NULL,
    "plant_id"      TEXT NOT NULL,
    "job_type"      TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'queued',
    "github_run_id" TEXT,
    "detail"        JSONB,
    "error"         TEXT,
    "started_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at"   TIMESTAMP(3),

    CONSTRAINT "AnalyticsJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnalyticsJob_plant_id_started_at_idx" ON "AnalyticsJob"("plant_id", "started_at");
CREATE INDEX "AnalyticsJob_status_idx" ON "AnalyticsJob"("status");
