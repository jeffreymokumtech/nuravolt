-- Data Quality persistence (Wave 3)
--
-- Denormalised per-stream health snapshots + operator overrides (ACK,
-- exclusions) and long-running incident grouping for the DQ Hub.
-- All tables follow the schema-wide multi-tenant convention:
-- every row carries org_clerk_id and is indexed on it. No FK
-- constraints to Plant (consistent with DataConnection / Ticket /
-- PlantAccess).

-- CreateTable: DataStreamHealth
CREATE TABLE "DataStreamHealth" (
    "id"                    TEXT NOT NULL,
    "org_clerk_id"          TEXT NOT NULL,
    "plant_id"              TEXT NOT NULL,
    "stream_id"             TEXT NOT NULL,
    "label"                 TEXT,
    "category"              TEXT NOT NULL,
    "severity"              TEXT NOT NULL,
    "last_good_at"          TIMESTAMP(3),
    "last_value"            DOUBLE PRECISION,
    "gap_minutes"           INTEGER NOT NULL DEFAULT 0,
    "attribution_cause"     TEXT,
    "attribution_narrative" TEXT,
    "affected_kpis"         TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataStreamHealth_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DataStreamHealth_org_clerk_id_plant_id_stream_id_key"
    ON "DataStreamHealth"("org_clerk_id", "plant_id", "stream_id");
CREATE INDEX "DataStreamHealth_plant_id_severity_idx"
    ON "DataStreamHealth"("plant_id", "severity");
CREATE INDEX "DataStreamHealth_org_clerk_id_plant_id_idx"
    ON "DataStreamHealth"("org_clerk_id", "plant_id");

-- CreateTable: DataQualityAcknowledgement
CREATE TABLE "DataQualityAcknowledgement" (
    "id"              TEXT NOT NULL,
    "org_clerk_id"    TEXT NOT NULL,
    "plant_id"        TEXT NOT NULL,
    "stream_id"       TEXT NOT NULL,
    "acknowledged_by" TEXT NOT NULL,
    "acknowledged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason"          TEXT,
    "expires_at"      TIMESTAMP(3),
    "incident_id"     TEXT,

    CONSTRAINT "DataQualityAcknowledgement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DataQualityAcknowledgement_org_clerk_id_plant_id_stream_id_idx"
    ON "DataQualityAcknowledgement"("org_clerk_id", "plant_id", "stream_id");
CREATE INDEX "DataQualityAcknowledgement_acknowledged_at_idx"
    ON "DataQualityAcknowledgement"("acknowledged_at");

-- CreateTable: DataStreamExclusion
CREATE TABLE "DataStreamExclusion" (
    "id"           TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "plant_id"     TEXT NOT NULL,
    "stream_id"    TEXT NOT NULL,
    "kpi_names"    TEXT[] DEFAULT ARRAY[]::TEXT[],
    "starts_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at"      TIMESTAMP(3),
    "created_by"   TEXT NOT NULL,
    "reason"       TEXT,
    "incident_id"  TEXT,

    CONSTRAINT "DataStreamExclusion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DataStreamExclusion_org_clerk_id_plant_id_stream_id_idx"
    ON "DataStreamExclusion"("org_clerk_id", "plant_id", "stream_id");
CREATE INDEX "DataStreamExclusion_starts_at_ends_at_idx"
    ON "DataStreamExclusion"("starts_at", "ends_at");

-- CreateTable: DataQualityIncident
CREATE TABLE "DataQualityIncident" (
    "id"           TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "plant_id"     TEXT NOT NULL,
    "opened_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at"    TIMESTAMP(3),
    "summary"      TEXT NOT NULL,
    "severity"     TEXT NOT NULL,
    "ticket_id"    TEXT,
    "opened_by"    TEXT NOT NULL,

    CONSTRAINT "DataQualityIncident_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DataQualityIncident_org_clerk_id_plant_id_opened_at_idx"
    ON "DataQualityIncident"("org_clerk_id", "plant_id", "opened_at");
