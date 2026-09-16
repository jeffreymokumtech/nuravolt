"""
Generate MPPT/string-level snapshot data for 20 Sungrow SG50CX inverters
in a 1 MW rooftop PV plant in Barcelona.

Plant layout:
  - South zone (SG50CX-01 to -10): azimuth 180, tilt 15, best performance
  - East zone (SG50CX-11 to -15): azimuth 90, tilt 10, morning-biased
  - West zone (SG50CX-16 to -20): azimuth 270, tilt 10, afternoon-biased

Faults:
  - SG50CX-08: MPPT-3 STR-1 open_circuit (0V, 0A)
  - SG50CX-18: MPPT-4 and MPPT-5 degraded (~15% below nominal)
"""

import json
import random
import os

random.seed(42)

TIMESTAMP = "2026-02-10T12:00:00Z"
PLANT_ID = "theta"
INVERTER_MODEL = "Sungrow SG50CX"
MPPT_COUNT = 6
STRINGS_PER_MPPT = 2
MODULE_COUNT = 16
NOMINAL_POWER_KW = 50.0

# Zone definitions
ZONES = {
    "south": {
        "inverters": list(range(1, 11)),
        "groupId": "south-array",
        "azimuth": 180,
        "tilt": 15,
        # Midday in Barcelona Feb 10 -- south-facing gets best irradiance
        "voltage_base": 555.0,   # V per string
        "voltage_spread": 15.0,  # +/- range
        "current_base": 5.2,     # A per string at midday
        "current_spread": 0.4,
    },
    "east": {
        "inverters": list(range(11, 16)),
        "groupId": "east-array",
        "azimuth": 90,
        "tilt": 10,
        # East-facing at midday: past peak, slightly lower
        "voltage_base": 548.0,
        "voltage_spread": 12.0,
        "current_base": 4.5,
        "current_spread": 0.35,
    },
    "west": {
        "inverters": list(range(16, 21)),
        "groupId": "west-array",
        "azimuth": 270,
        "tilt": 10,
        # West-facing at midday: approaching peak, slightly lower than south
        "voltage_base": 545.0,
        "voltage_spread": 12.0,
        "current_base": 4.3,
        "current_spread": 0.3,
    },
}


def get_zone(inv_num):
    """Return zone config for a given inverter number."""
    for zone_name, cfg in ZONES.items():
        if inv_num in cfg["inverters"]:
            return zone_name, cfg
    raise ValueError(f"Inverter {inv_num} not in any zone")


def random_degradation():
    """Annual degradation between 0.3% and 0.8%."""
    return round(random.uniform(0.3, 0.8), 2)


def generate_normal_string(string_id, zone_cfg):
    """Generate a normal healthy string."""
    voltage = round(
        zone_cfg["voltage_base"] + random.uniform(
            -zone_cfg["voltage_spread"], zone_cfg["voltage_spread"]
        ), 1
    )
    current = round(
        zone_cfg["current_base"] + random.uniform(
            -zone_cfg["current_spread"], zone_cfg["current_spread"]
        ), 2
    )
    power = round(voltage * current / 1000.0, 3)
    degradation = random_degradation()

    return {
        "stringId": string_id,
        "moduleCount": MODULE_COUNT,
        "voltage_V": voltage,
        "current_A": current,
        "power_kW": power,
        "status": "normal",
        "degradation_pct": degradation,
    }


def generate_degraded_string(string_id, zone_cfg, reduction_pct=0.15):
    """Generate a degraded string with reduced current."""
    voltage = round(
        zone_cfg["voltage_base"] + random.uniform(
            -zone_cfg["voltage_spread"], zone_cfg["voltage_spread"]
        ), 1
    )
    # Reduced current by ~reduction_pct
    base_current = zone_cfg["current_base"] + random.uniform(
        -zone_cfg["current_spread"], zone_cfg["current_spread"]
    )
    current = round(base_current * (1.0 - reduction_pct + random.uniform(-0.02, 0.02)), 2)
    power = round(voltage * current / 1000.0, 3)
    degradation = round(random.uniform(1.5, 3.0), 2)  # higher degradation

    return {
        "stringId": string_id,
        "moduleCount": MODULE_COUNT,
        "voltage_V": voltage,
        "current_A": current,
        "power_kW": power,
        "status": "degraded",
        "degradation_pct": degradation,
    }


def generate_open_circuit_string(string_id):
    """Generate an open-circuit string (0V, 0A)."""
    return {
        "stringId": string_id,
        "moduleCount": MODULE_COUNT,
        "voltage_V": 0.0,
        "current_A": 0.0,
        "power_kW": 0.0,
        "status": "open_circuit",
        "degradation_pct": 0.0,
    }


