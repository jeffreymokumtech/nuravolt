-- Latest realtime KPI snapshot per (connection, device).
--
-- Written by the cloud-connector poll path (Huawei FusionSolar today) so
-- dashboards can show live device state without scanning the S3 lake.
-- One row per device, overwritten each poll. FK cascades with the parent
-- DataConnection, consistent with FieldMapping / PollingJob / DiscoveredPlant.

-- CreateTable: LatestDeviceSnapshot
CREATE TABLE "LatestDeviceSnapshot" (
    "id"               TEXT NOT NULL,
    "connection_id"    TEXT NOT NULL,
    "plant_ext_id"     TEXT NOT NULL,
    "device_ext_id"    TEXT NOT NULL,
    "device_type"      TEXT,
    "ts"               TIMESTAMP(3) NOT NULL,
    "active_power_kw"  DOUBLE PRECISION,
    "daily_energy_kwh" DOUBLE PRECISION,
    "extra"            JSONB,
    "updated_at"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LatestDeviceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LatestDeviceSnapshot_connection_id_device_ext_id_key"
    ON "LatestDeviceSnapshot"("connection_id", "device_ext_id");
CREATE INDEX "LatestDeviceSnapshot_connection_id_idx"
    ON "LatestDeviceSnapshot"("connection_id");
CREATE INDEX "LatestDeviceSnapshot_plant_ext_id_idx"
    ON "LatestDeviceSnapshot"("plant_ext_id");

-- AddForeignKey
ALTER TABLE "LatestDeviceSnapshot"
    ADD CONSTRAINT "LatestDeviceSnapshot_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "DataConnection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
