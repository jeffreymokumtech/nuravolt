-- BESS program schema (arcs A-I): one migration covering every schema change
-- the storage work needs.
--
--   1. DataFieldType: nine more BMS/PCS field types so the connector mapper can
--      name cell-level extremes, per-rack SoC, available power headroom, alarm
--      codes and insulation resistance instead of dropping them as `unmapped`.
--   2. Plant.energy_capacity_mwh: nullable on purpose. PV plants stay NULL so
--      the pricing meter max(MW, MWh/4) falls back to MW and no existing bill
--      moves.
--   3. BessDispatchSchedule.currency: GB assets settle in GBP. The existing
--      *_eur amount columns are NOT renamed (too invasive); currency is the
--      authority for what the amounts are denominated in.
--   4. provenance on the four BESS fact tables: every row today comes from the
--      synthesised dispatch twin. Per-row provenance lets charts shade the
--      modelled window once real OEM telemetry starts landing, instead of
--      relying on a plant-wide banner.
--   5. ContractType: tolling, capacity market and ancillary agreements.
--   6. PlantAlertKind: BESS_SAFETY.
--
-- Additive only. Every statement is guarded with IF NOT EXISTS, so the file is
-- safe to re-run. ALTER TYPE ... ADD VALUE is fine here because none of the new
-- enum values is referenced later in the same file. Applied out-of-band via
-- psql on local + prod (migrate dev is broken by an old shadow-DB migration).

-- 1. Connector vocabulary for BMS/PCS telemetry.
ALTER TYPE "DataFieldType" ADD VALUE IF NOT EXISTS 'bess_voltage_cell_max';
ALTER TYPE "DataFieldType" ADD VALUE IF NOT EXISTS 'bess_voltage_cell_min';
ALTER TYPE "DataFieldType" ADD VALUE IF NOT EXISTS 'bess_temp_cell_max';
ALTER TYPE "DataFieldType" ADD VALUE IF NOT EXISTS 'bess_temp_cell_min';
ALTER TYPE "DataFieldType" ADD VALUE IF NOT EXISTS 'bess_soc_rack';
ALTER TYPE "DataFieldType" ADD VALUE IF NOT EXISTS 'bess_available_charge_power';
ALTER TYPE "DataFieldType" ADD VALUE IF NOT EXISTS 'bess_available_discharge_power';
ALTER TYPE "DataFieldType" ADD VALUE IF NOT EXISTS 'bess_alarm_code';
ALTER TYPE "DataFieldType" ADD VALUE IF NOT EXISTS 'bess_insulation_resistance';

-- 5. Storage-side commercial agreements.
ALTER TYPE "ContractType" ADD VALUE IF NOT EXISTS 'BESS_TOLLING';
ALTER TYPE "ContractType" ADD VALUE IF NOT EXISTS 'BESS_CAPACITY_MARKET';
ALTER TYPE "ContractType" ADD VALUE IF NOT EXISTS 'BESS_ANCILLARY';

-- 6. Safety-envelope breaches on a storage asset.
ALTER TYPE "PlantAlertKind" ADD VALUE IF NOT EXISTS 'BESS_SAFETY';

-- 2. Energy capacity. NULL for PV: the pricing meter reads max(MW, MWh/4).
ALTER TABLE "Plant" ADD COLUMN IF NOT EXISTS "energy_capacity_mwh" DECIMAL(10,3);

-- 3. Settlement currency for a dispatch schedule's economics.
ALTER TABLE "BessDispatchSchedule" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'EUR';

-- 4. Per-row provenance: 'modelled' | 'measured'.
ALTER TABLE "BessDispatchSchedule" ADD COLUMN IF NOT EXISTS "provenance" TEXT NOT NULL DEFAULT 'modelled';
ALTER TABLE "BessCycleRecord" ADD COLUMN IF NOT EXISTS "provenance" TEXT NOT NULL DEFAULT 'modelled';
ALTER TABLE "BessCapacityTest" ADD COLUMN IF NOT EXISTS "provenance" TEXT NOT NULL DEFAULT 'modelled';
ALTER TABLE "BessWarrantyStatus" ADD COLUMN IF NOT EXISTS "provenance" TEXT NOT NULL DEFAULT 'modelled';
