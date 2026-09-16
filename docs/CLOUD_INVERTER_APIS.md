# Cloud inverter APIs — reference & testing

How each inverter-manufacturer cloud API works, how to get access, whether a
free/sandbox test account exists, and how NuraVolt tests these integrations.

**TL;DR**
- **No MCP servers** exist for any mainstream inverter cloud (SolarEdge, Huawei,
  Sungrow, SMA, GoodWe). MCP is not a path here.
- **All vendors publish API docs.** Access is the hard part: SolarEdge / Huawei /
  Sungrow have **no public sandbox** — you need a real account you own/manage.
- **Genuinely free/self-serve:** Fronius Solar.web Query API (free demo tier),
  SMA (real sandbox, partner creds), Enode (aggregator, free tier), and the
  GoodWe SEMS *unofficial* endpoint (its public demo login is currently
  disabled — supply any real SEMS login instead).
- ⚠️ The SolarEdge demo key `L4QLVQ1LOKCQX2193VSEICXW61NP6B1O` copied all over the
  internet is a **doc placeholder — it does not authenticate.**

## Implementation status in this repo

| Vendor | Client | Status |
|---|---|---|
| SolarEdge | `src/lib/services/solaredge-api-service.ts` | ✅ implemented (test + discover + poll) |
| Huawei FusionSolar | `src/lib/services/huawei-api-service.ts` | ✅ implemented (discover + poll; `test` route is a stub) |
| Sungrow / SMA / Fronius / GoodWe | — | ❌ not implemented (`vendor-availability.ts` = coming_soon) |

Both implemented clients follow the `CloudVendorConnector` interface
(`src/lib/services/cloud-connector.ts`) and accept an injectable `fetchImpl`,
which is the seam our tests use.

## Per-vendor summary

