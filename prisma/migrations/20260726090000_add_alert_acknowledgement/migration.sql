-- Operator acknowledgement on plant alerts (maturity round): ACK is metadata
-- on a still-ACTIVE alert so the one-active-row dedup invariant holds.
-- Applied out-of-band via psql on local + prod (migrate dev is broken by an
-- old shadow-DB migration).

ALTER TABLE "PlantAlert" ADD COLUMN "acknowledged_at" TIMESTAMP(3);
ALTER TABLE "PlantAlert" ADD COLUMN "acknowledged_by" TEXT;
