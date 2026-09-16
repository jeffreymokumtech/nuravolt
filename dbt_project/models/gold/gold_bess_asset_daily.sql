-- Gold: one row per (plant_id, bess_asset_id, day). The daily battery record
-- the app serves: how the pack was cycled, how hard, how hot, and how much of
-- the day we actually heard from it.
--
-- Publishable into Postgres analysis_results without a shim:
--   day        -> --time-col
--   device_id  -> --device-col   ('BESS <external_asset_id>', the same id the
--                                 revenue-assurance ledger writes)
--   plant_id   -> --plant-col
--
-- Conventions, stated once so no number here is a mystery:
--
--   Grain choice. A battery reports at several grains at once (asset, unit,
--   rack, cell). Mixing them would double-count, so each family of KPIs is
--   computed at the COARSEST grain the asset actually reported that day, and
--   the grain used is emitted next to the number (soc_grain, power_grain).
--   Power is summed across devices at that grain (it is additive); SoC is
--   averaged across them (it is not).
--
--   Duplicates. Two overlapping polls can land the same vendor timestamp in
--   bronze twice. A (device, metric, timestamp) is therefore collapsed to its
--   mean before anything is integrated: identical duplicates are unaffected, and
--   a doubled megawatt-hour is a wrong number rather than a slow query.
--
--   Integration. Zero-order hold on the device's own sample grid: each reading
--   is held until that device's next reading, and the last reading of a day is
--   held for the shorter of one hour or the remainder of the day. A hold is
--   capped at one hour, so a six-hour outage contributes one hour of energy at
--   the pre-outage power rather than six. The grid is per device rather than per
--   metric so a signal that is only sent when it is non-zero (a discharge burst)
--   is still integrated over a real interval instead of collapsing to zero.
--
--   Round trip. rte_daily_pct is discharge energy over charge energy across the
--   calendar day. That is only an efficiency when the day starts and ends at the
--   same state of charge, so soc_delta_pct is published beside it: read them
--   together or not at all.
--
--   data_availability_pct is TELEMETRY coverage (distinct UTC hours heard from,
--   over 24). It is not contractual asset availability, which needs a capability
--   or an outage signal that no connector reports today.
{{ config(
    materialized='external',
    location=lake_location('gold', 'bess_asset_daily'),
    options={
        'partition_by': 'day',
        'write_partition_columns': 'true',
        'overwrite_or_ignore': 'true',
        'compression': 'zstd'
    }
) }}

with samples as (

    select
        plant_id,
        plant_slug,
        bess_asset_id,
        asset_device_id,
        day,
        ts,
        canonical_device_id,
        device_grain,
        metric,
        value_canonical as value,
        nominal_capacity_kwh,
        nominal_power_kw,
        case device_grain
            when 'asset'  then 0
            when 'unit'   then 1
            when 'rack'   then 2
            when 'module' then 3
            when 'cell'   then 4
        end as grain_rank
    from {{ ref('silver_bess_telemetry') }}
    where value_canonical is not null

),

asset_day as (

    select
        plant_id,
        plant_slug,
        bess_asset_id,
        asset_device_id,
        day,
        max(nominal_capacity_kwh)              as nominal_capacity_kwh,
        max(nominal_power_kw)                  as nominal_power_kw,
        count(*)                               as samples,
        count(distinct canonical_device_id)    as devices,
        count(distinct date_trunc('hour', ts)) as hours_observed
    from samples
    group by 1, 2, 3, 4, 5

),

-- ---------------------------------------------------------------- state of charge

soc_all as (

    select * from samples where metric in ('bess_soc', 'bess_soc_rack')

),

soc_grain as (

    select bess_asset_id, day, min(grain_rank) as grain_rank
    from soc_all
    group by 1, 2

),

-- One SoC value per (device, timestamp): a device that sends both bess_soc and
-- bess_soc_rack must not be counted twice, and bess_soc wins when both are there.
soc_ticks as (

    select
        s.bess_asset_id,
        s.day,
        s.canonical_device_id,
        s.ts,
        any_value(s.device_grain) as device_grain,
        arg_min(s.value, case when s.metric = 'bess_soc' then 0 else 1 end) as value
    from soc_all s
    join soc_grain g
      on  g.bess_asset_id = s.bess_asset_id
      and g.day           = s.day
      and g.grain_rank    = s.grain_rank
    group by s.bess_asset_id, s.day, s.canonical_device_id, s.ts

),

