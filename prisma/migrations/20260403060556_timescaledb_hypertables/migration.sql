-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Source measurements in long format (one row per timestamp/device/metric)
CREATE TABLE measurements (
    time        TIMESTAMPTZ      NOT NULL,
    plant_id    UUID             NOT NULL,
    device_id   TEXT             NOT NULL,
    metric      TEXT             NOT NULL,
    value       DOUBLE PRECISION NOT NULL,
    unit        TEXT,
    quality     SMALLINT         DEFAULT 0,  -- 0=raw, 1=validated, 2=gap-filled, -1=suspect
    source_id   UUID
);

SELECT create_hypertable('measurements', 'time', chunk_time_interval => INTERVAL '1 day');

CREATE UNIQUE INDEX idx_meas_unique ON measurements (time, plant_id, device_id, metric);
CREATE INDEX idx_meas_plant_device_metric ON measurements (plant_id, device_id, metric, time DESC);
CREATE INDEX idx_meas_plant_metric ON measurements (plant_id, metric, time DESC);

-- Analysis results in long format (digital twin predictions, soiling forecasts, fault detection, etc.)
CREATE TABLE analysis_results (
    time          TIMESTAMPTZ      NOT NULL,
    plant_id      UUID             NOT NULL,
    device_id     TEXT,
    domain        TEXT             NOT NULL,  -- 'soiling', 'digitaltwin', 'fault', 'bess'
    metric        TEXT             NOT NULL,
    value         DOUBLE PRECISION NOT NULL,
    confidence    REAL,
    model_version TEXT,
    run_id        UUID,
    metadata      JSONB
);

SELECT create_hypertable('analysis_results', 'time', chunk_time_interval => INTERVAL '7 days');

CREATE UNIQUE INDEX idx_ar_unique ON analysis_results (time, plant_id, COALESCE(device_id, ''), domain, metric, COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_ar_plant_domain ON analysis_results (plant_id, domain, time DESC);
CREATE INDEX idx_ar_plant_device ON analysis_results (plant_id, device_id, domain, metric, time DESC);

-- Compression policies
ALTER TABLE measurements SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'plant_id,device_id,metric',
    timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('measurements', INTERVAL '7 days');

ALTER TABLE analysis_results SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'plant_id,device_id,domain,metric',
    timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('analysis_results', INTERVAL '30 days');

-- Continuous aggregates for daily rollups
CREATE MATERIALIZED VIEW measurements_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', time) AS bucket,
    plant_id,
    device_id,
    metric,
    avg(value)   AS avg_value,
    min(value)   AS min_value,
    max(value)   AS max_value,
    count(*)     AS sample_count
FROM measurements
GROUP BY bucket, plant_id, device_id, metric
WITH NO DATA;

SELECT add_continuous_aggregate_policy('measurements_daily',
    start_offset  => INTERVAL '3 days',
    end_offset    => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day');

CREATE MATERIALIZED VIEW analysis_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', time) AS bucket,
    plant_id,
    device_id,
    domain,
    metric,
    avg(value)      AS avg_value,
    min(value)      AS min_value,
    max(value)      AS max_value,
    avg(confidence) AS avg_confidence,
    count(*)        AS sample_count
FROM analysis_results
GROUP BY bucket, plant_id, device_id, domain, metric
WITH NO DATA;

SELECT add_continuous_aggregate_policy('analysis_daily',
    start_offset  => INTERVAL '3 days',
    end_offset    => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day');
