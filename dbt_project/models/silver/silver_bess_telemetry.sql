-- Silver: battery telemetry, attributed to a plant and a BESS asset, with the
-- metric name and the unit normalized. This is the join bronze cannot do on its
-- own: every poll object in the lake is anonymous (vendor plant id + vendor
-- device id), so the customer-facing grain only exists once the device_map
-- snapshot is joined in.
--
-- Grain: (plant_id, bess_asset_id, canonical_device_id, ts, metric).
--
-- Three deliberate refusals, each of which drops rows rather than guessing:
--
--   1. A device the dim could not resolve to a plant AND a BESS asset is not
--      emitted. dim.resolution says why (unresolved / data_source_sole /
--      promoted_from); a mis-attributed megawatt-hour is worse than a missing
--      one.
--   2. A metric with no entry in the bess_metric_alias seed is not emitted, and
--      a raw name that two vendors map to different canonical metrics resolves
--      to nothing at all rather than to a coin flip.
--   3. A value whose reported unit is not one this model knows how to convert
--      lands as value_canonical = null. The raw `value` and `unit` are carried
--      through untouched, so nothing is lost and nothing is invented.
--
-- Time: `day` is the UTC calendar day of the sample. The dim carries no plant
-- timezone yet, so a plant-local day is not available here.
-- TODO(verify): export Plant.timezone in nuravolt/lake/export_dim.py, then key
-- the daily rollups on the plant-local day.
{{ config(
    materialized='external',
    location=lake_location('silver', 'bess_telemetry'),
    options={
        'partition_by': 'day',
        'write_partition_columns': 'true',
        'overwrite_or_ignore': 'true',
        'compression': 'zstd'
    }
) }}

with readings as (

    select
        connection_id,
        plant_ext_id,
        device_ext_id,
        device_type,
        metric              as metric_raw,
        value,
        unit,
        ts,
        cast(ts as date)    as day
    from {{ source('bronze', 'live_readings') }}
    where value is not null
      and ts is not null

),

-- Only snapshot rows that carry a full attribution are usable downstream: a
-- battery reading with no asset has nowhere to roll up to.
dim as (

    select *
    from {{ source('bronze', 'dim_device_map') }}
    where plant_id is not null
      and bess_asset_id is not null
      and canonical_device_id is not null
    -- A snapshot is one row per device-day by construction (LatestDeviceSnapshot
    -- is unique on (connection_id, device_ext_id)). The qualify is a fan-out
    -- guard, not a fix: a duplicated dim row would double every energy number.
    qualify row_number() over (
        partition by connection_id, plant_ext_id, device_ext_id, dt
        order by bess_asset_id, canonical_device_id
    ) = 1

),

dim_first as (

    select
        connection_id,
        plant_ext_id,
        device_ext_id,
        min(dt) as first_dt
    from dim
    group by 1, 2, 3

),

-- Which snapshot resolves a given device on a given day. Done on the distinct
-- key-days (a small relation) rather than on every sample.
key_days as (

    select distinct connection_id, plant_ext_id, device_ext_id, day
    from readings

),

snapshot_for_day as (

    select
        k.connection_id,
        k.plant_ext_id,
        k.device_ext_id,
        k.day,
        -- The newest snapshot at or before the reading's day. A reading that
        -- predates every snapshot falls back to the earliest one: backfilled
        -- telemetry is still the same physical device.
        coalesce(d.dt, f.first_dt) as dim_dt
    from key_days k
    asof left join dim d
      on  k.connection_id = d.connection_id
      and k.plant_ext_id  = d.plant_ext_id
      and k.device_ext_id = d.device_ext_id
      and k.day          >= d.dt
    left join dim_first f
      on  k.connection_id = f.connection_id
      and k.plant_ext_id  = f.plant_ext_id
      and k.device_ext_id = f.device_ext_id

),

-- Vendor tag -> canonical metric. Reference data, so a vendor renaming a tag is
-- a seed edit, not a code deploy. `vendor` is documentation until the
-- connection's vendor reaches the dim: bronze rows carry no vendor column, so
-- the join is on the raw name alone, and a raw name that means two different
-- things across vendors is dropped by the HAVING rather than resolved wrongly.
alias as (

    select
        lower(trim(raw_metric))  as raw_key,
        min(canonical_metric)    as canonical_metric
    from {{ ref('bess_metric_alias') }}
    where raw_metric is not null
      and canonical_metric is not null
    group by 1
    having count(distinct canonical_metric) = 1

),

