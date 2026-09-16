# BESS grain policy: why cell grain is addressable and deliberately unbuilt

Status: decided. Owner: analytics. Pinned by `tests/bess/test_grain_boundary.py`.

## The decision in one paragraph

The canonical BESS device id addresses five levels (asset, unit, rack, module,
cell) and the parser resolves all five. **The analytics and serving stack stops
at rack.** A cell id parses, resolves through `dim_device_map`, and flows through
`silver_bess_telemetry`, where it is attributed up to its rack and its own
identity is dropped. There is no `gold_bess_cell_daily`, no per-cell metric name,
no per-cell twin, and no cell-grain metric in the serving route. That is a
product decision with evidence behind it, not a backlog item. This document is
the evidence, including the parts that are weak.

## What is built, and where the identity stops

| Layer | File | Cell identity |
|---|---|---|
| Id convention and parser (TS) | `src/lib/services/cloud-connector.ts` | parses to grain `cell` |
| Id convention and parser (Python) | `nuravolt/lake/export_dim.py` | parses to grain `cell` |
| Device resolution snapshot | `bronze.dim_device_map` | carries `unit_no`, `rack_no`, `module_no`, `cell_no` |
| Silver | `dbt_project/models/silver/silver_bess_telemetry.sql` | emits `rack_device_id` only |
| Gold | `gold_bess_asset_daily.sql`, `gold_bess_rack_daily.sql` | asset and rack, nothing below |
| Serving | `GET /api/bess/plants/[plantId]/telemetry-query` | grain order includes `cell` for rollup, `METRIC_UNITS` has no per-cell metric |
| Imbalance | `nuravolt/bess/imbalance.py` | scores per rack, from rack members |

`silver_bess_telemetry` is the boundary. It reconstructs `rack_device_id` from
the parsed parts and passes `module_no` and `cell_no` through as columns, so a
module or cell row is attributed to the rack it belongs to and is never lost.
What it does not do is build a `module_device_id` or a `cell_device_id`, because
nothing downstream would consume one and a column that nothing consumes becomes
a column somebody eventually trusts.

Identity lives in `device_ext_id`, never in a metric name. A per-cell metric name
would multiply the `DataFieldType` enum by the cell count, which is not a naming
preference: it is the difference between an enum with 25 battery members and an
enum with hundreds of thousands. Test 4 in the pinning file enforces it.

## Why cell grain is not built

### 1. Per-cell data essentially never leaves the site

Tesla's published Powerhub device-level signal catalogue contains **zero cell,
module or rack signals**. It exposes ambient temperature, inverter AC and DC, and
MPPT strings. This is recorded in the code as well, as a deliberately empty tuple
with the reasoning attached: `TESLA_POWERHUB_SUB_ASSET_SIGNALS` in
`nuravolt/bess/manufacturer_adapters/tesla_megapack.py`.

Eaton's customer-facing Modbus map exposes maximum and minimum cell voltage and
cell temperature as **system-wide extremes**, not as a per-cell census.

Per-cell registers exist. They exist on the local CAN or Modbus bus between the
BMS and the racks, and they stay there. A cloud integration that promises per-cell
series is promising something the vendor's own published interface does not
carry.

Confidence: high for the two vendor catalogues named above, which were read
directly. Medium as a generalisation across all OEMs, because the sample is two.

### 2. The primary imbalance indicator is fully computable from the extremes

ΔV, defined as `Vcell_max − Vcell_min`, is the single best early indicator of a
developing cell fault, and two extreme members give that spread **exactly**, not
approximately. `nuravolt/bess/imbalance.py` treats them as members for that
reason, with `member_kind='extreme'` and `spread_basis` recording which basis was
used, so a rack holding several hundred cells and reporting two of them never
presents as "2 modules reporting".

The volume argument, with its arithmetic shown so the assumption is visible. Take
a 200 MWh site built from racks of roughly 330 cells. Per quantity, per-cell
reporting is 330 series per rack; the extremes are 2. That is a 167x reduction,
about 0.6% of the data volume, for a metric that is not degraded at all. The
cells-per-rack figure is an assumption, not a measurement, and it is the only
thing the ratio depends on.

**Per-cell buys culprit localisation and distribution shape. It does not buy
detection.** Detection is the product. Localisation is what a field technician
does after the alarm, on site, with the local tools that already read every cell.

### 3. "Per-cell temperature" is usually interpolation

Temperature sensors run at roughly one per 8 to 16 cells across the industry.
A vendor reporting a temperature for every cell is, in most designs, reporting an
interpolation across a sparse sensor grid. Ingesting that as measurement and
scoring a spread across it would be scoring the interpolator, not the battery.

