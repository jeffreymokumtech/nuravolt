-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateEnum
CREATE TYPE "ConnectionType" AS ENUM ('influxdb', 'sql_scada', 'modbus_tcp', 'csv_upload', 'huawei_api');

-- CreateEnum  
CREATE TYPE "ConnectionStatus" AS ENUM ('pending', 'connecting', 'connected', 'error', 'disabled');

-- CreateEnum
CREATE TYPE "DataFieldType" AS ENUM ('power_ac', 'power_dc', 'voltage_dc', 'current_dc', 'irradiance_poa', 'irradiance_ghi', 'temp_module', 'temp_ambient', 'power_loss', 'financial_impact', 'energy_daily', 'energy_total');

-- Data Connections table
CREATE TABLE "data_connections" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "customer_id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "type" "ConnectionType" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'pending',
    "config" JSONB NOT NULL, -- Encrypted connection details
    "secret_arn" VARCHAR(500), -- AWS Secrets Manager ARN
    "kms_key_id" VARCHAR(255), -- Customer KMS key
    "polling_interval" INTEGER DEFAULT 900, -- seconds (15 min default)
    "last_poll_time" TIMESTAMPTZ,
    "last_poll_status" TEXT,
    "last_error" TEXT,
    "data_start_date" TIMESTAMPTZ, -- First available data
    "data_end_date" TIMESTAMPTZ, -- Last available data  
    "estimated_data_points" BIGINT,
    "plants_connected" INTEGER DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "data_connections_pkey" PRIMARY KEY ("id")
);

-- Field Mappings table (for schema discovery and validation)
CREATE TABLE "field_mappings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "connection_id" UUID NOT NULL,
    "original_field" VARCHAR(255) NOT NULL,
    "mapped_field" "DataFieldType" NOT NULL,
    "field_path" VARCHAR(500), -- JSON path or table.column
    "unit" VARCHAR(50),
    "scaling_factor" DECIMAL(10,6) DEFAULT 1.0,
    "offset" DECIMAL(10,6) DEFAULT 0.0,
    "validation_rules" JSONB,
    "confidence_score" DECIMAL(3,2), -- 0.00 to 1.00
    "is_confirmed" BOOLEAN DEFAULT false, -- User confirmed mapping
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "field_mappings_pkey" PRIMARY KEY ("id")
);

-- Polling Jobs table (for monitoring and debugging)
CREATE TABLE "polling_jobs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "connection_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "completed_at" TIMESTAMPTZ,
    "status" VARCHAR(50) NOT NULL, -- 'running', 'completed', 'failed'
    "records_fetched" INTEGER,
    "records_processed" INTEGER,
    "bytes_processed" BIGINT,
    "error_message" TEXT,
    "execution_time_ms" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "polling_jobs_pkey" PRIMARY KEY ("id")
);

-- Plants table (discovered from data sources)
CREATE TABLE "discovered_plants" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "connection_id" UUID NOT NULL,
    "external_plant_id" VARCHAR(255) NOT NULL, -- Plant ID in source system
    "name" VARCHAR(255),
    "location" JSONB, -- {lat, lng, country, region}
    "capacity_mw" DECIMAL(8,3),
    "inverter_count" INTEGER,
    "inverter_types" TEXT[], -- Array of inverter models
    "commissioning_date" DATE,
    "timezone" VARCHAR(50),
    "metadata" JSONB, -- Additional plant info
    "first_data_timestamp" TIMESTAMPTZ,
    "last_data_timestamp" TIMESTAMPTZ,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "discovered_plants_pkey" PRIMARY KEY ("id")
);

-- Connection Audit table (for security and compliance)
CREATE TABLE "connection_audit" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "connection_id" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL, -- 'created', 'updated', 'tested', 'deleted', 'polled'
    "user_id" TEXT, -- Clerk user ID
    "ip_address" INET,
    "user_agent" TEXT,
    "old_values" JSONB,
    "new_values" JSONB,
    "success" BOOLEAN NOT NULL,
    "error_message" TEXT,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "connection_audit_pkey" PRIMARY KEY ("id")
);

-- Add foreign key constraints
ALTER TABLE "field_mappings" ADD CONSTRAINT "field_mappings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "data_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "polling_jobs" ADD CONSTRAINT "polling_jobs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "data_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "discovered_plants" ADD CONSTRAINT "discovered_plants_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "data_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "connection_audit" ADD CONSTRAINT "connection_audit_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "data_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create indexes for performance
CREATE INDEX "data_connections_customer_id_idx" ON "data_connections"("customer_id");
CREATE INDEX "data_connections_type_idx" ON "data_connections"("type");
CREATE INDEX "data_connections_status_idx" ON "data_connections"("status");
CREATE INDEX "data_connections_last_poll_time_idx" ON "data_connections"("last_poll_time");

CREATE INDEX "field_mappings_connection_id_idx" ON "field_mappings"("connection_id");
CREATE INDEX "field_mappings_mapped_field_idx" ON "field_mappings"("mapped_field");

CREATE INDEX "polling_jobs_connection_id_idx" ON "polling_jobs"("connection_id");
CREATE INDEX "polling_jobs_started_at_idx" ON "polling_jobs"("started_at");
CREATE INDEX "polling_jobs_status_idx" ON "polling_jobs"("status");

CREATE INDEX "discovered_plants_connection_id_idx" ON "discovered_plants"("connection_id");
CREATE INDEX "discovered_plants_external_plant_id_idx" ON "discovered_plants"("external_plant_id");

CREATE INDEX "connection_audit_connection_id_idx" ON "connection_audit"("connection_id");
CREATE INDEX "connection_audit_timestamp_idx" ON "connection_audit"("timestamp");
CREATE INDEX "connection_audit_user_id_idx" ON "connection_audit"("user_id");

-- Add updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Add triggers for updated_at
CREATE TRIGGER update_data_connections_updated_at BEFORE UPDATE ON data_connections FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_field_mappings_updated_at BEFORE UPDATE ON field_mappings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_discovered_plants_updated_at BEFORE UPDATE ON discovered_plants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();