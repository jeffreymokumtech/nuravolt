-- Gold: one row per (plant_id, bess_asset_id, rack, day). The imbalance view:
-- a pack degrades at the weakest rack, so the numbers that matter here are
-- spreads and divergence, not averages.
--
-- ONE DEFINITION OF SPREAD, AND IT LIVES IN PYTHON
-- ------------------------------------------------
-- nuravolt/bess/imbalance.py is the authority. Its SPREAD_DEFINITION constant
-- reads, verbatim:
--
--   "instantaneous_then_worst: spread(t) = max(members at t) - min(members at
--   t), reported as the worst spread(t) over the window. Not the day envelope
--   (max over all members and times minus min over all members and times),
--   which over reads any rack whose extremes never coincide."
--
-- This model used to compute the day envelope and publish it as `temp_spread_c`
-- and `voltage_spread_v`, which are the names imbalance.py uses for the
-- instantaneous number. Two quantities under one name is exactly how they drifted
-- apart without anyone noticing: on a rack whose extremes do not coincide the
-- envelope is systematically larger, and on SoC-cycling data it over reads by
-- the whole swing. Measured on the parity fixture: 0.5 C instantaneous against
-- 4.5 C envelope for the same rack-day, a factor of nine.
--
-- So the bare names are gone on purpose, and every spread column now says which
-- question it answers:
--
--   *_spread_max_* / _p95_ / _mean_   the instantaneous spread of the definition
--                                     above, aggregated over the day. `max` is
--                                     the definition's own "worst over the
--                                     window"; `p95` exists so one bad sample
--                                     cannot own the day; `mean` is the day's
--                                     typical separation.
--   *_spread_envelope_*               the day envelope. Kept, because "how far
--                                     apart did this rack's readings get across
--                                     the whole day" is a useful question. It is
--                                     just not the same question.
--
-- Do not reintroduce a bare `voltage_spread_v` / `temp_spread_c`.
--
-- DIVISION OF LABOUR WITH imbalance.py
-- ------------------------------------
-- SQL owns descriptive statistics over fleet-years: it can scan a year of lake
-- Parquet, which Python cannot. Python owns findings for one asset-day: the
-- modified z score, the MAD, the dwell window and the availability reasons,
-- which SQL cannot express. This model therefore computes the same inner
-- quantity and deliberately emits no column whose name implies a finding: no
-- flag, no score, no "imbalanced". tests/bess/test_spread_definition_parity.py
-- runs both engines over one fixture and asserts voltage_spread_max_v equals
-- RackDayImbalance.voltage_spread_v to 1e-9.
--
-- MEMBERS
-- -------
-- The member model mirrors nuravolt/bess/rack_samples.py row for row, because
-- an instantaneous spread is only defined once you have said what a member is:
--
--   * rows below rack grain (module, cell) are real members, keyed by
--     canonical_device_id;
--   * a rack-grain max/min pair is the two edges the BMS reports, keyed '#Tmax'
--     / '#Tmin' / '#Vmax' / '#Vmin'. Two edges give the spread exactly;
--   * a rack-grain scalar is one number, keyed ''. One number is not a spread;
--   * when a rack reports real children for a quantity, its edges for that
--     quantity are dropped: an edge is a summary OF that population, so keeping
--     both would put the population's own max and min into the population twice.
--
-- Below two members at an instant there is no spread, and that instant is
-- dropped rather than emitting a zero. A zero spread reads as a perfectly
-- balanced rack, which is the strongest possible claim from the weakest
-- possible evidence. `*_spread_instants` says how many instants survived, so a
-- p95 over three points is legible as such.
--
-- TIME
-- ----
-- Members are grouped on the raw silver `ts`, not on imbalance.py's snapped
-- bucket (see its ALIGNMENT_RULE). Members of one rack normally arrive in one
-- poll payload and so share a timestamp. Where a feed jitters them apart, each
-- instant holds one member, the HAVING drops it, and the spread is null with
-- `*_spread_instants` at zero: silence, not a fabricated number. Implementing
-- ALIGNMENT_RULE here (cadence inference per asset-day, then snap to nearest)
-- is a follow-up, and it would only ever turn nulls into numbers.
--
-- soc_divergence_from_sibling_median_pct is this rack's SoC minus the median of
-- its SIBLING racks at the same instant (SIBLING_CENTRE = "median" in
-- imbalance.py), reported at the instant of largest absolute divergence. The
-- median excludes the rack itself on purpose: a mean, and a median that counts
-- the rack in its own reference, both let a diverging rack drag the centre
-- toward itself and so under report exactly the case this column exists to
-- catch. Null when the asset reports only one rack at every instant: there is
-- nothing to diverge from, and a zero there would read as "balanced".
--
-- Publishable into Postgres analysis_results without a shim:
--   day        -> --time-col
--   device_id  -> --device-col   (the canonical rack id, 'BESS <asset>.U-n.R-k')
--   plant_id   -> --plant-col
--
-- Rows: every silver sample at rack grain or below (rack, module, cell) is
-- attributed to its rack. Asset-grain and unit-grain rows are excluded: they are
-- not a rack, and folding them in would flatten exactly the divergence this
-- model exists to show.
{{ config(
    materialized='external',
    location=lake_location('gold', 'bess_rack_daily'),
    options={
        'partition_by': 'day',
        'write_partition_columns': 'true',
        'overwrite_or_ignore': 'true',
        'compression': 'zstd'
    }
) }}

