"""
Generate the MPPT/string snapshot fixtures for kilima-solar (demo org).

Outputs:
  public/data/digitaltwin/kilima-solar/mppt_string_data.json
  public/data/digitaltwin/kilima-solar/string_anomalies.json

Kilima has 24 inverters (INV-01..INV-24, 250 kW, 6 MPPT x 2 strings, matching
the seeded Inverter rows). The snapshot is a mid-morning moment (11:30 EAT)
and the anomalies line up with the seeded problem story:
  - INV-21 offline: all strings at 0 V / 0 A (inverter outage)
  - INV-17 derating: MPPT-4 and MPPT-5 strings ~15% below peers
  - INV-03 dirty: uniform mild current deficit across all strings
  - a few mild mismatch warnings sprinkled on otherwise healthy units

Deterministic (seeded RNG) so reseeds produce identical files.
"""

import json
import random
from datetime import date, timedelta
from pathlib import Path

random.seed(2026)

PLANT_ID = "kilima-solar"
TIMESTAMP = "2026-07-24T08:30:00Z"  # 11:30 EAT
INVERTER_MODEL = "Huawei SUN2000"
MPPT_COUNT = 6
STRINGS_PER_MPPT = 2
MODULE_COUNT = 28
NOMINAL_POWER_KW = 250.0

VOLTAGE_BASE = 732.0
VOLTAGE_SPREAD = 14.0
CURRENT_BASE = 12.4
CURRENT_SPREAD = 0.7

DEAD_INV = 21      # INV-21: offline for days
DERATE_INV = 17    # INV-17: derating, two weak MPPTs
DIRTY_INV = 3      # INV-03: soiled, uniform deficit
MILD_MISMATCH = {7: ("MPPT-2", "STR-1"), 14: ("MPPT-5", "STR-2")}

SNAPSHOT_DAY = date(2026, 7, 24)


def inv_id(n: int) -> str:
    return f"INV-{n:02d}"


def group_id(n: int) -> str:
    return "array-a" if n <= 8 else ("array-b" if n <= 16 else "array-c")


def make_string(string_id: str, scale: float = 1.0, status: str = "normal",
                degradation: float | None = None) -> dict:
    voltage = round(VOLTAGE_BASE + random.uniform(-VOLTAGE_SPREAD, VOLTAGE_SPREAD), 1)
    current = round((CURRENT_BASE + random.uniform(-CURRENT_SPREAD, CURRENT_SPREAD)) * scale, 2)
    if status == "open_circuit":
        voltage, current = 0.0, 0.0
    power = round(voltage * current / 1000.0, 3)
    return {
        "stringId": string_id,
        "moduleCount": MODULE_COUNT,
        "voltage_V": voltage,
        "current_A": current,
        "power_kW": power,
        "status": status,
        "degradation_pct": round(
            degradation if degradation is not None else random.uniform(0.3, 0.8), 2
        ),
    }


def build_mppt(mppt_id: str, strings: list[dict]) -> dict:
    voltages = [s["voltage_V"] for s in strings if s["voltage_V"] > 0]
    statuses = [s["status"] for s in strings]
    status = (
        "fault" if "open_circuit" in statuses
        else "warning" if "degraded" in statuses
        else "normal"
    )
    return {
        "mpptId": mppt_id,
        "voltage_V": round(sum(voltages) / len(voltages), 1) if voltages else 0.0,
        "current_A": round(sum(s["current_A"] for s in strings), 2),
        "power_kW": round(sum(s["power_kW"] for s in strings), 3),
        "status": status,
        "strings": strings,
    }


