-- Gold: daily energy + model residual per inverter — the SQL-over-Iceberg twin of
-- what scripts/aggregate_twins_to_db.py computes in pandas. One row per
-- (inverter_id, day). Lands as external Parquet on S3 (s3://nuravolt-lake/gold/...).
{{ config(
    materialized='external',
    location='s3://' ~ env_var('LAKE_BUCKET', 'nuravolt-lake') ~ '/gold/inverter_daily_kwh.parquet'
) }}

select
    inverter_id,
    day,
    -- twin source is hourly, so each sample's kW over 1 h is already kWh → just sum
    round(sum(value) filter (where metric = 'power_ac_actual'), 2)   as daily_kwh,
    round(avg(value) filter (where metric = 'power_ac_residual'), 3) as avg_residual_kw,
    count(*) filter (where metric = 'power_ac_actual')               as samples
from {{ ref('silver_twin_power') }}
group by 1, 2