with rack_samples as (

    select
        plant_id,
        plant_slug,
        bess_asset_id,
        rack_device_id,
        unit_no,
        rack_no,
        day,
        ts,
        canonical_device_id,
        device_grain,
        metric,
        value_canonical as value
    from {{ ref('silver_bess_telemetry') }}
    where value_canonical is not null
      and rack_device_id is not null

),

tagged as (

    -- coalesce because a null grain is not a child, and `null not in (...)`
    -- would drop the row from both branches of member_readings.
    select
        *,
        coalesce(device_grain, '') in ('module', 'cell') as is_child
    from rack_samples

),

member_readings as (

    -- One row per (rack, ts, quantity, member). Mirrors rack_samples.py:
    -- CHILD_METRICS, EXTREME_MEMBERS and RACK_SCALAR_METRICS, including its
    -- refusal to fold bess_voltage_pack into cell voltage (a series string is
    -- not a cell, and mixing them would fabricate a spread of hundreds of
    -- volts) and its refusal to read a max/min tag reported at child grain,
    -- which is a feed the adapter does not understand rather than a member.
    select
        plant_id,
        plant_slug,
        bess_asset_id,
        rack_device_id,
        unit_no,
        rack_no,
        day,
        ts,
        value,

        case
            when metric in ('bess_temp_cell', 'bess_temp_cell_max', 'bess_temp_cell_min')
                then 'temperature'
            when metric in ('bess_voltage_cell', 'bess_voltage_cell_max', 'bess_voltage_cell_min')
                then 'voltage'
            when metric in ('bess_soc', 'bess_soc_rack')
                then 'soc'
        end as quantity,

        case
            when is_child                         then canonical_device_id
            when metric = 'bess_temp_cell_max'    then '#Tmax'
            when metric = 'bess_temp_cell_min'    then '#Tmin'
            when metric = 'bess_voltage_cell_max' then '#Vmax'
            when metric = 'bess_voltage_cell_min' then '#Vmin'
            else ''
        end as member_id,

        case
            when is_child then 'device'
            when metric in ('bess_temp_cell_max', 'bess_temp_cell_min',
                            'bess_voltage_cell_max', 'bess_voltage_cell_min') then 'extreme'
            else 'rack'
        end as member_kind

    from tagged
    where (
              is_child
              and metric in ('bess_temp_cell', 'bess_voltage_cell', 'bess_soc')
              and canonical_device_id is not null
          )
       or (
              not is_child
              and metric in ('bess_temp_cell', 'bess_temp_cell_max', 'bess_temp_cell_min',
                             'bess_voltage_cell', 'bess_voltage_cell_max', 'bess_voltage_cell_min',
                             'bess_soc', 'bess_soc_rack')
          )

),

member_kept as (

    -- Children supersede edges for the same quantity, over the whole rack-day.
    -- (imbalance.py's adapter decides this over whatever window it was handed;
    -- this model is called per day, so the window is the day.)
    select *
    from (
        select
            *,
            max(case when member_kind = 'device' then 1 else 0 end) over (
                partition by rack_device_id, day, quantity
            ) as rack_has_children
        from member_readings
    )
    where not (member_kind = 'extreme' and rack_has_children = 1)

),