def build_inverter(n: int, anomalies: list[dict]) -> dict:
    iid = inv_id(n)
    mppts = []
    for m in range(1, MPPT_COUNT + 1):
        mppt_id = f"MPPT-{m}"
        strings = []
        for s in range(1, STRINGS_PER_MPPT + 1):
            sid = f"STR-{s}"
            if n == DEAD_INV:
                strings.append(make_string(sid, status="open_circuit"))
            elif n == DERATE_INV and m in (4, 5):
                reduction = random.uniform(0.13, 0.18)
                strings.append(
                    make_string(sid, scale=1 - reduction, status="degraded",
                                degradation=random.uniform(1.5, 2.6))
                )
                anomalies.append({
                    "inverterId": iid,
                    "mpptId": mppt_id,
                    "stringId": sid,
                    "type": "MISMATCH",
                    "severity": "warning",
                    "currentDrop_pct": round(reduction * 100, 1),
                    "detectedAt": str(SNAPSHOT_DAY - timedelta(days=random.randint(6, 12))),
                    "description": (
                        f"String current {reduction * 100:.1f}% below MPPT peer average, "
                        f"consistent with the inverter's derating trend"
                    ),
                })
            elif n == DIRTY_INV:
                deficit = random.uniform(0.05, 0.07)
                strings.append(make_string(sid, scale=1 - deficit))
            elif MILD_MISMATCH.get(n) == (mppt_id, sid):
                reduction = random.uniform(0.15, 0.19)
                strings.append(
                    make_string(sid, scale=1 - reduction, status="degraded",
                                degradation=random.uniform(1.2, 2.0))
                )
                anomalies.append({
                    "inverterId": iid,
                    "mpptId": mppt_id,
                    "stringId": sid,
                    "type": "MISMATCH",
                    "severity": "warning",
                    "currentDrop_pct": round(reduction * 100, 1),
                    "detectedAt": str(SNAPSHOT_DAY - timedelta(days=random.randint(3, 20))),
                    "description": (
                        f"String current {reduction * 100:.1f}% below MPPT peer average "
                        f"(possible partial shading or connector issue)"
                    ),
                })
            else:
                strings.append(make_string(sid))
        mppts.append(build_mppt(mppt_id, strings))

    if n == DEAD_INV:
        for m in range(1, MPPT_COUNT + 1):
            for s in range(1, STRINGS_PER_MPPT + 1):
                anomalies.append({
                    "inverterId": iid,
                    "mpptId": f"MPPT-{m}",
                    "stringId": f"STR-{s}",
                    "type": "OPEN_CIRCUIT",
                    "severity": "critical",
                    "currentDrop_pct": 100.0,
                    "detectedAt": str(SNAPSHOT_DAY - timedelta(days=3)),
                    "description": "No string current, inverter offline since the grid-side trip",
                })
    if n == DIRTY_INV:
        anomalies.append({
            "inverterId": iid,
            "mpptId": "MPPT-1",
            "stringId": "STR-1",
            "type": "DEGRADATION",
            "severity": "info",
            "currentDrop_pct": 6.0,
            "detectedAt": str(SNAPSHOT_DAY - timedelta(days=9)),
            "description": (
                "Slow uniform current decline across all strings, "
                "pattern matches soiling rather than a string fault"
            ),
        })

    total_power = round(sum(m["power_kW"] for m in mppts), 3)
    voltages = [m["voltage_V"] for m in mppts if m["voltage_V"] > 0]
    healthy = sum(1 for m in mppts for s in m["strings"] if s["status"] == "normal")
    total = MPPT_COUNT * STRINGS_PER_MPPT
    mppt_statuses = [m["status"] for m in mppts]
    overall = (
        "faulted" if "fault" in mppt_statuses
        else "degraded" if "warning" in mppt_statuses
        else "healthy"
    )
    return {
        "inverterId": iid,
        "groupId": group_id(n),
        "model": INVERTER_MODEL,
        "nominalPower_kW": NOMINAL_POWER_KW,
        "timestamp": TIMESTAMP,
        "mppts": mppts,
        "summary": {
            "totalPower_kW": total_power,
            "avgVoltage_V": round(sum(voltages) / len(voltages), 1) if voltages else 0.0,
            "healthyStrings": healthy,
            "totalStrings": total,
            "overallStatus": overall,
        },
    }


def main() -> None:
    anomalies: list[dict] = []
    inverters = {inv_id(n): build_inverter(n, anomalies) for n in range(1, 25)}

    out_dir = Path(__file__).resolve().parent.parent / "public" / "data" / "digitaltwin" / PLANT_ID
    out_dir.mkdir(parents=True, exist_ok=True)

    mppt_data = {
        "plantId": PLANT_ID,
        "generatedAt": TIMESTAMP,
        "inverterModel": INVERTER_MODEL,
        "mpptCount": MPPT_COUNT,
        "stringsPerMppt": STRINGS_PER_MPPT,
        "inverters": inverters,
    }
    (out_dir / "mppt_string_data.json").write_text(json.dumps(mppt_data, indent=2))

    total_strings = 24 * MPPT_COUNT * STRINGS_PER_MPPT
    affected = {(a["inverterId"], a["mpptId"], a["stringId"]) for a in anomalies}
    by_type: dict[str, int] = {}
    for a in anomalies:
        by_type[a["type"]] = by_type.get(a["type"], 0) + 1
    anomalies_data = {
        "plantId": PLANT_ID,
        "generatedAt": TIMESTAMP,
        "anomalies": anomalies,
        "summary": {
            "totalStrings": total_strings,
            "normalCount": total_strings - len(affected),
            "anomalyCount": len(affected),
            "byType": by_type,
        },
    }
    (out_dir / "string_anomalies.json").write_text(json.dumps(anomalies_data, indent=2))

    print(f"Wrote {out_dir / 'mppt_string_data.json'}")
    print(f"Wrote {out_dir / 'string_anomalies.json'}")
    print(f"Anomalies: {len(anomalies)} rows on {len(affected)} strings, byType={by_type}")
    for iid, inv in inverters.items():
        s = inv["summary"]
        if s["overallStatus"] != "healthy":
            print(f"  {iid}: {s['totalPower_kW']:.1f} kW, "
                  f"{s['healthyStrings']}/{s['totalStrings']} healthy, {s['overallStatus']}")


if __name__ == "__main__":
    main()
