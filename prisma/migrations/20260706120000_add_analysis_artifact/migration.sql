-- AnalysisArtifact: per-plant nested analysis payloads (synthesized/labeled
-- demo streams + enhanced fault detection) that don't fit the timeseries tables.

CREATE TABLE IF NOT EXISTS "AnalysisArtifact" (
    "id"            TEXT NOT NULL,
    "plant_id"      TEXT NOT NULL,
    "kind"          TEXT NOT NULL,
    "payload"       JSONB NOT NULL,
    "source"        TEXT NOT NULL DEFAULT 'synthetic',
    "model_version" TEXT,
    "generated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AnalysisArtifact_plant_id_kind_key" ON "AnalysisArtifact"("plant_id", "kind");
CREATE INDEX IF NOT EXISTS "AnalysisArtifact_plant_id_idx" ON "AnalysisArtifact"("plant_id");