member_ts as (

    -- One value per member per instant. The median, so a member that reported
    -- twice in one instant stays one member rather than presenting as two.
    select
        plant_id,
        plant_slug,
        bess_asset_id,
        rack_device_id,
        unit_no,
        rack_no,
        day,
        ts,
        quantity,
        member_id,
        member_kind,
        median(value) as member_value
    from member_kept
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11

),

per_rack_ts as (

    -- THE spread, exactly as SPREAD_DEFINITION states it: at one instant, how
    -- far apart were the members wired in series. The HAVING is
    -- imbalance.MIN_MEMBERS_FOR_SPREAD: below two members there is no spread,
    -- and the instant is dropped rather than scored zero.
    select
        plant_id,
        plant_slug,
        bess_asset_id,
        rack_device_id,
        unit_no,
        rack_no,
        day,
        ts,
        quantity,
        max(member_value) - min(member_value) as spread
    from member_ts
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9
    having count(*) >= 2

),

per_rack_spread as (

    -- The day's summary of that instantaneous series. Six decimals is a
    -- microvolt and a micro degree, orders of magnitude below any BMS
    -- resolution, and it is the same rounding imbalance.py applies before it
    -- reports a spread, so the two planes agree digit for digit.
    select
        bess_asset_id,
        rack_device_id,
        day,

        round(max(spread)                     filter (where quantity = 'temperature'), 6) as temp_spread_max_c,
        round(quantile_cont(spread, 0.95)     filter (where quantity = 'temperature'), 6) as temp_spread_p95_c,
        round(avg(spread)                     filter (where quantity = 'temperature'), 6) as temp_spread_mean_c,
        count(*)                              filter (where quantity = 'temperature')     as temp_spread_instants,

        round(max(spread)                     filter (where quantity = 'voltage'), 6) as voltage_spread_max_v,
        round(quantile_cont(spread, 0.95)     filter (where quantity = 'voltage'), 6) as voltage_spread_p95_v,
        round(avg(spread)                     filter (where quantity = 'voltage'), 6) as voltage_spread_mean_v,
        count(*)                              filter (where quantity = 'voltage')     as voltage_spread_instants

    from per_rack_ts
    group by 1, 2, 3

),

per_rack_basis as (

    -- What the spreads were computed from, so a caption cannot over state the
    -- sample. "2 members" on a rack of 700 cells is a BMS reporting its two
    -- edges, not a rack with two modules.
    select
        rack_device_id,
        day,
        max(case when member_kind = 'device'  then 1 else 0 end) as has_device,
        max(case when member_kind = 'extreme' then 1 else 0 end) as has_extreme
    from member_kept
    group by 1, 2

),

soc_rack_ts as (

    -- The rack's own SoC at one instant: the median across whatever members
    -- reported it, matching imbalance.py's rack_series.
    select
        bess_asset_id,
        rack_device_id,
        day,
        ts,
        median(member_value) as soc_pct
    from member_ts
    where quantity = 'soc'
    group by 1, 2, 3, 4

),

soc_population as (

    select
        bess_asset_id,
        rack_device_id,
        day,
        ts,
        soc_pct,
        list({'rack': rack_device_id, 'soc': soc_pct}) over (
            partition by bess_asset_id, day, ts
        ) as population
    from soc_rack_ts

),

soc_divergence_ts as (

    -- Exclude-self median: the rack is removed from its own reference by id,
    -- so a sibling that happens to sit at the same SoC still counts.
    select
        bess_asset_id,
        rack_device_id,
        day,
        ts,
        soc_pct - list_aggregate(
            list_transform(
                list_filter(population, p -> p.rack <> rack_device_id),
                p -> p.soc
            ),
            'median'
        ) as divergence_pct
    from soc_population

),

soc_divergence_day as (

    -- The instant of largest absolute divergence, sign kept: an operator needs
    -- to know whether the rack is running ahead of its siblings or behind.
    -- Ties go to the earliest instant, matching imbalance.py's strict >.
    select
        bess_asset_id,
        rack_device_id,
        day,
        first(divergence_pct order by abs(divergence_pct) desc, ts asc) as soc_divergence_pct
    from soc_divergence_ts
    where divergence_pct is not null
    group by 1, 2, 3

),

