#!/usr/bin/env python3
"""Static leak-lint for the demo -> dashboard integration.

The /dashboard app reuses the /demo section components (the wrapper pages under
src/app/dashboard/plant/[plantId]/* re-export demo page bodies). Two failure
classes recur in that shared code, and both are catchable without a browser:

  1. A hardcoded /demo link (should be `${prefix}/...` via usePlantRoutePrefix).
     Production middleware rewrites /demo -> /not-found, so a leaked link
     dead-ends for a real org plant.
  2. A /data fixture fetch not gated behind `prefix === '/dashboard'` (or a DB
     fallback). Fixtures don't exist for real plants -> stray 404.

Precision matters: a demo-only component (never rendered under /dashboard) may
legitimately hardcode /demo. So this walks the IMPORT GRAPH from the dashboard
entry points and only inspects files actually reachable from /dashboard.

Exit code: 1 if any hard leak (category 1) is reachable, else 0. Category-2
hits are warnings (a nearby prefix guard can't be proven by grep).

    python scripts/check_dashboard_leaks.py [--verbose]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

DASHBOARD_ENTRY = SRC / "app" / "dashboard"

IMPORT_RE = re.compile(r"""(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]""")
DYNAMIC_IMPORT_RE = re.compile(r"""import\(\s*['"]([^'"]+)['"]""")

DEMO_LINK = re.compile(r"""['"`]/demo/(?:plant|portfolio)""")
DATA_FETCH = re.compile(r"""fetch\(\s*[`'"]?(?:\$\{dataRoot\}|/data/)""")

_EXTS = ("", ".tsx", ".ts", ".jsx", ".js")


def _resolve(spec: str, importer: Path) -> Path | None:
    """Resolve an import spec to a file under src/, or None for externals."""
    if spec.startswith("@/"):
        base = SRC / spec[2:]
    elif spec.startswith("."):
        base = (importer.parent / spec).resolve()
    else:
        return None  # bare package -> node_modules, not ours
    for ext in _EXTS:
        cand = Path(str(base) + ext)
        if cand.is_file():
            return cand
        idx = base / f"index{ext}" if ext else None
        if idx and idx.is_file():
            return idx
    return None


def reachable_from_dashboard() -> set[Path]:
    """BFS the import graph starting from every dashboard page/layout."""
    seen: set[Path] = set()
    queue = [p for p in DASHBOARD_ENTRY.rglob("*.tsx")] + [p for p in DASHBOARD_ENTRY.rglob("*.ts")]
    for p in queue:
        seen.add(p)
    i = 0
    while i < len(queue):
        f = queue[i]
        i += 1
        try:
            src = f.read_text(encoding="utf-8")
        except Exception:  # noqa: BLE001
            continue
        for m in list(IMPORT_RE.finditer(src)) + list(DYNAMIC_IMPORT_RE.finditer(src)):
            target = _resolve(m.group(1), f)
            if target and target not in seen and str(target).startswith(str(SRC)):
                seen.add(target)
                queue.append(target)
    return seen


def main() -> int:
    verbose = "--verbose" in sys.argv
    reachable = reachable_from_dashboard()

    hard: list[str] = []
    warn: list[str] = []
    for f in sorted(reachable):
        rel = f.relative_to(ROOT)
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith(("//", "*", "/*")):
                continue  # comment / docstring line, not real code
            if DEMO_LINK.search(line):
                hard.append(f"{rel}:{n}: hardcoded /demo link -> use ${{prefix}}: {stripped[:100]}")
            if DATA_FETCH.search(line):
                warn.append(f"{rel}:{n}: fixture fetch (verify /dashboard-gated): {stripped[:100]}")

    print(f"scanned {len(reachable)} files reachable from /dashboard")
    if hard:
        print(f"\n❌ {len(hard)} hardcoded /demo link(s) reachable from /dashboard:")
        for h in hard:
            print(f"   {h}")
    else:
        print("✅ no hardcoded /demo links reachable from /dashboard")

    if warn:
        print(f"\nℹ️  {len(warn)} reachable fixture fetch(es) — each must be prefix-gated or DB-backed:")
        for w in (warn if verbose else warn[:20]):
            print(f"   {w}")
        if not verbose and len(warn) > 20:
            print(f"   … +{len(warn) - 20} more (run with --verbose)")

    return 1 if hard else 0


if __name__ == "__main__":
    raise SystemExit(main())