def build_mppt(mppt_id, strings):
    """Build MPPT data from its strings."""
    # MPPT voltage is the string voltage (strings in parallel share voltage)
    # Use the max non-zero voltage, or 0 if all are zero
    voltages = [s["voltage_V"] for s in strings if s["voltage_V"] > 0]
    voltage = round(sum(voltages) / len(voltages), 1) if voltages else 0.0

    # MPPT current = sum of string currents
    current = round(sum(s["current_A"] for s in strings), 2)
    power = round(sum(s["power_kW"] for s in strings), 3)

    # Determine MPPT status
    statuses = [s["status"] for s in strings]
    if "open_circuit" in statuses or "shorted" in statuses:
        status = "fault"
    elif "degraded" in statuses:
        status = "warning"
    else:
        status = "normal"

    return {
        "mpptId": mppt_id,
        "voltage_V": voltage,
        "current_A": current,
        "power_kW": power,
        "status": status,
        "strings": strings,
    }


def generate_inverter(inv_num):
    """Generate full inverter MPPT/string snapshot."""
    zone_name, zone_cfg = get_zone(inv_num)
    inv_id = f"SG50CX-{inv_num:02d}"

    mppts = []

    for mppt_idx in range(1, MPPT_COUNT + 1):
        mppt_id = f"MPPT-{mppt_idx}"
        strings = []

        # --- SG50CX-08: MPPT-3 STR-1 is open_circuit ---
        if inv_num == 8 and mppt_idx == 3:
            strings.append(generate_open_circuit_string("STR-1"))
            strings.append(generate_normal_string("STR-2", zone_cfg))

        # --- SG50CX-18: MPPT-4 and MPPT-5 degraded ---
        elif inv_num == 18 and mppt_idx in (4, 5):
            for str_idx in range(1, STRINGS_PER_MPPT + 1):
                str_id = f"STR-{str_idx}"
                # ~15% below nominal with some randomness
                reduction = random.uniform(0.12, 0.18)
                strings.append(
                    generate_degraded_string(str_id, zone_cfg, reduction_pct=reduction)
                )

        # --- Normal operation ---
        else:
            for str_idx in range(1, STRINGS_PER_MPPT + 1):
                str_id = f"STR-{str_idx}"
                strings.append(generate_normal_string(str_id, zone_cfg))

        mppts.append(build_mppt(mppt_id, strings))

    # Compute inverter summary
    total_power = round(sum(m["power_kW"] for m in mppts), 3)
    all_voltages = [
        m["voltage_V"] for m in mppts if m["voltage_V"] > 0
    ]
    avg_voltage = round(sum(all_voltages) / len(all_voltages), 1) if all_voltages else 0.0

    healthy = 0
    total = 0
    for m in mppts:
        for s in m["strings"]:
            total += 1
            if s["status"] == "normal":
                healthy += 1

    # Overall status
    mppt_statuses = [m["status"] for m in mppts]
    if "fault" in mppt_statuses:
        overall = "faulted"
    elif "warning" in mppt_statuses:
        overall = "degraded"
    else:
        overall = "healthy"

    return {
        "inverterId": inv_id,
        "groupId": zone_cfg["groupId"],
        "model": INVERTER_MODEL,
        "nominalPower_kW": NOMINAL_POWER_KW,
        "timestamp": TIMESTAMP,
        "mppts": mppts,
        "summary": {
            "totalPower_kW": total_power,
            "avgVoltage_V": avg_voltage,
            "healthyStrings": healthy,
            "totalStrings": total,
            "overallStatus": overall,
        },
    }


def main():
    inverters = {}
    for inv_num in range(1, 21):
        inv_id = f"SG50CX-{inv_num:02d}"
        inverters[inv_id] = generate_inverter(inv_num)

    plant_data = {
        "plantId": PLANT_ID,
        "generatedAt": TIMESTAMP,
        "inverterModel": INVERTER_MODEL,
        "mpptCount": MPPT_COUNT,
        "stringsPerMppt": STRINGS_PER_MPPT,
        "inverters": inverters,
    }

    out_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "public", "data", "digitaltwin", "theta",
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "mppt_string_data.json")

    with open(out_path, "w") as f:
        json.dump(plant_data, f, indent=2)

    # Print summary
    file_size = os.path.getsize(out_path)
    print(f"Generated: {out_path}")
    print(f"File size: {file_size:,} bytes ({file_size / 1024:.1f} KB)")
    print(f"Inverters: {len(inverters)}")

    for inv_id, inv in inverters.items():
        s = inv["summary"]
        status_marker = ""
        if s["overallStatus"] == "faulted":
            status_marker = " [FAULTED]"
        elif s["overallStatus"] == "degraded":
            status_marker = " [DEGRADED]"
        print(
            f"  {inv_id}: {s['totalPower_kW']:6.1f} kW | "
            f"{s['avgVoltage_V']:.1f}V | "
            f"{s['healthyStrings']}/{s['totalStrings']} healthy{status_marker}"
        )


if __name__ == "__main__":
    main()