per_rack as (

    -- Day envelopes and day counts. Deliberately over the raw readings rather
    -- than over the member model: the envelope question is "how far apart did
    -- anything this rack reported get, all day", and supersession cannot change
    -- a max or a min taken over a population that already contains its own
    -- edges.
    select
        plant_id,
        plant_slug,
        bess_asset_id,
        rack_device_id,
        unit_no,
        rack_no,
        day,

        max(value) filter (where metric in ('bess_temp_cell', 'bess_temp_cell_max')) as temp_cell_max_c,
        min(value) filter (where metric in ('bess_temp_cell', 'bess_temp_cell_min')) as temp_cell_min_c,

        max(value) filter (where metric in ('bess_voltage_cell', 'bess_voltage_cell_max')) as voltage_cell_max_v,
        min(value) filter (where metric in ('bess_voltage_cell', 'bess_voltage_cell_min')) as voltage_cell_min_v,

        avg(value) filter (where metric in ('bess_soc', 'bess_soc_rack')) as soc_mean_pct,
        max(value) filter (where metric in ('bess_soc', 'bess_soc_rack')) as soc_max_pct,
        min(value) filter (where metric in ('bess_soc', 'bess_soc_rack')) as soc_min_pct,

        max(value) filter (where metric = 'bess_voltage_pack') as voltage_pack_max_v,

        count(distinct canonical_device_id)     as devices,
        count(distinct date_trunc('hour', ts))  as hours_observed,
        count(*)                                as samples
    from rack_samples
    group by 1, 2, 3, 4, 5, 6, 7

)

select
    r.plant_id,
    r.plant_slug,
    r.bess_asset_id,
    r.rack_device_id                              as device_id,
    r.day,
    r.unit_no,
    r.rack_no,

    -- Instantaneous spread (SPREAD_DEFINITION), aggregated over the day.
    s.temp_spread_max_c,
    s.temp_spread_p95_c,
    s.temp_spread_mean_c,
    coalesce(s.temp_spread_instants, 0)           as temp_spread_instants,

    s.voltage_spread_max_v,
    s.voltage_spread_p95_v,
    s.voltage_spread_mean_v,
    coalesce(s.voltage_spread_instants, 0)        as voltage_spread_instants,

    case
        when s.temp_spread_max_c is null and s.voltage_spread_max_v is null then null
        when b.has_device = 1 and b.has_extreme = 1 then 'mixed'
        when b.has_device = 1                       then 'members'
        when b.has_extreme = 1                      then 'extremes'
    end                                           as spread_basis,

    -- Day envelope: a different question, under a name that says so.
    round(r.temp_cell_max_c, 2)                   as temp_cell_max_c,
    round(r.temp_cell_min_c, 2)                   as temp_cell_min_c,
    round(r.temp_cell_max_c - r.temp_cell_min_c, 2) as temp_spread_envelope_c,

    round(r.voltage_cell_max_v, 4)                as voltage_cell_max_v,
    round(r.voltage_cell_min_v, 4)                as voltage_cell_min_v,
    round(r.voltage_cell_max_v - r.voltage_cell_min_v, 4) as voltage_spread_envelope_v,
    round(r.voltage_pack_max_v, 2)                as voltage_pack_max_v,

    round(r.soc_mean_pct, 2)                      as soc_mean_pct,
    round(r.soc_max_pct, 2)                       as soc_max_pct,
    round(r.soc_min_pct, 2)                       as soc_min_pct,
    round(d.soc_divergence_pct, 2)                as soc_divergence_from_sibling_median_pct,

    r.hours_observed,
    r.devices,
    r.samples
from per_rack r
left join per_rack_spread s
  on  s.bess_asset_id   = r.bess_asset_id
  and s.rack_device_id  = r.rack_device_id
  and s.day             = r.day
left join per_rack_basis b
  on  b.rack_device_id  = r.rack_device_id
  and b.day             = r.day
left join soc_divergence_day d
  on  d.bess_asset_id   = r.bess_asset_id
  and d.rack_device_id  = r.rack_device_id
  and d.day             = r.day
order by r.day, r.plant_id, r.bess_asset_id, r.unit_no, r.rack_no