joined as (

    select
        r.day,
        r.ts,
        d.plant_id,
        d.plant_slug,
        d.country,
        d.currency,
        d.bess_asset_id,
        d.asset_external_id,
        d.asset_token,
        d.canonical_device_id,
        d.device_grain,
        d.unit_no,
        d.rack_no,
        d.module_no,
        d.cell_no,
        a.canonical_metric      as metric,
        r.metric_raw,
        r.value,
        r.unit,
        d.nominal_capacity_kwh,
        d.nominal_power_kw,
        d.resolution,
        d.asset_match,
        d.dt                    as dim_dt,
        r.connection_id,
        r.device_ext_id,
        coalesce(d.device_type, r.device_type) as device_type
    from readings r
    join snapshot_for_day s
      on  s.connection_id = r.connection_id
      and s.plant_ext_id  = r.plant_ext_id
      and s.device_ext_id = r.device_ext_id
      and s.day           = r.day
    join dim d
      on  d.connection_id = r.connection_id
      and d.plant_ext_id  = r.plant_ext_id
      and d.device_ext_id = r.device_ext_id
      and d.dt            = s.dim_dt
    join alias a
      on a.raw_key = lower(trim(r.metric_raw))

),

typed as (

    select
        *,
        -- Which conversion family the canonical metric belongs to. Metrics whose
        -- reported unit is genuinely ambiguous (bess_rte can be a percentage or
        -- a ratio; status and alarm codes are codes) are left as reported.
        case
            when metric in ('bess_soc', 'bess_soh', 'bess_soc_rack')
                then 'percent'
            when metric in ('bess_power_charge', 'bess_power_discharge',
                            'bess_available_charge_power', 'bess_available_discharge_power')
                then 'power_kw'
            when metric in ('bess_temp_cell', 'bess_temp_pack', 'bess_temp_ambient',
                            'bess_temp_cell_max', 'bess_temp_cell_min')
                then 'temp_c'
            when metric in ('bess_voltage_cell', 'bess_voltage_pack',
                            'bess_voltage_cell_max', 'bess_voltage_cell_min')
                then 'voltage_v'
            when metric = 'bess_current'    then 'current_a'
            when metric = 'bess_throughput' then 'energy_kwh'
            else 'as_reported'
        end as unit_family
    from joined

)

select
    day,
    ts,
    plant_id,
    plant_slug,
    country,
    currency,
    bess_asset_id,
    asset_external_id,
    asset_token,
    canonical_device_id,
    device_grain,
    unit_no,
    rack_no,
    module_no,
    cell_no,

    -- The asset-grain device id the rest of the platform uses for this battery
    -- ('BESS <external_asset_id>', sanitized the same way buildBessDeviceId does
    -- in src/lib/services/cloud-connector.ts and bess_revenue_assurance.py).
    'BESS ' || trim(regexp_replace(replace(asset_external_id, '.', '-'), '\s+', ' ', 'g'))
        as asset_device_id,

    -- The canonical id of the rack this row belongs to, for rows at rack grain
    -- or below. Reconstructed from the parsed parts, which is exact: the asset
    -- token cannot contain a '.', so this is a prefix of the device's own id.
    case
        when rack_no is not null
            then 'BESS ' || asset_token || '.U-' || unit_no || '.R-' || rack_no
    end as rack_device_id,

    metric,
    metric_raw,
    value,
    unit,

    -- Value in the taxonomy's declared unit, or null when the reported unit is
    -- one this model cannot convert. A null unit is read as the declared unit
    -- (the connectors set it from their static field mappings; the declared
    -- units are in src/lib/ai/register-map-schema.ts).
    case unit_family
        when 'percent' then
            case when unit is null or lower(unit) in ('%', 'pct', 'percent') then value end
        when 'power_kw' then
            case
                when unit is null or lower(unit) = 'kw' then value
                when lower(unit) = 'w'  then value / 1000.0
                when lower(unit) = 'mw' then value * 1000.0
            end
        when 'temp_c' then
            case when unit is null or lower(unit) in ('c', '°c', 'degc', 'celsius') then value end
        when 'voltage_v' then
            case
                when unit is null or lower(unit) = 'v' then value
                when lower(unit) = 'mv' then value / 1000.0
                when lower(unit) = 'kv' then value * 1000.0
            end
        when 'current_a' then
            case
                when unit is null or lower(unit) = 'a' then value
                when lower(unit) = 'ma' then value / 1000.0
            end
        when 'energy_kwh' then
            case
                when unit is null or lower(unit) = 'kwh' then value
                when lower(unit) = 'wh'  then value / 1000.0
                when lower(unit) = 'mwh' then value * 1000.0
            end
        else value
    end as value_canonical,

    case unit_family
        when 'percent'    then '%'
        when 'power_kw'   then 'kW'
        when 'temp_c'     then 'C'
        when 'voltage_v'  then 'V'
        when 'current_a'  then 'A'
        when 'energy_kwh' then 'kWh'
        else unit
    end as canonical_unit,

    nominal_capacity_kwh,
    nominal_power_kw,

    -- Provenance: how the plant was resolved, how the asset was matched, and
    -- which day's snapshot did the resolving.
    resolution,
    asset_match,
    dim_dt,
    connection_id,
    device_ext_id,
    device_type
from typed
order by day, bess_asset_id, canonical_device_id, metric, ts