soc_steps as (

    select
        bess_asset_id,
        day,
        canonical_device_id,
        device_grain,
        ts,
        value,
        coalesce(
            least(date_diff('second', ts, lead(ts) over w) / 3600.0, 1.0),
            least(date_diff('second', ts, cast(day as timestamp) + interval 1 day) / 3600.0, 1.0)
        ) as step_hours
    from soc_ticks
    window w as (partition by bess_asset_id, canonical_device_id, day order by ts)

),

soc_per_device as (

    select
        bess_asset_id,
        day,
        canonical_device_id,
        -- Fixed reporting thresholds, in the column names so they cannot drift
        -- from the number: time at a high or a low state of charge is the
        -- calendar-stress signal a warranty conversation turns on.
        sum(step_hours) filter (where value >= 90) as hours_above_90,
        sum(step_hours) filter (where value <= 10) as hours_below_10,
        arg_max(value, ts) - arg_min(value, ts)    as soc_delta
    from soc_steps
    group by 1, 2, 3

),

soc as (

    select
        t.bess_asset_id,
        t.day,
        avg(t.value)              as soc_mean_pct,
        max(t.value)              as soc_max_pct,
        min(t.value)              as soc_min_pct,
        count(*)                  as soc_samples,
        any_value(t.device_grain) as soc_grain,
        -- Dwell is averaged across the devices reporting at that grain, so a
        -- pack of eight racks reads as hours of the day, not eight times over.
        avg(d.hours_above_90)     as soc_hours_above_90pct,
        avg(d.hours_below_10)     as soc_hours_below_10pct,
        avg(d.soc_delta)          as soc_delta_pct
    from soc_steps t
    join soc_per_device d
      on  d.bess_asset_id       = t.bess_asset_id
      and d.day                 = t.day
      and d.canonical_device_id = t.canonical_device_id
    group by 1, 2

),

-- ---------------------------------------------------------------- power + energy

power_all as (

    select * from samples where metric in ('bess_power_charge', 'bess_power_discharge')

),

power_grain as (

    select bess_asset_id, day, min(grain_rank) as grain_rank
    from power_all
    group by 1, 2

),

power_pts as (

    select
        p.bess_asset_id,
        p.day,
        p.canonical_device_id,
        any_value(p.device_grain) as device_grain,
        p.metric,
        p.ts,
        avg(p.value)              as value
    from power_all p
    join power_grain g
      on  g.bess_asset_id = p.bess_asset_id
      and g.day           = p.day
      and g.grain_rank    = p.grain_rank
    group by p.bess_asset_id, p.day, p.canonical_device_id, p.metric, p.ts

),

power_ticks as (

    select
        bess_asset_id,
        day,
        canonical_device_id,
        ts,
        coalesce(
            least(date_diff('second', ts, lead(ts) over w) / 3600.0, 1.0),
            least(date_diff('second', ts, cast(day as timestamp) + interval 1 day) / 3600.0, 1.0)
        ) as step_hours
    from (select distinct bess_asset_id, day, canonical_device_id, ts from power_pts)
    window w as (partition by bess_asset_id, canonical_device_id, day order by ts)

),

energy as (

    select
        p.bess_asset_id,
        p.day,
        sum(p.value * t.step_hours) filter (where p.metric = 'bess_power_charge')    / 1000.0 as charge_mwh,
        sum(p.value * t.step_hours) filter (where p.metric = 'bess_power_discharge') / 1000.0 as discharge_mwh,
        any_value(p.device_grain) as power_grain
    from power_pts p
    join power_ticks t
      on  t.bess_asset_id       = p.bess_asset_id
      and t.day                 = p.day
      and t.canonical_device_id = p.canonical_device_id
      and t.ts                  = p.ts
    group by 1, 2

),

