# NuraVolt MCP Server

External AI assistants (Claude Desktop, ChatGPT Custom Connectors, Cursor,
Continue.dev, and any other MCP-aware client) can talk to NuraVolt over the
Model Context Protocol. The same tools that power the in-app Copilot are
exposed as MCP tools, plus two `nuravolt://…` resources for context that
doesn't need a tool call.

**Public marketing page:** [`/mcp`](https://nuravolt.com/mcp)
**Public setup guide:** [`/mcp/setup`](https://nuravolt.com/mcp/setup)
**Endpoint:** `https://nuravolt.com/api/mcp/mcp`
**Transport:** HTTP streaming (Streamable HTTP, current MCP spec)
**Auth:** Bearer token — `Authorization: Bearer nv_live_<token>`

---

## Architecture

- **Route:** `src/app/api/mcp/[transport]/route.ts` — one file, all tools + resources.
- **Framework:** [`mcp-handler`](https://www.npmjs.com/package/mcp-handler) (Vercel) on top of `@modelcontextprotocol/sdk`.
- **Auth flow:** `withMcpAuth` extracts the bearer, validates it against the `ApiKey` table (`src/lib/mcp/auth.ts`), builds a synthetic `ChatAccessContext` (`src/lib/mcp/access.ts`), and attaches org + scopes to `AuthInfo.extra`.
- **Guardrails:** every tool call runs through `guarded()` which enforces scope → rate limit → idempotency lookup → exec → audit. Same wrapper is used for resource reads.
- **Audit:** `McpToolCall` table (`src/lib/mcp/audit.ts`); rows carry duration, args, status, and — for writes — the id of the row that was created.

---

## Tools (12)

Source of truth: `src/app/mcp/_components/catalogue.ts`. If you register a new tool in `route.ts`, add it there so the landing page + setup page + this doc all stay in sync.

### Read tools

| Tool | Scope | Purpose |
|---|---|---|
| `nuravolt_list_plants` | `plants:read` | List plants this key can see. |
| `nuravolt_list_inverters` | `inverters:read` | List inverters at a plant. |
| `nuravolt_get_soiling_forecast` | `soiling:read` | 365-day soiling ratio forecast + cleaning recommendations. |
| `nuravolt_get_inverter_classification` | `faults:read` | Rule-based inverter diagnosis. |
| `nuravolt_diagnose_inverter` | `diagnosis:run` | Bedrock-backed 30-day digital-twin analysis. |
| `nuravolt_get_bess_revenue` | `bess:read` | Ancillary services + wholesale revenue breakdown. |
| `nuravolt_list_tickets` | `tickets:read` | Maintenance tickets with filters. |
| `nuravolt_search_knowledge_base` | `kb:read` | Semantic search over uploaded manuals. |

### Write tools

Every write tool requires an `idempotency_key` argument (any stable string per logical action). Retries return the original result; no duplicate rows.

| Tool | Scope | Purpose |
|---|---|---|
| `nuravolt_create_ticket` | `tickets:write` | Create a ticket (status NEW). |
| `nuravolt_update_ticket_status` | `tickets:write` | Transition status: NEW → VALIDATED → ASSIGNED → IN_PROGRESS → DONE (also → WONT_FIX). Writes `TicketHistory` row. |
| `nuravolt_comment_on_ticket` | `tickets:write` | Add a `TicketComment`. Attributed to `mcp_key_<id>` so the timeline shows the AI source. |
| `nuravolt_approve_cleaning_schedule` | `cleaning:write` | Persist a `CleaningSchedule` row with auto-computed ROI + payback. |

---

## Resources (2)

Attached to the assistant's context without spending a tool call.

- `nuravolt://plant/{slug}/overview.md` — plant metadata + open ticket count + latest soiling snapshot. Scope: `plants:read`.
- `nuravolt://kb/{documentId}` — full KB document body. Scope: `kb:read`.

Both are auditable via the same `McpToolCall` table (tool name = `resource:plant_overview` or `resource:kb_document`).

---

## Scopes (10)

Defined in `src/lib/mcp/scopes.ts`.

| Scope | Grants |
|---|---|
| `plants:read` | List and view plant metadata. |
| `inverters:read` | List and view inverters at a plant. |
| `soiling:read` | Query soiling forecasts and recovery windows. |
| `bess:read` | Query BESS revenue and ancillary services data. |
| `faults:read` | Deterministic rule-based fault classifier. |
| `tickets:read` | List and view maintenance tickets. |
| `kb:read` | Semantic search over uploaded knowledge base. |
| `diagnosis:run` | Run AI diagnosis on an inverter (paid inference). |
| `tickets:write` | Create tickets, transition status, add comments. |
| `cleaning:write` | Persist a cleaning schedule with ROI economics. |

**Presets:** Read-only = all `*:read` + `kb:read`. Full agent = read-only + `diagnosis:run` + `tickets:write` + `cleaning:write`.

---

## Authentication: API keys and OAuth

The transport accepts two bearer flavours (`src/lib/mcp/auth.ts`):

1. **API keys** (`nv_live_…` / `nv_test_…`) — org-wide service credentials
   minted at `/dashboard/settings/api-keys`. Access covers every plant in the
   org. Available on Growth and Enterprise plans.
2. **OAuth tokens** (Enterprise only) — the standard MCP connector flow.
   Clients discover the authorization server via
   `/.well-known/oauth-authorization-server` (RFC 8414), register dynamically
   (RFC 7591) and send the user through the normal `/sign-in` page plus a
   consent screen. Tokens are minted by the Better Auth MCP plugin
   (`src/lib/auth.ts`) and validated with `auth.api.getMcpSession`.

OAuth calls are **per-user**: plant access resolves through the caller's
`PlantAccess` ACL (same path as the in-app chat), not the org-wide grant API
keys get. Audit rows record `oauth:<userId>` as the credential id, so tool
calls are attributable to the human who authorized the connector. Tokens whose
consent only covered identity scopes get the read-only preset; write scopes
must be requested explicitly.

Endpoints (served by Better Auth under `/api/auth`):

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-authorization-server` | AS metadata (entry point for MCP clients) |
| `/.well-known/oauth-protected-resource` | Protected-resource metadata for 401 challenges |
| `/api/auth/mcp/authorize` | Authorization endpoint |
| `/api/auth/mcp/token` | Token endpoint |
| `/api/auth/mcp/register` | Dynamic client registration |

Non-Enterprise orgs attempting OAuth get a 403 `enterprise_plan_required`.

---

## Rate limits & idempotency

Both live in `src/lib/mcp/rate-limit.ts` and `src/lib/mcp/audit.ts`.

- **Rate limit** — 60 req/min and 5,000 req/day per key. In-memory token bucket for v1. Overflow returns a structured `rate_limited` error with `retry_after_sec`.
- **Idempotency** — `(api_key_id, tool_name, idempotency_key)` is a unique index on `McpToolCall`. A repeat call within this constraint returns the stored result with `idempotent_replay: true`.

---

## Install snippets

See `src/app/mcp/_components/snippets.ts` — same content, single source of truth for the landing page tabs, setup guide, and this doc.

### Claude Desktop
Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "nuravolt": {
      "url": "https://nuravolt.com/api/mcp/mcp",
      "headers": { "Authorization": "Bearer nv_live_YOUR_KEY_HERE" }
    }
  }
}
```

### ChatGPT (Custom Connector)
`Settings → Connectors → Custom connector`:
```
Name:           NuraVolt
Type:           MCP server
URL:            https://nuravolt.com/api/mcp/mcp
Authentication: Bearer token
Token:          nv_live_YOUR_KEY_HERE
```

### Cursor
Edit `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "nuravolt": {
      "url": "https://nuravolt.com/api/mcp/mcp",
      "headers": { "Authorization": "Bearer nv_live_YOUR_KEY_HERE" }
    }
  }
}
```

### Continue.dev
Edit `~/.continue/config.yaml`:
```yaml
mcpServers:
  - name: nuravolt
    url: https://nuravolt.com/api/mcp/mcp
    headers:
      Authorization: Bearer nv_live_YOUR_KEY_HERE
```

---

## Admin

- **Generate + revoke keys:** `/dashboard/settings/api-keys`
- **Audit log:** the "Recent tool calls" panel on the same page.
- **Programmatic:** `GET /api/mcp-keys`, `POST /api/mcp-keys`, `DELETE /api/mcp-keys/[id]`, `GET /api/mcp-keys/audit`.

## Smoke test

```bash
# List tools
curl -sS -X POST https://nuravolt.com/api/mcp/mcp \
  -H "Authorization: Bearer nv_live_<token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Call one
curl -sS -X POST https://nuravolt.com/api/mcp/mcp \
  -H "Authorization: Bearer nv_live_<token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"nuravolt_list_plants","arguments":{}}}'

# List resources
curl -sS -X POST https://nuravolt.com/api/mcp/mcp \
  -H "Authorization: Bearer nv_live_<token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"resources/templates/list"}'
```

## Roadmap

- **OAuth 2.1** — per-user tokens for marketplace listings (ChatGPT / Cursor).
- **Anthropic MCP directory** — public listing to boost discovery.
- **Additional tools** — `run_forecast`, `simulate_dispatch`, `resolve_ticket`.
