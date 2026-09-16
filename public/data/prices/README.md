# Iberian day-ahead price fixtures

Used by the BESS Hybrid Cockpit, Sandbox, and Curtailment-Recovery pages to
ground revenue and dispatch demos in real market prices.

## `omie_es_2025-2026.csv`

| Field | Unit | Notes |
|---|---|---|
| `time` | ISO 8601, Iberia local (wall clock, naive) | Hour-starting timestamp. |
| `eur_per_mwh_es` | €/MWh | Spanish MIBEL day-ahead marginal price (final published). |
| `eur_per_mwh_pt` | €/MWh | Portuguese MIBEL day-ahead marginal price (same auction). |

- Rows: 8,832 (≈ 368 days × 24h)
- Range: 2025-06-01 00:00 → 2026-06-03 23:00
- Stats: min −€2.10 / mean €60.44 / max €215.00 — 13.6% of hours below €5/MWh.

## Provenance

- Source: OMIE (Operador del Mercado Ibérico de Energía) public archive.
- Endpoint: `https://www.omie.es/es/file-download?parents=marginalpdbc&filename=marginalpdbc_YYYYMMDD.1`
- Retrieved: 2026-05-31.
- Each daily file contains 24 hourly rows (`MARGINALPDBC` header, then
  `YYYY;MM;DD;HH;ES;PT;`). Later files often include extra forecast days;
  the consolidation step deduplicates by `(date, hour)` keeping the
  last-seen value (= most recently published final price).

## Refresh

To re-fetch and rebuild (run from this directory):

```sh
mkdir -p _raw
python3 -c "
from datetime import date, timedelta
d, end = date(2025,6,1), date(2026,5,31)
while d <= end:
    print(d.strftime('%Y%m%d'))
    d += timedelta(days=1)
" | xargs -P 8 -I{} curl -sSL -A "Mozilla/5.0" -o "_raw/marginalpdbc_{}.1" \
    "https://www.omie.es/es/file-download?parents=marginalpdbc&filename=marginalpdbc_{}.1"
```

Then re-run the consolidation block in this folder's git history (or copy
it back from a prior commit). `_raw/` is intentionally not checked in.