Confidence: medium. The 8 to 16 range is an industry generalisation, not a figure
read off a specific datasheet.

### 4. "Per-cell digital twin" as marketed is something else

Two things ship under that name. Sibling outlier detection, which is what
`imbalance.py` does, at rack grain, from rack members. And a pack model with
cell-level residuals, which is a pack model. Per-cell electrochemical models at
grid scale remain research: only the visualisation and monitoring tiers are
deployable today. The one vendor doing genuine cell-level modelling does it
**on premises**, which is the correct place for it, next to the bus that has the
data.

### 5. No regulation requires it

**EU Battery Regulation 2023/1542, Article 14** requires the Annex VII data to
live **in the BMS**, and grants a **read-only access right to the owner or to any
third party acting on the owner's behalf**. That access right is commercially
useful: it is leverage for extracting data from an OEM that would rather not
share it. But every Annex VII parameter is battery-level or system-level.
**None is per-cell.** Nothing found in the regulation requires cell-level
retention.

**UL 9540A is a test method, not a monitoring requirement.** It describes fire
propagation testing of an installed system. It is regularly cited in this context
as if it mandated cell-level monitoring. It does not, and conflating the two is
the most common mistake in this argument.

## Commercial ranking of the sub-asset story

Ranked by how strong the case actually is, not by how good it sounds.

1. **Warranty claim defence. Strongest, and it works at rack grain.** OEMs deny
   claims for insufficient evidence, and the evidence that wins is a continuous,
   timestamped, provenance-tagged record of operating conditions against the
   warranty envelope. Rack grain carries that. Cell grain adds nothing a claims
   adjudicator asks for.
2. **Insurance. Real, but unquantified.** Underwriters do care about monitoring
   depth. **There is no published premium delta for cell-versus-rack monitoring.**
   Never put a percentage on this in a deck. State the mechanism, not a number.
3. **Second-life valuation. Weakest. Do not lead with it.** It depends on a
   resale market whose pricing conventions are not settled, and on a buyer who
   accepts our record over their own testing.

## Not feasible without real BMS data

Everything in this table is blocked on the same missing input: no connector emits
sub-asset device ids yet, so no bronze rows exist at rack grain. None of it is
blocked on modelling.

| Capability | Why it cannot ship today | Confidence |
|---|---|---|
| Calibrated ΔV alarm thresholds | The published 0.05 / 0.08 / 0.1 / 0.2 V staging comes from a **five-cell laboratory module**. A five-cell bench module and a 200 MWh site do not share a population, a thermal environment, or a sampling rate. Transferring those numbers to a real site would be fabricating a calibration. | Medium on the source, low on transferability |
| dV/dt and dT/dt precursor rates | **Structurally unobservable at cloud cadence.** A 0.02 C/s rise over 60 s needs sub-minute sampling; cloud APIs poll at 5 to 15 minutes. That is two orders of magnitude out, and no amount of modelling closes it. | High |
| Per-rack SoH | `nuravolt/bess/soh_estimator.py` has never been trained and `predict` raises rather than returning a number. Served SoH comes from the chemistry `EmpiricalDegradationModel` and says so. | High |
| Thermal anomaly and residual models | `ThermalAnomalyDetector` (isolation forest) and `ThermalResidualMonitor` (LSTM residual) in `nuravolt/bess/thermal_monitor.py` are referenced only by the package exports, the tests and the teaching notebook. They stay uncalled: fitting them on specimen data would learn the generator, not the battery. | High |

The dV/dt row is worth reading twice, because it is not only a limitation. It is
**why the ΔV story is the one worth selling**. The fast precursor is unreachable
from the cloud for everyone, us included. Slow ΔV drift over days and weeks is
reachable, it is exactly what a 5 to 15 minute feed of two extremes resolves, and
it is the failure mode that gives an operator enough warning to act.

## What would change this decision

One of these, not a preference:

- A vendor ships a documented cloud endpoint carrying a per-cell series, at a
  cadence that resolves something the extremes do not.
- A customer runs an on-premises collector on the local bus and asks us to
  consume its output. In that case the ids already parse, `dim_device_map`
  already carries `module_no` and `cell_no`, and silver already attributes the
  rows to their rack. The work would be a new gold model and a new metric family,
  not a redesign.
- A regulator requires cell-level retention. Nothing in 2023/1542 does today.

## Where this is pinned

`tests/bess/test_grain_boundary.py` asserts the boundary rather than describing
it, and each assertion message names the decision and points back here, so a
failure reads as "you crossed a documented line" and not as "something is
broken".
