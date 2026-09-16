# Seed manuals for the NuraVolt Copilot knowledge base

This folder feeds `scripts/seed_manuals.ts`. Drop additional `.pdf` / `.md` /
`.txt` files in here, then `npm run seed:manuals` to upsert them into the
`KBDocument` table (org-wide, plant_id = null) and embed them via Bedrock
Titan v2.

The seed script is idempotent: it hashes each file and skips ones whose
hash hasn't changed. Failed/processing rows from earlier attempts are
healed (deleted) before retry so you can re-run safely after fixing
credentials.

## Prerequisites

- `DATABASE_URL` in `.env` — already required for the app.
- `AWS_BEARER_TOKEN_BEDROCK` and `AWS_REGION` in `.env`. The token must
  be valid for `amazon.titan-embed-text-v2:0`; expired tokens surface as
  `Authentication failed: Please make sure your API Key is valid.` Refresh
  the token (AWS console → Bedrock → API keys) and re-run.

## Overriding the target org

`npm run seed:manuals -- --org=org_abc123` writes against a different
Clerk org. Default: `demo_org_alpha1` (the demo/showcase org).

## OEM datasheets (`oem/`)

Real datasheets fetched from public OEM sites. Replace any of these with a
newer revision by overwriting the file — the next `seed:manuals` will re-embed.

| File | Equipment | Source | Retrieved |
|---|---|---|---|
| `SUN2000-215KTL-H3-datasheet.pdf` | Huawei SUN2000-215KTL-H3 string inverter (Helios) | https://solar.huawei.com/-/media/Solar/attachment/pdf/eu/datasheet/SUN2000-215KTL-H3.pdf | 2026-05-30 |
| `BYD-Battery-Box-Premium-HVS-HVM-datasheet.pdf` | BYD Battery-Box Premium HVS/HVM | https://www.bydbatterybox.com/uploads/downloads/230530_BYD_Battery-Box_Premium_HVS%26HVM_Datasheet_V1.7_EN-647eedf90f9c3.pdf | 2026-05-30 |
| `Tesla-Powerwall-3-datasheet.pdf` | Tesla Powerwall 3 | https://es-media-prod.s3.amazonaws.com/media/components/panels/spec-sheets/Tesla_Powerwall3_Data_Sheet.pdf | 2026-05-30 |
| `Trina-VertexN-NEG21C20-720W-datasheet.pdf` | Trina Vertex N TSM-NEG21C.20 695-720W bifacial dual-glass module | https://static.trinasolar.com/sites/default/files/Datasheet_VertexN_TSM-NEG21C.20_695-720W_2024_A.pdf | 2026-05-30 |

## Synthetic / NuraVolt-authored docs (`synthetic/`)

Operational documents written by us. Replace with the customer's own SOPs in
production deployments.

| File | Purpose |
|---|---|
| `soiling-cleaning-sop.md` | Generic cleaning SOP — when to clean, how to evaluate ROI, safety. |
| `huawei-sun2000-fault-codes.md` | Common SUN2000 fault codes + first-response actions. |
| `bess-warranty-and-degradation.md` | How NMC/LFP cells degrade, typical warranty bands. |
