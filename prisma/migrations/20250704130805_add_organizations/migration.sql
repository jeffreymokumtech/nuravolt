-- CreateEnum
CREATE TYPE "ConnectionType" AS ENUM ('influxdb', 'sql_scada', 'modbus_tcp', 'csv_upload', 'huawei_api');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('pending', 'connecting', 'connected', 'error', 'disabled');

-- CreateEnum
CREATE TYPE "DataFieldType" AS ENUM ('power_ac', 'power_dc', 'voltage_dc', 'current_dc', 'irradiance_poa', 'irradiance_ghi', 'temp_module', 'temp_ambient', 'power_loss', 'financial_impact', 'energy_daily', 'energy_total');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER');

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company_name" TEXT,
    "plant_capacity_mw" DECIMAL(10,2),
    "utm_source" TEXT,
    "utm_campaign" TEXT,
    "roi_calculation" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ABVariant" (
    "id" TEXT NOT NULL,
    "test_name" TEXT NOT NULL,
    "variant_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "traffic_percentage" INTEGER NOT NULL DEFAULT 50,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ABVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversionEvent" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataConnection" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "ConnectionType" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'pending',
    "config" JSONB NOT NULL,
    "secret_arn" TEXT,
    "kms_key_id" TEXT,
    "polling_interval" INTEGER NOT NULL DEFAULT 900,
    "last_poll_time" TIMESTAMP(3),
    "last_poll_status" TEXT,
    "last_error" TEXT,
    "data_start_date" TIMESTAMP(3),
    "data_end_date" TIMESTAMP(3),
    "estimated_data_points" BIGINT,
    "plants_connected" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldMapping" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "original_field" TEXT NOT NULL,
    "mapped_field" "DataFieldType" NOT NULL,
    "field_path" TEXT,
    "unit" TEXT,
    "scaling_factor" DECIMAL(10,6) NOT NULL DEFAULT 1.0,
    "offset" DECIMAL(10,6) NOT NULL DEFAULT 0.0,
    "validation_rules" JSONB,
    "confidence_score" DECIMAL(3,2),
    "is_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollingJob" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "records_fetched" INTEGER,
    "records_processed" INTEGER,
    "bytes_processed" BIGINT,
    "error_message" TEXT,
    "execution_time_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredPlant" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "external_plant_id" TEXT NOT NULL,
    "name" TEXT,
    "location" JSONB,
    "capacity_mw" DECIMAL(8,3),
    "inverter_count" INTEGER,
    "inverter_types" TEXT[],
    "commissioning_date" DATE,
    "timezone" TEXT,
    "metadata" JSONB,
    "first_data_timestamp" TIMESTAMP(3),
    "last_data_timestamp" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredPlant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionAudit" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "user_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "old_values" JSONB,
    "new_values" JSONB,
    "success" BOOLEAN NOT NULL,
    "error_message" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "clerk_org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan_type" TEXT NOT NULL DEFAULT 'free',
    "max_plants" INTEGER NOT NULL DEFAULT 5,
    "max_users" INTEGER NOT NULL DEFAULT 5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "user_clerk_id" TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_email_key" ON "Lead"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ABVariant_test_name_variant_name_key" ON "ABVariant"("test_name", "variant_name");

-- CreateIndex
CREATE INDEX "ConversionEvent_lead_id_idx" ON "ConversionEvent"("lead_id");

-- CreateIndex
CREATE INDEX "ConversionEvent_event_type_idx" ON "ConversionEvent"("event_type");

-- CreateIndex
CREATE INDEX "DataConnection_customer_id_idx" ON "DataConnection"("customer_id");

-- CreateIndex
CREATE INDEX "DataConnection_organization_id_idx" ON "DataConnection"("organization_id");

-- CreateIndex
CREATE INDEX "DataConnection_type_idx" ON "DataConnection"("type");

-- CreateIndex
CREATE INDEX "DataConnection_status_idx" ON "DataConnection"("status");

-- CreateIndex
CREATE INDEX "DataConnection_last_poll_time_idx" ON "DataConnection"("last_poll_time");

-- CreateIndex
CREATE INDEX "FieldMapping_connection_id_idx" ON "FieldMapping"("connection_id");

-- CreateIndex
CREATE INDEX "FieldMapping_mapped_field_idx" ON "FieldMapping"("mapped_field");

-- CreateIndex
CREATE UNIQUE INDEX "FieldMapping_connection_id_original_field_key" ON "FieldMapping"("connection_id", "original_field");

-- CreateIndex
CREATE INDEX "PollingJob_connection_id_idx" ON "PollingJob"("connection_id");

-- CreateIndex
CREATE INDEX "PollingJob_started_at_idx" ON "PollingJob"("started_at");

-- CreateIndex
CREATE INDEX "PollingJob_status_idx" ON "PollingJob"("status");

-- CreateIndex
CREATE INDEX "DiscoveredPlant_connection_id_idx" ON "DiscoveredPlant"("connection_id");

-- CreateIndex
CREATE INDEX "DiscoveredPlant_external_plant_id_idx" ON "DiscoveredPlant"("external_plant_id");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredPlant_connection_id_external_plant_id_key" ON "DiscoveredPlant"("connection_id", "external_plant_id");

-- CreateIndex
CREATE INDEX "ConnectionAudit_connection_id_idx" ON "ConnectionAudit"("connection_id");

-- CreateIndex
CREATE INDEX "ConnectionAudit_timestamp_idx" ON "ConnectionAudit"("timestamp");

-- CreateIndex
CREATE INDEX "ConnectionAudit_user_id_idx" ON "ConnectionAudit"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_clerk_org_id_key" ON "Organization"("clerk_org_id");

-- CreateIndex
CREATE INDEX "UserRole_user_clerk_id_idx" ON "UserRole"("user_clerk_id");

-- CreateIndex
CREATE INDEX "UserRole_org_clerk_id_idx" ON "UserRole"("org_clerk_id");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_user_clerk_id_org_clerk_id_key" ON "UserRole"("user_clerk_id", "org_clerk_id");

-- AddForeignKey
ALTER TABLE "ConversionEvent" ADD CONSTRAINT "ConversionEvent_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataConnection" ADD CONSTRAINT "DataConnection_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldMapping" ADD CONSTRAINT "FieldMapping_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "DataConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollingJob" ADD CONSTRAINT "PollingJob_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "DataConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredPlant" ADD CONSTRAINT "DiscoveredPlant_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "DataConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionAudit" ADD CONSTRAINT "ConnectionAudit_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "DataConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
