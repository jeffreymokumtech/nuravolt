#!/usr/bin/env python3
"""Fetch the Sandia single-axis-tracker fault dataset, or say precisely why not.

WHY THIS IS NOT A ONE-LINER
---------------------------
DuraMAT has migrated hosts. ``datahub.duramat.org`` now 301s to
``datahub-duramat.nlr.gov``, and that host returns the same 1,042-byte
single-page-app shell for **every** path probed -- the CKAN API
(``/api/3/action/package_show``), plausible REST paths, and even its own
JavaScript bundle. There is no machine-readable endpoint reachable without a
browser session.

So this script tries the candidates that might still work, recognises the shell
when it sees it rather than writing it to disk as if it were data, and otherwise
prints exactly what a human needs to do. It exits 0 either way: a dataset we
cannot fetch is a known state, not a crash.

Why the dataset is worth the trouble: it is the only rig in reach whose physical
configuration is actually documented -- 2 strings x 6 x Canadian Solar
CS3U-355PB-AG, 4.26 kWp, Albuquerque, 5.5 months of real time series, CC0. Six
modules in series against Lazzaretti's eight is exactly the geometry difference
that ``scripts/validate_scale_transfer.py`` can only simulate.

Usage:
    python scripts/fetch_sandia_sat.py
"""

from __future__ import annotations

import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = REPO_ROOT / "backenddata" / "datasets" / "sandia_sat"

SLUG = "time-series-from-emulated-pv-single-axis-tracker-faults-data-and-resources"

CANDIDATES = [
    f"https://datahub-duramat.nlr.gov/api/3/action/package_show?id={SLUG}",
    f"https://datahub.duramat.org/api/3/action/package_show?id={SLUG}",
    f"https://datahub-duramat.nlr.gov/remote-1/api/3/action/package_show?id={SLUG}",
]

#: The migrated host answers every path with the same SPA shell. Anything at or
#: below this size that opens with markup is that shell, not a dataset.
SHELL_MAX_BYTES = 4096

PAGE = f"https://datahub.duramat.org/dataset/{SLUG}"


def _looks_like_the_spa_shell(body: bytes) -> bool:
    return len(body) <= SHELL_MAX_BYTES and body.lstrip()[:9].lower().startswith(b"<!doctype")


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    existing = sorted(OUT_DIR.glob("*.csv")) + sorted(OUT_DIR.glob("*.parquet"))
    if existing:
        print(f"already present: {len(existing)} file(s) in {OUT_DIR}")
        for f in existing[:8]:
            print(f"   {f.name}  {f.stat().st_size:,} B")
        return 0

    print("attempting automated fetch...")
    for url in CANDIDATES:
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                body = resp.read()
        except (urllib.error.URLError, OSError) as exc:
            print(f"   {url[:78]}... -> {exc.__class__.__name__}")
            continue
        if _looks_like_the_spa_shell(body):
            print(f"   {url[:78]}... -> SPA shell ({len(body)} B), not data")
            continue
        print(f"   {url[:78]}... -> {len(body):,} B, looks like real content")
        (OUT_DIR / "package_show.json").write_bytes(body)
        print(f"   saved to {OUT_DIR / 'package_show.json'}; inspect it for resource URLs")
        return 0

    print(
        "\nAutomated fetch is not possible from here. Every endpoint returns the\n"
        "single-page-app shell, so the resource URLs are only reachable from a\n"
        "browser session.\n"
        "\nManual steps:\n"
        f"  1. Open {PAGE}\n"
        "  2. Download the resource files (CSV bundle)\n"
        f"  3. Put them in {OUT_DIR}/\n"
        "  4. Re-run: python scripts/validate_sandia_sat.py\n"
        "\nUntil then scripts/validate_sandia_sat.py writes a pending_manual_fetch\n"
        "artifact rather than failing, and nothing downstream breaks.\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
