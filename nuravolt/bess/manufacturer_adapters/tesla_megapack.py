"""
Tesla Megapack Adapter

Parses Tesla Megapack CSV exports into standard BESSReading objects.

Chemistry is a per-generation fact, not a per-product fact. The original 2019
Megapack was NMC; Megapack 2 and Megapack 2 XL are LFP. That difference moves
the cell overvoltage ceiling from about 4.2 V to about 3.65 V, which is the
difference between a detector that can fire and a detector that cannot. See
MEGAPACK_GENERATIONS below, and note that every row in it is unverified against
Tesla documentation.

What this module actually implements is parse_csv_export and
parse_json_response. There is no live Powerhub client here: fetch_realtime and
fetch_historical raise NotImplementedError rather than returning an empty that
would be indistinguishable from a real empty.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
import json

try:
    import polars as pl
except ImportError:
    pl = None

from nuravolt.bess.manufacturer_adapters.base import (
    ManufacturerAdapter,
    AdapterConfig,
    BESSReading,
    DataFormat,
)


#: Column names presumed to appear in a Tesla Megapack CSV export.
#:
#: Provenance, stated plainly: these names have NEVER been observed on a live
#: Tesla API or in a Tesla-published schema. They were previously labelled
#: "Powerhub API field names", which the file has no evidence for: Tesla's
#: published Powerhub device-level signal catalogue does not contain
#: cell_voltage_min_mv, cell_temp_min_c or hvac_active. Only parse_csv_export
#: is implemented here, so treat these as presumed CSV column headers. The
#: mapping for the live API is unknown.
#:
#: parse_csv_export renames only the columns that are actually present, so an
#: export using different headers degrades to missing fields rather than
#: wrong ones.
TESLA_CSV_EXPORT_FIELD_MAPPINGS = {
    # Presumed CSV export column -> standard BESSReading field
    "timestamp_utc": "timestamp",
    "state_of_charge_pct": "soc",
    "state_of_health_pct": "soh",
    "active_power_kw": "power_kw",
    "reactive_power_kvar": "reactive_power_kvar",
    "pack_voltage_v": "voltage_v",
    "pack_current_a": "current_a",
    "pack_temperature_c": "temperature_c",
    "cell_voltage_min_mv": "cell_voltage_min_v",
    "cell_voltage_max_mv": "cell_voltage_max_v",
    "cell_temp_min_c": "cell_temp_min_c",
    "cell_temp_max_c": "cell_temp_max_c",
    "hvac_active": "hvac_status",
    "active_fault_codes": "fault_codes",
    "energy_charged_kwh": "energy_in_kwh",
    "energy_discharged_kwh": "energy_out_kwh",
    "total_cycles": "cycle_count",
}

#: Tesla's published Powerhub device-level signal catalogue contains ZERO cell,
#: module or rack signals: only ambient temperature, inverter AC/DC and MPPT
#: strings. This is the best public evidence that rack grain with reported
#: extremes is the right product boundary, not a compromise.
TESLA_POWERHUB_SUB_ASSET_SIGNALS: tuple = ()  # deliberately empty

# Unit conversions (multiply value by factor, add offset).
# Presumed alongside the column names above: mV is the assumed cell-voltage
# unit in the export, not a unit read off a Tesla schema.
TESLA_UNIT_CONVERSIONS = {
    "soc": (0.01, 0),  # Percent to decimal
    "soh": (0.01, 0),  # Percent to decimal
    "cell_voltage_min_v": (0.001, 0),  # mV to V
    "cell_voltage_max_v": (0.001, 0),  # mV to V
}


@dataclass(frozen=True)
class MegapackGeneration:
    """
    Per-generation Megapack facts that a threshold depends on.

    ``verified`` is False on every row in MEGAPACK_GENERATIONS and is meant to
    stay that way until someone checks the row against a Tesla document and
    records which one. A caller quoting one of these numbers to an OEM can see
    from the returned dict that it was never verified.
    """

    generation: str
    chemistry: str  # must be a BessChemistry value: 'lfp', 'nmc', 'nca', 'lto'
    cell_voltage_min_v: float
    cell_voltage_max_v: float
    nominal_energy_mwh: Optional[float]
    nominal_power_mw: Optional[float]
    source: str
    verified: bool = False


#: Megapack generations. LFP from Megapack 2 onward is the load-bearing fact:
#: an NMC 4.2 V ceiling applied to an LFP pack is a violation threshold that
#: can never trip, so the detector reports clean and is structurally incapable
#: of reporting anything else.
#:
#: Cell voltage windows are the generic chemistry windows also used by
#: scripts/add_bess_to_plant.ts (LFP 2.8/3.65, NMC 3.0/4.2). They are NOT read
#: off a Tesla cell datasheet. Keeping the two agree means an asset onboarded
#: through the script and an asset scored through this adapter cannot silently
#: use different ceilings.
MEGAPACK_GENERATIONS: Dict[str, MegapackGeneration] = {
    "megapack_1": MegapackGeneration(
        generation="megapack_1",
        chemistry="nmc",
        cell_voltage_min_v=3.0,
        cell_voltage_max_v=4.2,
        nominal_energy_mwh=3.0,
        nominal_power_mw=1.5,
        source=(
            "Original 2019 Megapack, NMC per launch-era Tesla material. "
            "Cell window is the generic NMC window shared with "
            "scripts/add_bess_to_plant.ts, not a Tesla cell datasheet. "
            "Energy/power carried over from this module's earlier undated "
            "claim. Unverified."
        ),
        verified=False,
    ),
    "megapack_2": MegapackGeneration(
        generation="megapack_2",
        chemistry="lfp",
        cell_voltage_min_v=2.8,
        cell_voltage_max_v=3.65,
        nominal_energy_mwh=3.0,
        nominal_power_mw=1.5,
        source=(
            "Megapack 2 is LFP. Public fire-protection engineering reporting "
            "on Megapack 2 XL describes 8,064 LFP cells per unit. Cell window "
            "is the generic LFP window shared with "
            "scripts/add_bess_to_plant.ts, not a Tesla cell datasheet. "
            "Energy/power unverified."
        ),
        verified=False,
    ),
    "megapack_2_xl": MegapackGeneration(
        generation="megapack_2_xl",
        chemistry="lfp",
        cell_voltage_min_v=2.8,
        cell_voltage_max_v=3.65,
        nominal_energy_mwh=3.9,
        nominal_power_mw=1.937,
        source=(
            "Megapack 2 XL is LFP; public fire-protection engineering "
            "reporting states 8,064 LFP cells per unit. Cell window is the "
            "generic LFP window shared with scripts/add_bess_to_plant.ts, not "
            "a Tesla cell datasheet. Energy/power carried over from this "
            "module's earlier undated claim. Unverified."
        ),
        verified=False,
    ),
}

#: Generation assumed when a caller does not say which unit it has.
DEFAULT_MEGAPACK_GENERATION = "megapack_2"


def _resolve_generation(generation: str) -> MegapackGeneration:
    """Look up a generation, failing loudly on an unknown name."""
    try:
        return MEGAPACK_GENERATIONS[generation]
    except KeyError:
        raise ValueError(
            f"Unknown Megapack generation {generation!r}. "
            f"Known generations: {sorted(MEGAPACK_GENERATIONS)}"
        ) from None


@dataclass
class TeslaMegapackConfig(AdapterConfig):
    """Tesla Megapack specific configuration."""

    def __init__(
        self,
        api_endpoint: str = "https://api.tesla.com/energy/v1",
        api_key: Optional[str] = None,
        site_id: Optional[str] = None,
        **kwargs
    ):
        super().__init__(
            manufacturer="Tesla",
            model="Megapack",
            data_format=DataFormat.JSON_API,
            api_endpoint=api_endpoint,
            api_key=api_key,
            field_mappings=TESLA_CSV_EXPORT_FIELD_MAPPINGS,
            unit_conversions=TESLA_UNIT_CONVERSIONS,
            **kwargs
        )
        self.site_id = site_id


class TeslaMegapackAdapter(ManufacturerAdapter):
    """
    Adapter for Tesla Megapack systems.

    Implemented:
    - parse_csv_export: CSV export -> BESSReading
    - parse_json_response: an already-fetched JSON payload -> BESSReading

    Not implemented:
    - fetch_realtime / fetch_historical. There is no Powerhub client here, and
      these raise NotImplementedError rather than returning an empty result
      that would look like a plant with no data.

    Example:
        config = TeslaMegapackConfig(site_id="site-123")
        adapter = TeslaMegapackAdapter(config)

        readings = adapter.parse_csv_export("megapack_export.csv")
        df = adapter.to_polars(readings)
    """

    def __init__(self, config: TeslaMegapackConfig):
        super().__init__(config)
        self.tesla_config = config

    #: Shared explanation for the two unimplemented fetch paths.
    _NO_CLIENT = (
        "There is no Tesla Powerhub client in this adapter: no HTTP request, "
        "no authentication and no response schema. Returning an empty result "
        "would be indistinguishable from a Megapack that genuinely reported "
        "nothing. What does work today is parse_csv_export(csv_path) for a "
        "Tesla CSV export, and parse_json_response(payload) for a payload you "
        "have already fetched yourself."
    )

    def test_connection(self) -> bool:
        """
        Report whether a live connection can be tested.

        Always False: no client exists, so there is nothing to test. This
        never claimed a verified connection and does not start now.
        """
        return False

    def fetch_realtime(self) -> Optional[BESSReading]:
        """
        Not implemented: no live Powerhub client exists.

        Raises:
            NotImplementedError: always
        """
        raise NotImplementedError(
            f"TeslaMegapackAdapter.fetch_realtime is not implemented. "
            f"{self._NO_CLIENT}"
        )

    def fetch_historical(
        self,
        start_date: datetime,
        end_date: datetime,
        resolution_minutes: int = 15
    ) -> List[BESSReading]:
        """
        Not implemented: no live Powerhub client exists.

        Raises:
            NotImplementedError: always
        """
        raise NotImplementedError(
            f"TeslaMegapackAdapter.fetch_historical is not implemented "
            f"({start_date:%Y-%m-%d} to {end_date:%Y-%m-%d} requested). "
            f"{self._NO_CLIENT}"
        )

    def parse_csv_export(
        self,
        csv_path: str,
        timestamp_col: str = "timestamp_utc",
        timezone: str = "UTC"
    ) -> List[BESSReading]:
        """
        Parse Tesla CSV data export.

        Args:
            csv_path: Path to CSV file
            timestamp_col: Timestamp column name
            timezone: Timezone for timestamps

        Returns:
            List of BESSReading objects
        """
        if pl is None:
            raise ImportError("Polars is required")

        # Read CSV
        df = pl.read_csv(csv_path)

        # Apply field mappings
        rename_map = {k: v for k, v in self.config.field_mappings.items() if k in df.columns}
        df = df.rename(rename_map)

        # Convert to readings
        readings = []
        for row in df.iter_rows(named=True):
            # Parse timestamp
            ts = row.get("timestamp")
            if isinstance(ts, str):
                ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))

            # Apply unit conversions
            soc = self.apply_unit_conversion("soc", row.get("soc", 0))
            soh = self.apply_unit_conversion("soh", row.get("soh")) if row.get("soh") else None

            cell_v_min = None
            if row.get("cell_voltage_min_v"):
                cell_v_min = self.apply_unit_conversion(
                    "cell_voltage_min_v", row["cell_voltage_min_v"]
                )

            cell_v_max = None
            if row.get("cell_voltage_max_v"):
                cell_v_max = self.apply_unit_conversion(
                    "cell_voltage_max_v", row["cell_voltage_max_v"]
                )

            readings.append(BESSReading(
                timestamp=ts,
                soc=soc,
                power_kw=row.get("power_kw", 0),
                temperature_c=row.get("temperature_c", 25),
                soh=soh,
                voltage_v=row.get("voltage_v"),
                current_a=row.get("current_a"),
                cell_voltage_min_v=cell_v_min,
                cell_voltage_max_v=cell_v_max,
                cell_temp_min_c=row.get("cell_temp_min_c"),
                cell_temp_max_c=row.get("cell_temp_max_c"),
                hvac_status=row.get("hvac_status"),
                fault_codes=row.get("fault_codes", []),
            ))

        return readings

    def parse_json_response(self, response_data: Dict[str, Any]) -> List[BESSReading]:
        """
        Parse an already-fetched JSON payload into readings.

        Caveat: this reuses TESLA_CSV_EXPORT_FIELD_MAPPINGS, whose names are
        presumed CSV headers and have never been observed on a live Tesla API.
        Nothing here fetches the payload, so the caller owns the schema it
        passes in.

        Args:
            response_data: Raw payload with a 'data' array

        Returns:
            List of BESSReading objects
        """
        readings = []

        # Tesla API returns data in 'data' array
        data_points = response_data.get("data", [])

        for point in data_points:
            # Apply field mappings
            mapped = self.apply_field_mapping(point)

            # Parse timestamp
            ts = mapped.get("timestamp")
            if isinstance(ts, str):
                ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            elif isinstance(ts, (int, float)):
                ts = datetime.fromtimestamp(ts)

            # Apply unit conversions
            soc = self.apply_unit_conversion("soc", mapped.get("soc", 0))
            soh = None
            if mapped.get("soh"):
                soh = self.apply_unit_conversion("soh", mapped["soh"])

            readings.append(BESSReading(
                timestamp=ts,
                soc=soc,
                power_kw=mapped.get("power_kw", 0),
                temperature_c=mapped.get("temperature_c", 25),
                soh=soh,
                voltage_v=mapped.get("voltage_v"),
                current_a=mapped.get("current_a"),
                cell_voltage_min_v=mapped.get("cell_voltage_min_v"),
                cell_voltage_max_v=mapped.get("cell_voltage_max_v"),
                cell_temp_min_c=mapped.get("cell_temp_min_c"),
                cell_temp_max_c=mapped.get("cell_temp_max_c"),
                hvac_status=1 if mapped.get("hvac_status") else 0,
                fault_codes=mapped.get("fault_codes", []),
                metadata={
                    "energy_in_kwh": mapped.get("energy_in_kwh"),
                    "energy_out_kwh": mapped.get("energy_out_kwh"),
                    "cycle_count": mapped.get("cycle_count"),
                },
            ))

        return readings

    @staticmethod
    def get_default_warranty_terms(
        generation: str = DEFAULT_MEGAPACK_GENERATION,
    ) -> Dict[str, Any]:
        """
        Default warranty terms for a given Megapack generation.

        The cell voltage window comes from MEGAPACK_GENERATIONS, so an LFP
        generation gets an LFP ceiling. The returned dict carries the
        generation, its chemistry, the provenance string and the verified
        flag, so anything quoting these numbers to an OEM can see that no row
        has been verified against Tesla documentation.

        Args:
            generation: key into MEGAPACK_GENERATIONS

        Returns:
            Dictionary of warranty terms

        Raises:
            ValueError: unknown generation
        """
        gen = _resolve_generation(generation)
        return {
            "capacity_guarantee_pct": 0.70,  # 70% capacity at end of warranty
            "warranty_years": 15,  # 15-year warranty
            "max_cycles": 5000,  # ~5000 equivalent full cycles
            "max_throughput_mwh": None,  # Not throughput limited
            "min_rte": 0.88,  # 88% round-trip efficiency
            "operating_temp_min_c": -30,
            "operating_temp_max_c": 50,
            "max_c_rate_continuous": 0.5,  # 0.5C continuous
            "max_c_rate_peak": 1.0,  # 1C peak
            "cell_voltage_min_v": gen.cell_voltage_min_v,
            "cell_voltage_max_v": gen.cell_voltage_max_v,
            "chemistry": gen.chemistry,
            "generation": gen.generation,
            "source": gen.source,
            "verified": gen.verified,
        }

    @staticmethod
    def get_degradation_parameters(
        generation: str = DEFAULT_MEGAPACK_GENERATION,
    ) -> Dict[str, Any]:
        """
        Degradation model parameters for a given Megapack generation.

        The chemistry follows the generation: LFP from Megapack 2 onward, NMC
        for the original 2019 unit.

        Known limitation, stated rather than hidden: the coefficients below do
        NOT follow the chemistry. dod_exponent 1.5 and temperature_factor 0.05
        are the NMC row of BessConfig's chemistry table (nuravolt/bess/config.py
        _get_chemistry_params), inherited from when this module assumed every
        Megapack was NMC. They have never been fitted to Megapack field data
        and have not been re-derived for LFP, so ``verified`` is False and an
        LFP generation currently carries NMC-shaped stress coefficients.

        Args:
            generation: key into MEGAPACK_GENERATIONS

        Returns:
            Dictionary of degradation parameters

        Raises:
            ValueError: unknown generation
        """
        gen = _resolve_generation(generation)
        return {
            "chemistry": gen.chemistry,
            "generation": gen.generation,
            "cyclic_coefficient": 0.00005,
            "calendar_coefficient": 0.02,
            "temperature_factor": 0.05,
            "dod_exponent": 1.5,
            "source": gen.source,
            "verified": gen.verified,
        }