| Vendor | Docs | Auth | Base URL | Free test account? | Rate limits | MCP |
|---|---|---|---|---|---|---|
| **SolarEdge** | [v1 PDF](https://knowledge-center.solaredge.com/sites/kc/files/se_monitoring_api.pdf), [v2](https://api-docs.solaredge.com/) | `api_key` query param (v1); `X-Account-Key`+`X-API-Key` (v2) | `monitoringapi.solaredge.com` | **No** — need an owned site's key | 300 req/day per site + per token, per IP | None |
| **Huawei FusionSolar** | [Northbound 25.x](https://support.huawei.com/enterprise/en/doc/EDOC1100520173/3055b7a9/api-reference) | `POST /login` (userName + systemCode) → XSRF token; or OAuth2 | `https://{region}.fusionsolar.huawei.com/thirdData/` | **No** — need installer + Northbound enabled | strict per-interface (err 407); single active session; ~30-min token | None |
| **Sungrow iSolarCloud** | [OpenAPI portal](https://developer-api.isolarcloud.com/) | appkey + `x-access-key`, or OAuth2 | `developer-api.isolarcloud.com` | **No** — NDA + partner approval | per-app | None |
| **SMA** | [developer.sma.de](https://developer.sma.de/sma-apis) | OAuth2 (code grant + custom back-channel) | `smaapis.de` (+ `sandbox.smaapis.de`) | **Sandbox exists**, but needs SMA-issued client creds | per-credential 5-min window (since 2025-07-01) | None |
| **Fronius Solar.web** | [Query API](https://www.fronius.com/en/solarweb-query-api), [Swagger](https://api.solarweb.com/swqapi/index.html) | `AccessKeyId` + `AccessKeyValue` headers | `api.solarweb.com/swqapi` | **Free demo tier** (example systems; free business-partner registration for the key) | pay-per-datapoint on paid tier | None |
| **GoodWe SEMS** | [official (partner)](https://community.goodwe.com/static/images/2024-08-20597794.pdf), unofficial | official: issued creds; unofficial: `CrossLogin` → token | `www.semsportal.com/api/` (unofficial) | Unofficial works with any SEMS login (public demo **disabled**) | unknown (unofficial) | local-only community MCP (UDP 8899), not cloud |
| **Fronius local Solar API** | [JSON API](https://www.fronius.com/en/help-center/solar-energy/products/monitoring-control/solutions/open-interfaces/fronius-solar-api-json-) | none (LAN) | device IP | Free, but needs hardware on the LAN | — | None |
| **Enode** (aggregator) | [developers.enode.com](https://developers.enode.com/) | OAuth | `enode.com` | **Free self-serve + sandbox** (20+ brands) | per-plan | None |

### Notes & gotchas
- **SolarEdge:** the docs' `L4QLV…` key and sample site IDs are placeholders. Get a
  real key from the monitoring portal (Admin → Site Access → Access Control). v1
  is JSON-only now (CSV/XML removed).
- **Huawei:** `systemCode` **is the password**, not a plant code. The base URL is
  **region-locked** — it must match your FusionSolar login domain (`intl`, `eu5`,
  `au5`, …). Only one active session per account; a new login invalidates the
  previous token. Max 10 NorthBound accounts per company.
- **GoodWe:** the widely-published public demo login (`demo@goodwe.com`) is
  currently **disabled** (`CrossLogin` → code 100029). The unofficial endpoint is
  reachable and the request format is correct — supply any real SEMS login to get
  data. Unsupported; may break without notice.

## Free / fast paths, ranked (with registration links)

1. **Enode** — now **fully self-serve, open to everyone**, with a real device
   **sandbox** that simulates 20+ inverter brands (no real account/hardware).
   Fastest real path today. Register: <https://developers.enode.com/>.
   Not yet wired into our test harness (no Enode connector) — register-and-explore
   or a future integration.
2. **Fronius Solar.web Query API demo** — free demo tier against Fronius's own
   example systems, BUT the API is **restricted to business partners** (all tiers,
   incl. demo), so it's two steps: (a) become a Fronius Solutions Partner —
   <https://fsp.fronius.com/registration> (~5 min with a Fronius account); then
   (b) get the demo key via the API access form (select country → download form →
   email it back) — <https://www.fronius.com/en/solarweb-query-api/api-access>.
   The cleanest *official* free live test in our harness (`FRONIUS_SWQAPI_*`).
3. **GoodWe SEMS (unofficial)** — zero-setup harness; works with any real SEMS
   login (public demo disabled). No registration needed if you already have a
   SEMS account.
4. **SMA sandbox** — a real sandbox, but SMA must issue OAuth client creds first.
   Register: <https://developer.sma.de/>.
5. **Enphase** — self-serve dev signup <https://developer-v4.enphase.com/signup>
   (free "Watt" plan, 1,000 hits/mo), but OAuth needs a real system owner's
   authorization; no synthetic sandbox. Not in our vendor list.
6. **SolarEdge / Huawei** — no dev-portal signup; you mint a key inside the vendor
   portal only if you own/manage a real system (SolarEdge: Admin → Site Access →
   Access Control; Huawei: installer account → Northbound Management). No sandbox.

## How we test these (this repo)

Three layers — see the plan `WS-J` and `automation/qa/README.md`:

- **Contract tests** — `tests/connectors/{huawei,solaredge}.test.ts` drive the real
  client classes through their `fetchImpl` seam against recorded response
  fixtures. Always green, no network/creds. Run: `npm run test:connectors` (also
  folded into `npm run test:api`). Cases live in
  `scripts/test_{huawei,solaredge}_connector.ts` (also runnable standalone via
  `npx tsx`).
- **Credential-gated live smoke tests** — `tests/integration/cloud-live.test.ts`
  does a real `authenticate → discover → poll` round-trip for SolarEdge + Huawei
  **when env creds are present**, and skips otherwise.
- **Free live probes** — `tests/integration/vendors/{goodwe-sems,fronius-swqapi}.test.ts`.

Live tests run **only** via `npm run test:live` (never default CI — external +
rate-limited). One round-trip per vendor; the GoodWe probe soft-skips on any error.

### Test env vars (mirror `.env.example`)

| Vendor | Env vars |
|---|---|
| SolarEdge | `SOLAREDGE_TEST_API_KEY` (+ `SOLAREDGE_TEST_SITE_ID`) |
| Huawei | `HUAWEI_TEST_USERNAME`, `HUAWEI_TEST_SYSTEM_CODE`, `HUAWEI_TEST_BASE_URL` |
| Fronius | `FRONIUS_SWQAPI_ACCESSKEY_ID`, `FRONIUS_SWQAPI_ACCESSKEY_VALUE` (+ `FRONIUS_SWQAPI_BASE_URL`) |
| GoodWe | `GOODWE_TEST_ACCOUNT`, `GOODWE_TEST_PWD` |

With none set, `npm run test:live` skips every live test (0 failures). Drop in a
vendor's keys to light up its round-trip.
