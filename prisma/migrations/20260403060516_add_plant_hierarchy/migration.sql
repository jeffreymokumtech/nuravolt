-- CreateEnum
CREATE TYPE "public"."AssetType" AS ENUM ('PV', 'BESS', 'WIND', 'HYBRID');

-- CreateEnum
CREATE TYPE "public"."PlantStatus" AS ENUM ('ONBOARDING', 'CONFIGURING', 'TRAINING', 'OPERATIONAL', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "public"."DataSourceType" AS ENUM ('SCADA', 'WEATHER_STATION', 'SATELLITE_IRR', 'DUSTIQ', 'GRID_METER', 'MANUAL_CSV', 'API_WEATHER');

-- CreateEnum
CREATE TYPE "public"."DataSourcePurpose" AS ENUM ('INVERTER_DATA', 'WEATHER_DATA', 'IRRADIANCE_DATA', 'SOILING_MEASUREMENT', 'GRID_METERING', 'SUPPLEMENTARY');

-- CreateEnum
CREATE TYPE "public"."BessChemistry" AS ENUM ('LFP', 'NMC', 'NCA', 'LTO');

-- CreateEnum
CREATE TYPE "public"."WarrantyViolationType" AS ENUM ('TEMPERATURE_EXCEED', 'SOC_HIGH_DWELL', 'SOC_LOW_DWELL', 'CYCLING_DEPTH', 'CYCLING_FREQUENCY', 'C_RATE_EXCEED', 'VOLTAGE_VIOLATION', 'THROUGHPUT_EXCEED', 'HVAC_FAILURE', 'RTE_DEGRADATION', 'CAPACITY_DEGRADATION');

-- CreateEnum
CREATE TYPE "public"."WarrantyRiskLevel" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "public"."LLMProvider" AS ENUM ('AZURE_OPENAI', 'AWS_BEDROCK', 'MOCK');

-- CreateEnum
CREATE TYPE "public"."LLMModel" AS ENUM ('GPT_4O', 'GPT_4O_MINI', 'CLAUDE_3_5_SONNET', 'CLAUDE_3_HAIKU');

-- CreateEnum
CREATE TYPE "public"."LLMInteractionType" AS ENUM ('ALERT_INTERPRETATION', 'KNOWLEDGE_QUERY', 'REPORT_GENERATION', 'EMBEDDING');

-- CreateEnum
CREATE TYPE "public"."AlertUrgency" AS ENUM ('IMMEDIATE', 'WITHIN_24H', 'WITHIN_7D', 'MONITOR');

-- CreateEnum
CREATE TYPE "public"."AlertConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- AlterEnum
ALTER TYPE "public"."ConnectionType" ADD VALUE 'sungrow_api';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."DataFieldType" ADD VALUE 'reactive_power';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'voltage_ac_l1';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'voltage_ac_l2';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'voltage_ac_l3';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'current_ac_l1';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'current_ac_l2';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'current_ac_l3';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'irradiance_dni';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'temp_inverter';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'wind_speed';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'humidity';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'precipitation';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'soiling_ratio';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'frequency';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'power_factor';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'status_code';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'alarm_code';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'plant_id';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'inverter_id';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'string_id';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'timestamp';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'unmapped';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_soc';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_soh';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_power_charge';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_power_discharge';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_temp_cell';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_temp_pack';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_temp_ambient';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_voltage_cell';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_voltage_pack';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_current';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_c_rate';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_cycle_count';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_throughput';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_rte';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_hvac_status';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'bess_contactor_status';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'wind_power';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'wind_direction';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'wind_rotor_rpm';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'wind_nacelle_temp';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'wind_pitch_angle';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'wind_yaw_angle';
ALTER TYPE "public"."DataFieldType" ADD VALUE 'wind_availability';

-- DropForeignKey
ALTER TABLE "public"."PlantAccess" DROP CONSTRAINT "PlantAccess_plant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."Ticket" DROP CONSTRAINT "Ticket_plant_id_fkey";

-- AlterTable
ALTER TABLE "public"."DiscoveredPlant" ADD COLUMN     "asset_type" "public"."AssetType" NOT NULL DEFAULT 'PV';

-- CreateTable
CREATE TABLE "public"."ConnectionTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "connection_type" "public"."ConnectionType" NOT NULL,
    "description" TEXT,
    "field_patterns" JSONB NOT NULL,
    "inverter_patterns" JSONB,
    "timestamp_formats" TEXT[],
    "component_patterns" JSONB,
    "config_schema" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DataStructureAnalysis" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "data_format" TEXT NOT NULL,
    "timestamp_format" TEXT,
    "timestamp_column" TEXT,
    "total_columns" INTEGER NOT NULL,
    "numeric_columns" INTEGER NOT NULL,
    "string_columns" INTEGER NOT NULL,
    "datetime_columns" INTEGER NOT NULL,
    "detected_plants" JSONB,
    "detected_inverters" JSONB,
    "hierarchy_pattern" TEXT,
    "sample_data" JSONB,
    "column_statistics" JSONB,
    "analyzed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataStructureAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GeneratedPlantConfig" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "config_json" JSONB NOT NULL,
    "config_yaml" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "validation_status" TEXT NOT NULL DEFAULT 'pending',
    "validation_errors" JSONB,
    "validated_at" TIMESTAMP(3),
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneratedPlantConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Plant" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "asset_type" "public"."AssetType" NOT NULL DEFAULT 'PV',
    "location_name" TEXT,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "altitude" DECIMAL(7,2),
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "capacity_mw" DECIMAL(10,3) NOT NULL,
    "installed_mw" DECIMAL(10,3),
    "status" "public"."PlantStatus" NOT NULL DEFAULT 'ONBOARDING',
    "commissioning_date" DATE,
    "has_weather_station" BOOLEAN NOT NULL DEFAULT false,
    "irradiance_sensor_type" TEXT,
    "sensor_mounted_at_tilt" BOOLEAN NOT NULL DEFAULT false,
    "has_dustiq_sensor" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlantDataSource" (
    "id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "connection_id" TEXT,
    "name" TEXT NOT NULL,
    "source_type" "public"."DataSourceType" NOT NULL,
    "purpose" "public"."DataSourcePurpose" NOT NULL,
    "provides_metrics" TEXT[],
    "polling_interval" INTEGER NOT NULL DEFAULT 900,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "data_start" TIMESTAMP(3),
    "data_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlantDataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InverterGroup" (
    "id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "tilt" DECIMAL(5,2) NOT NULL,
    "azimuth" DECIMAL(5,2) NOT NULL,
    "inverter_model" TEXT,
    "inverter_nominal_power_kw" DECIMAL(8,2),
    "mppt_count" INTEGER,
    "strings_per_mppt" INTEGER,
    "gamma_pdc" DECIMAL(6,4),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InverterGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Inverter" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT,
    "model" TEXT,
    "serial_number" TEXT,
    "nominal_power_kw" DECIMAL(8,2),
    "mppt_count" INTEGER,
    "strings_per_mppt" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Inverter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LLMInteraction" (
    "id" TEXT NOT NULL,
    "org_clerk_id" TEXT,
    "user_clerk_id" TEXT,
    "provider" "public"."LLMProvider" NOT NULL,
    "model" "public"."LLMModel" NOT NULL,
    "interaction_type" "public"."LLMInteractionType" NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_usd" DECIMAL(10,6) NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "request_hash" TEXT,
    "response_cached" BOOLEAN NOT NULL DEFAULT false,
    "plant_id" TEXT,
    "ticket_id" TEXT,
    "alert_id" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LLMInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."KBDocument" (
    "id" TEXT NOT NULL,
    "org_clerk_id" TEXT,
    "plant_id" TEXT,
    "title" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "file_hash" TEXT NOT NULL,
    "source_url" TEXT,
    "equipment_type" TEXT,
    "manufacturer" TEXT,
    "model_number" TEXT,
    "processing_status" TEXT NOT NULL DEFAULT 'pending',
    "processing_error" TEXT,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "uploaded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KBDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."KBChunk" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "page_number" INTEGER,
    "section_title" TEXT,
    "token_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KBChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AlertInterpretation" (
    "id" TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "inverter_id" TEXT,
    "alert_type" TEXT NOT NULL,
    "alert_id" TEXT,
    "alert_hash" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "likely_cause" TEXT NOT NULL,
    "recommended_action" TEXT NOT NULL,
    "urgency" "public"."AlertUrgency" NOT NULL,
    "confidence" "public"."AlertConfidence" NOT NULL,
    "similar_event_ids" TEXT[],
    "llm_model" TEXT NOT NULL,
    "llm_cost_usd" DECIMAL(10,6) NOT NULL,
    "llm_latency_ms" INTEGER NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "used_fallback" BOOLEAN NOT NULL DEFAULT false,
    "cache_hit" BOOLEAN NOT NULL DEFAULT false,
    "cache_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertInterpretation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LLMUsageSummary" (
    "id" TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "period_type" TEXT NOT NULL,
    "alert_interpretation_tokens" INTEGER NOT NULL DEFAULT 0,
    "knowledge_query_tokens" INTEGER NOT NULL DEFAULT 0,
    "report_generation_tokens" INTEGER NOT NULL DEFAULT 0,
    "embedding_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_requests" INTEGER NOT NULL DEFAULT 0,
    "cached_requests" INTEGER NOT NULL DEFAULT 0,
    "failed_requests" INTEGER NOT NULL DEFAULT 0,
    "total_cost_usd" DECIMAL(10,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LLMUsageSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BessAsset" (
    "id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "external_asset_id" TEXT NOT NULL,
    "name" TEXT,
    "chemistry" "public"."BessChemistry" NOT NULL,
    "nominal_capacity_kwh" DECIMAL(10,2) NOT NULL,
    "nominal_power_kw" DECIMAL(10,2) NOT NULL,
    "module_count" INTEGER,
    "rack_count" INTEGER,
    "installation_date" DATE,
    "manufacturer" TEXT,
    "model" TEXT,
    "serial_number" TEXT,
    "metadata" JSONB,
    "current_soh" DECIMAL(5,4),
    "current_soc" DECIMAL(5,4),
    "last_capacity_test" TIMESTAMP(3),
    "last_updated" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BessAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BessWarrantyTerms" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "capacity_guarantee_pct" DECIMAL(5,4) NOT NULL,
    "warranty_years" INTEGER NOT NULL,
    "max_cycles" INTEGER,
    "max_throughput_mwh" DECIMAL(12,2),
    "min_rte" DECIMAL(5,4),
    "max_avg_soc" DECIMAL(5,4),
    "min_soc" DECIMAL(5,4),
    "soc_hold_limit_hours" INTEGER,
    "operating_temp_min_c" DECIMAL(5,2),
    "operating_temp_max_c" DECIMAL(5,2),
    "temp_violation_minutes" INTEGER,
    "max_c_rate_continuous" DECIMAL(4,2),
    "max_c_rate_peak" DECIMAL(4,2),
    "peak_duration_minutes" INTEGER,
    "cell_voltage_min_v" DECIMAL(5,3),
    "cell_voltage_max_v" DECIMAL(5,3),
    "manufacturer_terms" JSONB,
    "effective_from" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BessWarrantyTerms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BessWarrantyStatus" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "current_soh" DECIMAL(5,4) NOT NULL,
    "warranty_threshold" DECIMAL(5,4) NOT NULL,
    "soh_margin" DECIMAL(5,4) NOT NULL,
    "equivalent_full_cycles" DECIMAL(10,2) NOT NULL,
    "total_throughput_mwh" DECIMAL(12,2) NOT NULL,
    "cycle_usage_pct" DECIMAL(5,4) NOT NULL,
    "time_usage_pct" DECIMAL(5,4) NOT NULL,
    "years_remaining" DECIMAL(5,2) NOT NULL,
    "avg_rte_30d" DECIMAL(5,4),
    "warranty_health_score" DECIMAL(5,2) NOT NULL,
    "risk_level" "public"."WarrantyRiskLevel" NOT NULL,
    "projected_eol_date" DATE,
    "projected_cycles_to_eol" INTEGER,
    "active_violations" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BessWarrantyStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BessWarrantyViolation" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "violation_type" "public"."WarrantyViolationType" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "duration_minutes" INTEGER,
    "severity" TEXT NOT NULL,
    "measured_value" DECIMAL(10,4),
    "threshold_value" DECIMAL(10,4),
    "unit" TEXT,
    "description" TEXT,
    "root_cause" TEXT,
    "affected_modules" TEXT[],
    "is_resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolution_notes" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "evidence_url" TEXT,
    "ticket_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BessWarrantyViolation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BessCycleRecord" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "cycle_date" DATE NOT NULL,
    "energy_in_kwh" DECIMAL(10,2) NOT NULL,
    "energy_out_kwh" DECIMAL(10,2) NOT NULL,
    "equivalent_cycles" DECIMAL(8,4) NOT NULL,
    "cumulative_cycles" DECIMAL(10,2) NOT NULL,
    "cumulative_throughput_kwh" DECIMAL(14,2) NOT NULL,
    "avg_soc" DECIMAL(5,4),
    "max_soc" DECIMAL(5,4),
    "min_soc" DECIMAL(5,4),
    "avg_dod" DECIMAL(5,4),
    "avg_temp_c" DECIMAL(5,2),
    "max_temp_c" DECIMAL(5,2),
    "min_temp_c" DECIMAL(5,2),
    "avg_c_rate" DECIMAL(4,2),
    "max_c_rate" DECIMAL(4,2),
    "round_trip_efficiency" DECIMAL(5,4),
    "high_soc_hours" DECIMAL(5,2),
    "high_temp_hours" DECIMAL(5,2),
    "rainflow_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BessCycleRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BessCapacityTest" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "test_date" TIMESTAMP(3) NOT NULL,
    "measured_capacity_kwh" DECIMAL(10,2) NOT NULL,
    "soh_result" DECIMAL(5,4) NOT NULL,
    "capacity_retention" DECIMAL(5,4) NOT NULL,
    "test_type" TEXT NOT NULL,
    "ambient_temp_c" DECIMAL(5,2),
    "initial_soc" DECIMAL(5,4),
    "test_protocol" TEXT,
    "c_rate_used" DECIMAL(4,2),
    "duration_hours" DECIMAL(6,2),
    "is_valid" BOOLEAN NOT NULL DEFAULT true,
    "invalidation_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BessCapacityTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BessDispatchSchedule" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "schedule_date" DATE NOT NULL,
    "horizon_hours" INTEGER NOT NULL DEFAULT 24,
    "resolution_minutes" INTEGER NOT NULL DEFAULT 60,
    "charge_schedule_kw" JSONB NOT NULL,
    "discharge_schedule_kw" JSONB NOT NULL,
    "soc_schedule" JSONB NOT NULL,
    "price_forecast" JSONB NOT NULL,
    "expected_revenue_eur" DECIMAL(10,2) NOT NULL,
    "degradation_cost_eur" DECIMAL(10,2) NOT NULL,
    "net_revenue_eur" DECIMAL(10,2) NOT NULL,
    "expected_cycles" DECIMAL(6,4) NOT NULL,
    "avg_dod" DECIMAL(5,4),
    "optimizer_type" TEXT NOT NULL,
    "objective_function" TEXT,
    "solve_time_ms" INTEGER,
    "status" TEXT NOT NULL,
    "solver_message" TEXT,
    "warranty_constrained" BOOLEAN NOT NULL DEFAULT false,
    "max_cycles_constrained" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BessDispatchSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionTemplate_name_key" ON "public"."ConnectionTemplate"("name");

-- CreateIndex
CREATE INDEX "ConnectionTemplate_vendor_idx" ON "public"."ConnectionTemplate"("vendor");

-- CreateIndex
CREATE INDEX "ConnectionTemplate_connection_type_idx" ON "public"."ConnectionTemplate"("connection_type");

-- CreateIndex
CREATE UNIQUE INDEX "DataStructureAnalysis_connection_id_key" ON "public"."DataStructureAnalysis"("connection_id");

-- CreateIndex
CREATE INDEX "DataStructureAnalysis_connection_id_idx" ON "public"."DataStructureAnalysis"("connection_id");

-- CreateIndex
CREATE INDEX "GeneratedPlantConfig_connection_id_idx" ON "public"."GeneratedPlantConfig"("connection_id");

-- CreateIndex
CREATE INDEX "GeneratedPlantConfig_plant_id_idx" ON "public"."GeneratedPlantConfig"("plant_id");

-- CreateIndex
CREATE INDEX "GeneratedPlantConfig_is_active_idx" ON "public"."GeneratedPlantConfig"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedPlantConfig_connection_id_plant_id_version_key" ON "public"."GeneratedPlantConfig"("connection_id", "plant_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Plant_slug_key" ON "public"."Plant"("slug");

-- CreateIndex
CREATE INDEX "Plant_organization_id_idx" ON "public"."Plant"("organization_id");

-- CreateIndex
CREATE INDEX "Plant_asset_type_idx" ON "public"."Plant"("asset_type");

-- CreateIndex
CREATE INDEX "Plant_status_idx" ON "public"."Plant"("status");

-- CreateIndex
CREATE INDEX "PlantDataSource_plant_id_idx" ON "public"."PlantDataSource"("plant_id");

-- CreateIndex
CREATE INDEX "PlantDataSource_connection_id_idx" ON "public"."PlantDataSource"("connection_id");

-- CreateIndex
CREATE INDEX "InverterGroup_plant_id_idx" ON "public"."InverterGroup"("plant_id");

-- CreateIndex
CREATE UNIQUE INDEX "InverterGroup_plant_id_slug_key" ON "public"."InverterGroup"("plant_id", "slug");

-- CreateIndex
CREATE INDEX "Inverter_group_id_idx" ON "public"."Inverter"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "Inverter_group_id_external_id_key" ON "public"."Inverter"("group_id", "external_id");

-- CreateIndex
CREATE INDEX "LLMInteraction_org_clerk_id_idx" ON "public"."LLMInteraction"("org_clerk_id");

-- CreateIndex
CREATE INDEX "LLMInteraction_created_at_idx" ON "public"."LLMInteraction"("created_at");

-- CreateIndex
CREATE INDEX "LLMInteraction_interaction_type_idx" ON "public"."LLMInteraction"("interaction_type");

-- CreateIndex
CREATE INDEX "LLMInteraction_model_idx" ON "public"."LLMInteraction"("model");

-- CreateIndex
CREATE INDEX "LLMInteraction_plant_id_idx" ON "public"."LLMInteraction"("plant_id");

-- CreateIndex
CREATE INDEX "KBDocument_org_clerk_id_idx" ON "public"."KBDocument"("org_clerk_id");

-- CreateIndex
CREATE INDEX "KBDocument_plant_id_idx" ON "public"."KBDocument"("plant_id");

-- CreateIndex
CREATE INDEX "KBDocument_equipment_type_idx" ON "public"."KBDocument"("equipment_type");

-- CreateIndex
CREATE INDEX "KBDocument_processing_status_idx" ON "public"."KBDocument"("processing_status");

-- CreateIndex
CREATE UNIQUE INDEX "KBDocument_org_clerk_id_file_hash_key" ON "public"."KBDocument"("org_clerk_id", "file_hash");

-- CreateIndex
CREATE INDEX "KBChunk_document_id_idx" ON "public"."KBChunk"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "KBChunk_document_id_chunk_index_key" ON "public"."KBChunk"("document_id", "chunk_index");

-- CreateIndex
CREATE INDEX "AlertInterpretation_org_clerk_id_idx" ON "public"."AlertInterpretation"("org_clerk_id");

-- CreateIndex
CREATE INDEX "AlertInterpretation_plant_id_idx" ON "public"."AlertInterpretation"("plant_id");

-- CreateIndex
CREATE INDEX "AlertInterpretation_alert_type_idx" ON "public"."AlertInterpretation"("alert_type");

-- CreateIndex
CREATE INDEX "AlertInterpretation_created_at_idx" ON "public"."AlertInterpretation"("created_at");

-- CreateIndex
CREATE INDEX "AlertInterpretation_cache_expires_at_idx" ON "public"."AlertInterpretation"("cache_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "AlertInterpretation_alert_hash_key" ON "public"."AlertInterpretation"("alert_hash");

-- CreateIndex
CREATE INDEX "LLMUsageSummary_org_clerk_id_idx" ON "public"."LLMUsageSummary"("org_clerk_id");

-- CreateIndex
CREATE INDEX "LLMUsageSummary_period_start_idx" ON "public"."LLMUsageSummary"("period_start");

-- CreateIndex
CREATE UNIQUE INDEX "LLMUsageSummary_org_clerk_id_period_start_period_type_key" ON "public"."LLMUsageSummary"("org_clerk_id", "period_start", "period_type");

-- CreateIndex
CREATE INDEX "BessAsset_plant_id_idx" ON "public"."BessAsset"("plant_id");

-- CreateIndex
CREATE INDEX "BessAsset_chemistry_idx" ON "public"."BessAsset"("chemistry");

-- CreateIndex
CREATE INDEX "BessAsset_manufacturer_idx" ON "public"."BessAsset"("manufacturer");

-- CreateIndex
CREATE UNIQUE INDEX "BessAsset_plant_id_external_asset_id_key" ON "public"."BessAsset"("plant_id", "external_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "BessWarrantyTerms_asset_id_key" ON "public"."BessWarrantyTerms"("asset_id");

-- CreateIndex
CREATE INDEX "BessWarrantyStatus_asset_id_snapshot_date_idx" ON "public"."BessWarrantyStatus"("asset_id", "snapshot_date");

-- CreateIndex
CREATE INDEX "BessWarrantyStatus_risk_level_idx" ON "public"."BessWarrantyStatus"("risk_level");

-- CreateIndex
CREATE UNIQUE INDEX "BessWarrantyStatus_asset_id_snapshot_date_key" ON "public"."BessWarrantyStatus"("asset_id", "snapshot_date");

-- CreateIndex
CREATE INDEX "BessWarrantyViolation_asset_id_idx" ON "public"."BessWarrantyViolation"("asset_id");

-- CreateIndex
CREATE INDEX "BessWarrantyViolation_violation_type_idx" ON "public"."BessWarrantyViolation"("violation_type");

-- CreateIndex
CREATE INDEX "BessWarrantyViolation_started_at_idx" ON "public"."BessWarrantyViolation"("started_at");

-- CreateIndex
CREATE INDEX "BessWarrantyViolation_severity_idx" ON "public"."BessWarrantyViolation"("severity");

-- CreateIndex
CREATE INDEX "BessWarrantyViolation_is_resolved_idx" ON "public"."BessWarrantyViolation"("is_resolved");

-- CreateIndex
CREATE INDEX "BessCycleRecord_asset_id_cycle_date_idx" ON "public"."BessCycleRecord"("asset_id", "cycle_date");

-- CreateIndex
CREATE UNIQUE INDEX "BessCycleRecord_asset_id_cycle_date_key" ON "public"."BessCycleRecord"("asset_id", "cycle_date");

-- CreateIndex
CREATE INDEX "BessCapacityTest_asset_id_test_date_idx" ON "public"."BessCapacityTest"("asset_id", "test_date");

-- CreateIndex
CREATE INDEX "BessDispatchSchedule_asset_id_schedule_date_idx" ON "public"."BessDispatchSchedule"("asset_id", "schedule_date");

-- CreateIndex
CREATE UNIQUE INDEX "BessDispatchSchedule_asset_id_schedule_date_key" ON "public"."BessDispatchSchedule"("asset_id", "schedule_date");

-- CreateIndex
CREATE INDEX "DiscoveredPlant_asset_type_idx" ON "public"."DiscoveredPlant"("asset_type");

-- AddForeignKey
ALTER TABLE "public"."DataStructureAnalysis" ADD CONSTRAINT "DataStructureAnalysis_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."DataConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GeneratedPlantConfig" ADD CONSTRAINT "GeneratedPlantConfig_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."DataConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlantAccess" ADD CONSTRAINT "PlantAccess_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."Plant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Plant" ADD CONSTRAINT "Plant_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlantDataSource" ADD CONSTRAINT "PlantDataSource_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."Plant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlantDataSource" ADD CONSTRAINT "PlantDataSource_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."DataConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InverterGroup" ADD CONSTRAINT "InverterGroup_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."Plant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Inverter" ADD CONSTRAINT "Inverter_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."InverterGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Ticket" ADD CONSTRAINT "Ticket_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."Plant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."KBChunk" ADD CONSTRAINT "KBChunk_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."KBDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BessAsset" ADD CONSTRAINT "BessAsset_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."Plant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BessWarrantyTerms" ADD CONSTRAINT "BessWarrantyTerms_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."BessAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BessWarrantyStatus" ADD CONSTRAINT "BessWarrantyStatus_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."BessAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BessWarrantyViolation" ADD CONSTRAINT "BessWarrantyViolation_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."BessAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BessCycleRecord" ADD CONSTRAINT "BessCycleRecord_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."BessAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BessCapacityTest" ADD CONSTRAINT "BessCapacityTest_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."BessAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BessDispatchSchedule" ADD CONSTRAINT "BessDispatchSchedule_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."BessAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
