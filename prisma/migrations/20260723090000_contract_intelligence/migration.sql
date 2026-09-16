-- Contract intelligence (arc 11): uploaded contract documents with
-- LLM-extracted, human-confirmed terms + CONTRACT_OBLIGATION alert kind.
-- Applied out-of-band via psql on local + prod (migrate dev is broken by an
-- old shadow-DB migration).

ALTER TYPE "PlantAlertKind" ADD VALUE IF NOT EXISTS 'CONTRACT_OBLIGATION';

CREATE TYPE "ContractType" AS ENUM ('PPA', 'MODULE_WARRANTY', 'INVERTER_WARRANTY', 'OM_SLA', 'BESS_WARRANTY', 'OTHER');

CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'EXPIRED', 'ARCHIVED');

CREATE TYPE "ContractTermStatus" AS ENUM ('EXTRACTED', 'CONFIRMED', 'REJECTED');

CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "org_clerk_id" TEXT,
    "plant_id" TEXT NOT NULL,
    "contract_type" "ContractType" NOT NULL,
    "title" TEXT NOT NULL,
    "counterparty" TEXT,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "effective_from" DATE,
    "effective_to" DATE,
    "source_s3_key" TEXT,
    "source_sha256" TEXT,
    "kb_document_id" TEXT,
    "bess_asset_id" TEXT,
    "extraction_model" TEXT,
    "extracted_at" TIMESTAMP(3),
    "created_by_clerk_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContractTerm" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value_numeric" DECIMAL(14,4),
    "unit" TEXT,
    "value_text" TEXT,
    "confidence" DECIMAL(3,2),
    "source_excerpt" TEXT,
    "is_explicit" BOOLEAN NOT NULL DEFAULT true,
    "status" "ContractTermStatus" NOT NULL DEFAULT 'EXTRACTED',
    "monitored" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_by_clerk_id" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractTerm_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Contract_plant_id_idx" ON "Contract"("plant_id");
CREATE INDEX "Contract_org_clerk_id_idx" ON "Contract"("org_clerk_id");
CREATE INDEX "Contract_contract_type_idx" ON "Contract"("contract_type");

CREATE UNIQUE INDEX "ContractTerm_contract_id_field_key" ON "ContractTerm"("contract_id", "field");
CREATE INDEX "ContractTerm_contract_id_idx" ON "ContractTerm"("contract_id");

ALTER TABLE "Contract" ADD CONSTRAINT "Contract_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "Plant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_bess_asset_id_fkey" FOREIGN KEY ("bess_asset_id") REFERENCES "BessAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContractTerm" ADD CONSTRAINT "ContractTerm_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
