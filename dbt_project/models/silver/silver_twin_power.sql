-- Silver: cleaned per-inverter power, long format, with a day column for rollups.
-- Reads bronze straight from the Glue Iceberg catalog; lands as external Parquet
-- on S3 (s3://nuravolt-lake/silver/...).
{{ config(
    materialized='external',
    location='s3://' ~ env_var('LAKE_BUCKET', 'nuravolt-lake') ~ '/silver/twin_power_ribera.parquet'
) }}

select
    device_id               as inverter_id,
    cast(time as date)      as day,
    time,
    metric,
    value
from {{ source('bronze', 'twin_power_ribera') }}
where value is not null
