-- Persist AI inverter diagnoses so the panel can show the last run without
-- re-paying for Bedrock inference, and so a diagnosis has history. Applied
-- out-of-band via psql on local + prod (migrate dev is broken by an old
-- shadow-DB migration).

CREATE TABLE "InverterDiagnosis" (
    "id" TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "fault_code" TEXT,
    "fault_name" TEXT,
    "confidence" DOUBLE PRECISION,
    "actions" JSONB,
    "reasoning" TEXT,
    "stats" JSONB,
    "classification" JSONB,
    "model" TEXT,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InverterDiagnosis_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InverterDiagnosis_plant_id_device_id_created_at_idx" ON "InverterDiagnosis"("plant_id", "device_id", "created_at");
CREATE INDEX "InverterDiagnosis_org_clerk_id_created_at_idx" ON "InverterDiagnosis"("org_clerk_id", "created_at");
