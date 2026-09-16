-- Server-side acknowledgement for artifact-derived predictive faults (they have
-- no DB row of their own, so we key on a stable fault_key = hash of plant +
-- fault_type + equipment + window). Replaces the per-browser localStorage ack
-- so a teammate sees what was already triaged. Applied out-of-band via psql on
-- local + prod (migrate dev is broken by an old shadow-DB migration).

CREATE TABLE "FaultAck" (
    "id" TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "fault_key" TEXT NOT NULL,
    "acknowledged_by" TEXT,
    "acknowledged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaultAck_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FaultAck_org_clerk_id_plant_id_fault_key_key" ON "FaultAck"("org_clerk_id", "plant_id", "fault_key");
CREATE INDEX "FaultAck_plant_id_idx" ON "FaultAck"("plant_id");
