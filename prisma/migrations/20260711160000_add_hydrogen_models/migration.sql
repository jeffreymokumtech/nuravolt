-- Green hydrogen (electrolyzer) support: HYDROGEN asset type + H2 models.

ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'HYDROGEN';

CREATE TABLE "H2Asset" (
    "id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "external_asset_id" TEXT NOT NULL,
    "name" TEXT,
    "technology" TEXT NOT NULL DEFAULT 'PEM',
    "rated_power_kw" DECIMAL(10,2) NOT NULL,
    "stack_count" INTEGER,
    "rated_kg_per_h" DECIMAL(10,2) NOT NULL,
    "sec_bol_kwh_per_kg" DECIMAL(6,2) NOT NULL,
    "installation_date" DATE,
    "manufacturer" TEXT,
    "model" TEXT,
    "serial_number" TEXT,
    "metadata" JSONB,
    "current_sec_kwh_per_kg" DECIMAL(6,2),
    "stack_hours" DECIMAL(10,1),
    "last_updated" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "H2Asset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "H2ProductionRecord" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "production_date" DATE NOT NULL,
    "energy_in_kwh" DECIMAL(12,1) NOT NULL,
    "h2_out_kg" DECIMAL(10,2) NOT NULL,
    "hours_run" DECIMAL(4,1) NOT NULL,
    "avg_load_pct" DECIMAL(5,1),
    "sec_kwh_per_kg" DECIMAL(6,2) NOT NULL,
    "water_l" DECIMAL(12,1),
    "h2_price_eur_per_kg" DECIMAL(6,2),
    "revenue_eur" DECIMAL(12,2),
    "power_cost_eur" DECIMAL(12,2),
    "net_margin_eur" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "H2ProductionRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "H2StackHealth" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "measured_at" DATE NOT NULL,
    "stack_hours" DECIMAL(10,1) NOT NULL,
    "sec_kwh_per_kg" DECIMAL(6,2) NOT NULL,
    "efficiency_hhv_pct" DECIMAL(5,2) NOT NULL,
    "est_rul_hours" DECIMAL(10,0) NOT NULL,
    "health_pct" DECIMAL(5,1) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "H2StackHealth_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "H2Asset_plant_id_external_asset_id_key" ON "H2Asset"("plant_id", "external_asset_id");
CREATE INDEX "H2Asset_plant_id_idx" ON "H2Asset"("plant_id");
CREATE UNIQUE INDEX "H2ProductionRecord_asset_id_production_date_key" ON "H2ProductionRecord"("asset_id", "production_date");
CREATE INDEX "H2ProductionRecord_asset_id_production_date_idx" ON "H2ProductionRecord"("asset_id", "production_date");
CREATE UNIQUE INDEX "H2StackHealth_asset_id_measured_at_key" ON "H2StackHealth"("asset_id", "measured_at");
CREATE INDEX "H2StackHealth_asset_id_measured_at_idx" ON "H2StackHealth"("asset_id", "measured_at");

ALTER TABLE "H2Asset" ADD CONSTRAINT "H2Asset_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "Plant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "H2ProductionRecord" ADD CONSTRAINT "H2ProductionRecord_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "H2Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "H2StackHealth" ADD CONSTRAINT "H2StackHealth_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "H2Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