-- Fleet power at a point in time: the devices at the reporting grain summed, so
-- the C-rate maximum is the asset's, not one rack's.
power_ts as (

    select
        bess_asset_id,
        day,
        ts,
        sum(value) filter (where metric = 'bess_power_charge')    as charge_kw,
        sum(value) filter (where metric = 'bess_power_discharge') as discharge_kw
    from power_pts
    group by 1, 2, 3

),

power_peak as (

    select
        bess_asset_id,
        day,
        max(charge_kw)    as charge_kw_max,
        max(discharge_kw) as discharge_kw_max
    from power_ts
    group by 1, 2

),

-- ---------------------------------------------------------------- temperature + reported c-rate

thermal as (

    select
        bess_asset_id,
        day,
        max(value) filter (where metric in ('bess_temp_cell', 'bess_temp_cell_max')) as temp_cell_max_c,
        min(value) filter (where metric in ('bess_temp_cell', 'bess_temp_cell_min')) as temp_cell_min_c,
        max(value) filter (where metric = 'bess_temp_pack')                          as temp_pack_max_c,
        max(value) filter (where metric = 'bess_c_rate')                             as c_rate_reported_max
    from samples
    group by 1, 2

)

select
    a.plant_id,
    a.plant_slug,
    a.bess_asset_id,
    a.asset_device_id                                as device_id,
    a.day,

    round(s.soc_mean_pct, 2)                         as soc_mean_pct,
    round(s.soc_max_pct, 2)                          as soc_max_pct,
    round(s.soc_min_pct, 2)                          as soc_min_pct,
    round(s.soc_delta_pct, 2)                        as soc_delta_pct,
    round(s.soc_hours_above_90pct, 3)                as soc_hours_above_90pct,
    round(s.soc_hours_below_10pct, 3)                as soc_hours_below_10pct,
    s.soc_grain,
    s.soc_samples,

    round(e.charge_mwh, 4)                           as charge_mwh,
    round(e.discharge_mwh, 4)                        as discharge_mwh,
    round(e.charge_mwh + e.discharge_mwh, 4)         as throughput_mwh,
    -- Only a round-trip efficiency when soc_delta_pct is near zero; see header.
    round(100.0 * e.discharge_mwh / nullif(e.charge_mwh, 0), 2) as rte_daily_pct,
    -- Equivalent full cycles: throughput over twice the nameplate energy, so one
    -- full charge plus one full discharge is one cycle. Null without a nameplate.
    round(
        (e.charge_mwh + e.discharge_mwh)
        / nullif(2.0 * a.nominal_capacity_kwh / 1000.0, 0),
        4
    )                                                as efc,
    e.power_grain,

    round(k.charge_kw_max, 2)                        as charge_kw_max,
    round(k.discharge_kw_max, 2)                     as discharge_kw_max,
    -- C-rate is power over energy capacity (1/h), computed from the fleet power
    -- at the reporting grain. c_rate_reported_max is the vendor's own figure
    -- when it sends one; the two are kept apart rather than reconciled.
    round(k.charge_kw_max / nullif(a.nominal_capacity_kwh, 0), 4)    as c_rate_charge_max,
    round(k.discharge_kw_max / nullif(a.nominal_capacity_kwh, 0), 4) as c_rate_discharge_max,
    round(t.c_rate_reported_max, 4)                  as c_rate_reported_max,

    round(t.temp_cell_max_c, 2)                      as temp_cell_max_c,
    round(t.temp_cell_min_c, 2)                      as temp_cell_min_c,
    round(t.temp_pack_max_c, 2)                      as temp_pack_max_c,

    a.hours_observed,
    round(100.0 * a.hours_observed / 24.0, 1)        as data_availability_pct,
    a.devices,
    a.samples,
    a.nominal_capacity_kwh,
    a.nominal_power_kw
from asset_day a
left join soc s
  on s.bess_asset_id = a.bess_asset_id and s.day = a.day
left join energy e
  on e.bess_asset_id = a.bess_asset_id and e.day = a.day
left join power_peak k
  on k.bess_asset_id = a.bess_asset_id and k.day = a.day
left join thermal t
  on t.bess_asset_id = a.bess_asset_id and t.day = a.day
order by a.day, a.plant_id, a.bess_asset_id
