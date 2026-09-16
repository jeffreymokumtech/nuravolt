# LLM & AI Usage in ShamsIQ

Last reviewed: 2026-09-16

> Quick context: this doc covers every LLM call in the codebase. Entry point for the whole system is **`docs/ARCHITECTURE.md`**; the model/dataset map is **`docs/PROJECT_MAP.md`**.

> **Provider switch (2026-06-30):** all Bedrock call sites now default to **Qwen `qwen.qwen3-next-80b-a3b`** (eu-west-1). Mentions of "Claude Haiku 4.5" below describe the previous default and the prompt/parsing design, which is provider-agnostic via `isAnthropic()` in `bedrock.ts`. Claude on Bedrock stays unavailable until the Anthropic use-case form is submitted in the console.

This document is the single reference for every LLM call in the ShamsIQ codebase: which provider runs each call, what data the model can see, what tools it can invoke, how access is gated, and where the code lives. Read this before changing any AI-touching code.

---

## 1. Quick map

| Surface | Path | Provider | Model | Streaming | Tools | Persisted |
|---|---|---|---|---|---|---|
| **Copilot chat** | `/chat` + `/api/chat` | AWS Bedrock | `qwen.qwen3-next-80b-a3b` | yes (SSE) | yes (28) | yes (Conversation, ChatMessage, LLMInteraction) |
| **Copilot rail** | embedded in `/demo/*` and `/showcase/*` | (reuses `/api/chat`) | `qwen.qwen3-next-80b-a3b` | yes | yes (28) | yes (same path as `/chat`) |
| **Page briefings** | `/api/chat/briefing` | AWS Bedrock | `claude-haiku-4-5` (single shot) | no | n/a | no (client-side localStorage cache) |
| **KB embeddings** | `/api/chat/kb/upload` | AWS Bedrock | `amazon.titan-embed-text-v2:0` (1024 dim) | no | n/a | yes (KBDocument, KBChunk + pgvector) |
| Plant insights card | `/api/llm/insights` | AWS Bedrock | `claude-haiku-4-5` | no | no | no (planned) |
| Alert interpretation | `/api/llm/interpret-alert` | AWS Bedrock (LLM) → rule-based fallback | `claude-haiku-4-5` | no | no | yes (AlertInterpretation, LLMInteraction) |
| Inverter diagnosis | `/api/ai/inverter-diagnosis/[plantId]/[inverterId]` | AWS Bedrock | `claude-haiku-4-5` | no | no | no (returned to caller) |
| LLM cost / usage view | `/api/llm/usage` | n/a (read-only) | n/a | n/a | n/a | n/a |
| **Decommissioned** | LangChain + Ollama | local `llama3.2` | — | — | — | — |
| **Decommissioned (zero callers)** | OpenRouter + Llama 3.3 (`src/libs/gpt.ts`) | OpenRouter | `meta-llama/llama-3.3-70b-instruct:free` | — | — | — |

There is exactly **one live model family** (Qwen 3 Next 80B on AWS Bedrock) and **one provider** (AWS Bedrock) in the running web app. The Python agent service (§14) adds a second runtime that can also use any OpenAI-compatible endpoint.

---

## 2. The Bedrock connector

### File: `src/lib/ai/bedrock.ts`
Low-level wrapper around the AWS Bedrock Runtime SDK. Used by every LLM endpoint *except* `/api/chat` (which uses the AI SDK). Exports:

- `invokeBedrock(userPrompt, opts)` — synchronous (non-streaming) request to Claude on Bedrock. Auto-detects Anthropic vs. OpenAI-compatible body shape based on the model id, so the same wrapper works if `BEDROCK_MODEL_ID` is swapped to DeepSeek, Mistral, Nova, or Qwen. The chat path always uses Anthropic.
- `extractJson<T>(text)` — defensively parses JSON out of an LLM response (strips code fences, finds first `{` to last `}`). Used everywhere that expects structured output.

### File: `src/lib/ai/bedrock-provider.ts`
Higher-level wrapper for the **Vercel AI SDK** path used by the Copilot chat. Exports:

- `bedrock` — `createAmazonBedrock({ region })` instance.
- `chatModel` — bound `bedrock(CHAT_MODEL_ID)` ready to pass to `streamText({ model })`.
- `CHAT_MODEL_ID` — resolves from `BEDROCK_MODEL_ID` env, defaults to `eu.anthropic.claude-haiku-4-5-20251001-v1:0`.

### Authentication
- **Primary:** `AWS_BEARER_TOKEN_BEDROCK` (the AWS SDK v3 picks this up automatically).
- **Fallback:** standard AWS credentials chain (env, profile, IAM role) if the bearer token is not set.
- Region: `AWS_REGION` (defaults to `eu-west-1`).

### Pricing assumptions
Hard-coded in `src/lib/ai/chat-persistence.ts`:
- Input: `$0.001 / 1K tokens`
- Output: `$0.005 / 1K tokens`

Update both constants when AWS publishes new Haiku 4.5 rates.

---

## 3. Copilot chat — `/chat`

The unified chat is the only multi-turn, streaming, tool-using surface in the app.

### 3.1 Request flow
```
ChatPanel (useChat from @ai-sdk/react)
   │
   └──POST /api/chat  (DefaultChatTransport, body = { messages, plantId, conversationId })
        │
        ├── auth() resolves Clerk userId/orgId (dev fallback: demo_user/demo_org_alpha1)
        ├── getChatAccessContext(userId, orgId) → set of UUIDs/slugs the user may reference
        ├── ensureConversation(...) → Conversation row (best-effort; survives if migration pending)
        ├── buildChatTools(access, origin) → ToolSet (zod-typed, ACL-checked)
        ├── streamText({ model: chatModel, system, messages, tools, stopWhen: stepCountIs(8) })
        └── result.toUIMessageStreamResponse({ originalMessages, onFinish })
                                                    │
                                                    └── onFinish: persistChatTurn(...)
                                                          ├── insert one LLMInteraction (CHAT, BEDROCK_ANTHROPIC, CLAUDE_HAIKU_4_5)
                                                          ├── insert one ChatMessage per emitted message (USER + ASSISTANT/TOOL)
                                                          └── auto-title conversation if first turn
```

### 3.2 Files
| File | Role |
|---|---|
| `src/app/chat/layout.tsx` | Two-pane layout with `ConversationSidebar`. |
| `src/app/chat/page.tsx` | New-conversation entrypoint. |
| `src/app/chat/[conversationId]/page.tsx` | Hydrates `initialMessages` from Prisma server-side. |
| `src/components/chat/ChatPanel.tsx` | Client component; wires `useChat` + transport. |
| `src/components/chat/MessageList.tsx` | Empty state, scroll, "Thinking…" placeholder. |
| `src/components/chat/Message.tsx` | Renders `parts[]` — text, tool-* invocations, reasoning ignored. |
| `src/components/chat/ToolCallCard.tsx` | Collapsible card showing tool name + input + output. |
| `src/components/chat/MessageInput.tsx` | Auto-grow textarea, ⌘+Enter to send, Stop button mid-stream. |
| `src/components/chat/ConversationSidebar.tsx` | Pinned + recent list, "New chat" creates a Conversation. |
| `src/app/api/chat/route.ts` | Streaming POST endpoint. |
| `src/app/api/chat/conversations/route.ts` | `GET` list, `POST` create. |
| `src/app/api/chat/conversations/[id]/route.ts` | `GET` history, `PATCH` rename/pin, `DELETE` (soft archive). |
| `src/lib/ai/bedrock-provider.ts` | AI SDK provider. |
| `src/lib/ai/chat-system-prompt.ts` | System prompt builder + version tag. |
| `src/lib/ai/access-control.ts` | `PlantAccess` ACL → `allowedPlantIds`. |
| `src/lib/ai/chat-tools.ts` | The four tools the LLM can call. |
| `src/lib/ai/chat-persistence.ts` | `ensureConversation`, `persistChatTurn`, cost estimator. |

### 3.3 Tools the LLM gets

All tools are typed with `zod`, registered via `tool({ description, inputSchema, execute })` from the Vercel AI SDK, and capped at `stepCountIs(8)` per turn (28 tools across `chat-tools.ts`, `chat-tools-reports.ts` and `chat-tools-contracts.ts`; 17 read, 7 draft/propose, 4 immediate report writes). Every tool that takes a `plantId` validates it against `allowedPlantIds` (UUID *or* slug) **before any DB call**. On denial it returns `{ error: 'access_denied', detail }` — the system prompt instructs the model to apologise and stop.

| Tool | Inputs | Data accessed | Backed by |
|---|---|---|---|
| **`listPlants`** | `assetType?: 'PV' \| 'BESS' \| 'WIND' \| 'HYBRID'` | The user's accessible plants (id, slug, name, asset_type, status, capacity_mw, location, country) | `getChatAccessContext()` cache (a single `prisma.plantAccess.findMany` per request, joined to `Plant`). |
| **`getSoilingForecast`** | `plantId`, `days` (1-365, default 30), `includeWeather` | Daily soiling-ratio predictions (predicted, lower/upper, loss_pct), cleaning recommendations, and (optional) 7-day Open-Meteo rain forecast adjustments | Internal HTTP call to `GET /api/soiling/plants/[plantId]/forecast`, which reads from static JSON (prod) or TimescaleDB via `src/lib/db/timeseries.ts` (**dev-only — Timescale is local docker, being retired**; see `ARCHITECTURE.md` §3). |
| **`listTickets`** | `plantId?`, `status?[]`, `priority?[]`, `limit` (≤50) | Open tickets (`Ticket` table) — id, title, status, priority, trigger, plant_id, inverter_id, assignee, revenue impact, created_at | `prisma.ticket.findMany({ where: { org_clerk_id, plant_id ∈ allowedPlantUuids } })`. |
| **`getInverterDiagnosis`** | `plantId`, `inverterId` | 30-day digital-twin metrics for one inverter, then runs an LLM diagnosis citing Huawei SUN2000 fault codes | Internal `POST /api/ai/inverter-diagnosis/[plantId]/[inverterId]`. That route itself calls Bedrock Claude — so this tool fans out one nested LLM call when used. |
| **`searchKnowledgeBase`** | `query`, `plantId?`, `limit` (≤10) | Top-N most-similar passages from the org's uploaded manuals/datasheets/runbooks, with cosine similarity score | `searchKB()` in `src/lib/ai/kb-search.ts` — embeds the query via Titan v2, runs `embedding <=> $1::vector` against `KBChunk` (pgvector), filtered by `org_clerk_id` (and `plant_id` if provided, with org-wide docs always included). |
| **`proposeTicket`** | `plantId`, `inverterId?`, `title`, `description`, `priority`, `trigger_type`, optional impact numbers | NONE — does not write to DB. Returns `{ kind: 'ticket_draft', draft: {...} }` which the chat UI renders as `<DraftTicketCard>` with editable fields. User must click "Create" in the card to persist. | Tool-only output. Confirmation flows through `POST /api/tickets`. |
| **`proposeCleaningSchedule`** | `plantId`, `dates[]` (YYYY-MM-DD), `rationale` | NONE — does not write. Renders `<DraftScheduleCard>` with the date list and rationale; "Copy dates" sends them to the clipboard for paste into the planner. | Tool-only output. |

The five read-only tools (`listPlants`, `getSoilingForecast`, `listTickets`, `getInverterDiagnosis`, `searchKnowledgeBase`) plus the two **draft-only** write tools (`proposeTicket`, `proposeCleaningSchedule`) make seven total. The model is forbidden by system prompt v3 from asserting that any draft has been persisted.

### 3.4.1 Knowledge base / RAG details

- **Embeddings:** AWS Bedrock `amazon.titan-embed-text-v2:0`, 1024 dimensions, cosine-normalised. Wrapper: `src/lib/ai/embeddings.ts`.
- **Storage:** Postgres + pgvector 0.8 extension. The `KBChunk.embedding` column is `vector(1024)`. ANN index: `ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`. (Drop and rebuild the index once you have >1K chunks for better recall.)
- **Schema additions in DB (not in Prisma — pgvector type isn't directly supported):** see `prisma/manual_sql/2026_05_05_kb_pgvector.sql`. Re-runnable.
- **Ingestion pipeline:** `src/lib/ai/kb-ingest.ts` — `parseFile(buffer, ext)` for `.txt`/`.md`/`.pdf` (PDF via `pdf-parse`), `chunkText()` paragraph-aware with ~1000-char target + 200-char overlap, then per-chunk Titan embed + raw-SQL insert (Prisma can't bind `vector(N)` natively).
- **Deduplication:** `KBDocument` is keyed by `(org_clerk_id, file_hash)` where file_hash is SHA-256 of the raw bytes. Re-uploading the same file returns the existing document with `duplicate: true`.
- **Access control:** every read goes via `org_clerk_id`; the chat tool further validates any `plantId` against the user's `PlantAccess` set.
- **System-prompt nudge:** the prompt instructs the LLM to call `searchKnowledgeBase` *before* answering anything about specs/fault codes/OEM procedures and to cite `document_title` + `chunk_index` when results have similarity ≥ 0.4.

### 3.4.2 Copilot rail (dashboard integration)

The same `<ChatPanel>` is embedded in a persistent right-rail across the dashboard:

- **Provider:** `<CopilotProvider>` wraps `/demo/*` and `/showcase/*` layouts. State (open/closed, width, page context, `seedNextMessage`, `onlyThisAsset` toggle) lives there. Open + width persisted in `localStorage` keys `copilot_rail_open`, `copilot_rail_width`. Conversation id persisted under `copilot_rail_conversation_id` so the same thread survives reloads.
- **Rail:** `<CopilotRail>` renders fixed-position on `lg+`, with `document.body.style.paddingRight` adjusted so dashboard content isn't clipped. On smaller viewports it's a slide-over with a backdrop. Closed state: a floating "💬 Copilot" launcher in the bottom-right. Keyboard: `⌘.` toggles.
- **Page context:** Each dashboard page calls `usePageContext({ plantId, inverterId, range })` in `useEffect`. The rail's `<AssetContextChip>` shows the current scope. The chat request body includes the same fields, the system prompt names them under "Active page context", and tools default plant-scoped queries to them.
- **Page briefings:** `<BriefingStrip>` calls `POST /api/chat/briefing` whenever `pageContext.plantId` (and optionally `inverterId`) changes. Per-asset 30-min `localStorage` cache (`copilot_briefing:{plantId}:{inverterId}`). Bullets are click-to-seed: clicking one prefills `"Tell me more about: {bullet}"` in the input. The briefing prompt forbids fabricating numeric values when the data we passed to the LLM is sparse.
- **Inline `<AskAIButton>`:** A reusable component that drops onto any data surface. Two variants: `pill` (default) and `icon`. On click, calls `seedNextMessage(text, contextOverride)` which opens the rail and prefills the input — the user reviews and presses Send. Mounted on:
  - `TwinTimelineChart` (top-right pill, seeds with metric/range/inverterId).
  - Each ticket card in the kanban (icon button, seeds with ticket id/title/priority/trigger and asks for KB-backed root-cause analysis).
  - Cleaning schedule section header pill.
- **Showcase / demo bypass:** `getChatAccessContext()` grants the dev fallback user (`demo_user`) read access to every `Plant` row, since `/demo` and `/showcase` are intentionally browseable without per-user grants. Real Clerk users still go through `PlantAccess`.

### 3.4.3 Draft + confirm write actions

The Copilot has two write-flavoured tools that **never write**:

- **`proposeTicket`** — execute returns `{ kind: 'ticket_draft', draft: {...} }`. `Message.tsx` branches on `part.type === 'tool-proposeTicket'` with `state === 'output-available'` and renders `<DraftTicketCard>`: an editable inline form (title / description / priority / trigger). Clicking "Create" POSTs to `/api/tickets` (the same endpoint used by the manual ticket-creation flow). Toast on success, ticket id displayed inline. ACL still enforced — the tool calls `resolvePlantOrDeny` before producing a draft.
- **`proposeCleaningSchedule`** — renders `<DraftScheduleCard>` with the proposed dates as editable rows and a rationale paragraph. "Copy dates" puts them on the clipboard for paste into `InteractiveCleaningSchedule`. (Future: a one-click "Apply to planner" that POSTs to a cleaning-schedule endpoint.)
- **System prompt v3** explicitly tells the LLM to use the `propose*` tools for any "create a ticket / schedule cleaning" intent and to never claim that anything has been persisted until the user confirms.

A pre-existing bug in `POST /api/tickets` was fixed during this work: it validated `body.plant_id` against `DiscoveredPlant` but `Ticket.plant_id` is actually a foreign key to `Plant`. Now checks both.

### 3.4.4 Knowledge-base UX

- Drawer component: `src/components/chat/KnowledgeBaseDrawer.tsx`. Opens from the "📚 Knowledge base" button in `ChatHeader` (top-right of the chat pane).
- Upload: click or select multiple files at once. Accepts `.txt`, `.md`, `.pdf`. Max 25 MB per file. Per-document status pill: `pending / processing / completed / failed` with the failure reason inline.
- Document list: title, filename, size, chunk count, status. Trash icon deletes the document and cascades chunks (DB-level `ON DELETE CASCADE`).

### 3.4 System prompt

Built per-request by `buildChatSystemPrompt(...)` in `src/lib/ai/chat-system-prompt.ts`. Version tag: `v1` (recorded as `Conversation.system_prompt_version` and emitted in stream metadata).

```
You are ShamsIQ Copilot, an AI assistant for solar PV plant operations and maintenance.

Domain knowledge:
- Solar PV plants, inverters (often Huawei SUN2000), trackers, modules.
- Soiling ratio (SR) is dimensionless 0-1; SR=0.95 means 5% production loss to soiling.
- Tickets workflow: NEW -> VALIDATED -> ASSIGNED -> IN_PROGRESS -> DONE.
- Digital twin: predicted vs actual; positive residual on power means underperformance.

Behavior:
- Use tools whenever the user asks about specific plants, tickets, forecasts, or inverters. Never invent plant IDs or numeric values.
- If a tool returns { error: "access_denied" }, tell the user they do not have access to that plant and stop. Do not retry with a different id.
- Be concise. Prefer short bullet lists and numeric specifics over hedged prose.
- When suggesting an action, offer to draft a ticket title and description.
- Never claim real-time data freshness; cite the timestamp the tool returned.

Today: {todayIso}.
Organization: {orgId}.        // appended when present
User has access to {N} plants. // appended when present
Active plant context: {plantId}. Default plant-scoped tool calls to this id ... // appended when a plantId is in scope
```

Temperature is fixed at `0.2`. No top-p override. No reasoning mode.

### 3.5 Persistence schema

Three tables are touched per chat turn (all in `prisma/schema.prisma`):

```prisma
model Conversation {
  id, org_clerk_id, user_clerk_id, title, pinned, archived,
  plant_id, system_prompt_version, created_at, updated_at
  messages: ChatMessage[]
}

enum ChatRole { USER ASSISTANT TOOL SYSTEM }

model ChatMessage {
  id, conversation_id, role, content, parts (Json — full UI-message parts),
  tool_name, tool_call_id, llm_interaction_id (FK-by-id),
  input_tokens, output_tokens, finish_reason, error, created_at
}

model LLMInteraction {  // pre-existing, extended
  provider: BEDROCK_ANTHROPIC,
  model: CLAUDE_HAIKU_4_5,
  interaction_type: CHAT,
  input_tokens, output_tokens, cost_usd, latency_ms,
  org_clerk_id, user_clerk_id, plant_id, success
}
```

Migration name when you run it: `add_chat_models`. Run with `npm run migrate-db` (then update the migration name in `package.json#scripts.migrate-db` if needed). The chat code is **defensive**: missing tables produce a `console.warn` and the chat still works in-memory.

### 3.6 Access control

Source of truth: the `PlantAccess` table.
- A user may chat with the LLM in any org they're a member of (`auth()` from `@clerk/nextjs/server`).
- `getChatAccessContext(userId, orgId)` runs one query: `prisma.plantAccess.findMany({ where: { user_clerk_id, org_clerk_id, OR: [{ expires_at: null }, { expires_at: { gt: now } }] } })` — this excludes expired grants.
- The result is held in a `Set<string>` containing both UUIDs and slugs. Tools resolve either by passing through `resolvePlantOrDeny`.
- The system prompt names the count, so the LLM knows how many plants are visible without requiring a tool call.
- Tools never trust the model's argument: the same context object is reused across all tool calls in a single turn.

### 3.7 Dev mode

`src/middleware.ts` bypasses Clerk in development to avoid the JWT header overflow that requires the custom `server.js`. The chat route falls back to `userId = demo_user`, `orgId = demo_org_alpha1` (matching the convention in `src/app/api/tickets/route.ts`). Production must enable the commented-out `clerkMiddleware` block in `src/middleware.ts:32-56`.

---

## 4. Plant insights card — `/api/llm/insights`

Single-turn, non-streaming endpoint used by the dashboard plant card.

- **File:** `src/app/api/llm/insights/route.ts`
- **Caller:** `src/components/ai/AiInsightsCard.tsx`
- **Provider:** AWS Bedrock + Claude Haiku 4.5 (was LangChain + Ollama on `localhost:11434` — replaced 2026-05-05).
- **Input:** `{ plantId, plantData }` — the dashboard hands over the JSON it already has on screen (capacity, fleet soiling, losses, health distribution, economic impact). No DB lookup happens server-side.
- **System prompt:** `"You are a senior solar PV plant analyst. Be concise, technical, and never invent values that are not in the provided data."`
- **User prompt:** dashes-and-bullets template asking for performance / risks / recommended actions in <200 words. Cites the exact `plantData` JSON.
- **Output:** plain text bullets, returned as `{ insights, model: 'claude-haiku-4-5 (Bedrock)', latency_ms, plant_id }`.
- **No persistence** — neither a `ChatMessage` nor an `LLMInteraction` row is written for this call. (Adding LLMInteraction logging here is a 5-line follow-up.)

The card label was updated from `"Llama 3.2 (Ollama)"` and `"via OpenRouter"` to `"Claude Haiku 4.5"` and `"via AWS Bedrock"` respectively.

---

## 5. Alert interpretation — `/api/llm/interpret-alert`

ML-anomaly-output → human-readable explanation. LLM with rule-based fallback.

- **File:** `src/app/api/llm/interpret-alert/route.ts`
- **Cache:** `AlertInterpretation` Prisma table, keyed by MD5 hash of the SHAP feature vector + severity + score. 24-hour TTL. Cache hit → return immediately, no LLM call.
- **LLM path (`generateLLMInterpretation`):**
  - System: *"You are a senior solar PV reliability engineer. You interpret ML anomaly alerts for operations teams. Be concise, technical, and never invent component IDs or numeric values."*
  - User prompt encodes: component id + type, severity, anomaly score, expected vs actual, trend, top-5 SHAP contributions, top-3 historical matches.
  - Asks for strict JSON `{ summary, explanation, likely_cause, recommended_action, urgency, confidence }`.
  - Bedrock token usage is **not** returned by `InvokeModelCommand` on the non-streaming path, so we approximate: `inputTokens = ⌈prompt.length / 4⌉`, same for output. Cost is computed against the same Haiku 4.5 rates as chat.
- **Fallback (`generateFallbackInterpretation`):** rule-based — `severity → urgency` mapping, top-feature → likely-cause keyword table (DC voltage → cable, temperature → thermal stress, etc.), confidence threshold split. Marks `used_fallback: true` and logs as `provider: MOCK`, `model: GPT_4O_MINI` (legacy enum value, retained to not invalidate historical rows).
- **`LLMInteraction` row:** logged either way, with `provider = BEDROCK_ANTHROPIC` (success) or `MOCK` (fallback) and the matching model enum.

---

## 6. Inverter diagnosis — `/api/ai/inverter-diagnosis/[plantId]/[inverterId]`

The most domain-specific LLM call. Available standalone *and* fanned out from the chat's `getInverterDiagnosis` tool.

- **File:** `src/app/api/ai/inverter-diagnosis/[plantId]/[inverterId]/route.ts`
- **Provider:** AWS Bedrock + Claude Haiku 4.5 via `invokeBedrock`.
- **Data accessed:** 30-day digital-twin metrics (`power_ac`, `temperature`, `voltage_dc`, `current_dc`) — predicted vs actual residuals + loss percentages — pulled via `getTwinStats(plantUuid, inverterId, metric, fromDate, toDate)` (backed by TimescaleDB **in dev only** — Timescale is local docker, being retired; see `ARCHITECTURE.md` §3). Falls back to "all available history" if the rolling 30-day window is empty.
- **Manual reference:** loaded from a JSON file (Huawei SUN2000-60KTL-M0 spec, top 21 fault codes, common diagnostic patterns).
- **System prompt:** `"You are an expert solar PV inverter diagnostics engineer. You interpret digital twin data (predicted vs actual) and map symptoms to Huawei SUN2000 fault codes. You output strict JSON only."`
- **User prompt:** model spec block + twin metrics summary + fault-code table + common patterns + heuristics ("Power loss > 5% with normal temp → likely soiling…") + strict JSON schema demand.
- **Output JSON:** `{ summary, severity ∈ {normal, investigate, urgent}, actions[] (whitelisted), fault_hypothesis: {code, name, confidence} | null, reasoning }`. Response actions are filtered against `VALID_ACTIONS` before returning.
- **Persistence:** none — caller persists if it cares.

---

## 7. Decommissioned LangChain + Ollama setup

This is no longer wired up but the code/deps still exist. Documented here so anyone digging the git history understands what was there.

### What it was
- **Package deps still in `package.json`:** `@langchain/core@^1.1.39`, `@langchain/openai@^0.3.17`, `langchain@^0.3.37`. **Zero callers** in `src/` and `scripts/` as of 2026-05-05. Safe to drop with `npm uninstall langchain @langchain/core @langchain/openai` once any team-member side-branches confirm they don't depend on them.
- **Original file (now rewritten):** `src/app/api/llm/insights/route.ts` previously did:
  ```ts
  import { ChatOpenAI } from '@langchain/openai';
  import { HumanMessage } from '@langchain/core/messages';

  const model = new ChatOpenAI({
    modelName: 'llama3.2',
    openAIApiKey: 'ollama',
    configuration: { baseURL: 'http://localhost:11434/v1' },
    temperature: 0.3,
    maxTokens: 500,
  });
  const response = await model.invoke([new HumanMessage(prompt)]);
  ```
- **Original system prompt:** *"You are an expert solar PV plant analyst. Analyze this solar plant data for {plantId}: {JSON} Provide 3-4 key insights about: 1. Key performance observations 2. Potential issues or risks 3. Recommended actions. Keep your response under 200 words. Use bullet points."* (Note: this was passed as a `HumanMessage`, not a real system message — LangChain's `ChatOpenAI` then forwarded it to Ollama's OpenAI-compatible API.)
- **Why it was removed:** Ollama's `localhost:11434` is unreachable from the production Next.js process; the card was effectively dead in any deployment. LangChain's value-add (model routing, tool wiring, RAG glue) is unused since we're now exclusively on the Vercel AI SDK + Bedrock for all those concerns.

### What replaced it
- `/api/llm/insights` now calls `invokeBedrock` directly (~10 LOC, no SDK middleman).
- The chat path uses Vercel AI SDK `streamText` with native tool definitions — covering everything LangChain agents would have done, with first-class streaming.

---

## 8. Decommissioned OpenRouter setup

- **File still present:** `src/libs/gpt.ts` — exports `sendOpenRouter(messages, userId, max, modelOverride)` and an alias `sendOpenAi`.
- **Default model:** `meta-llama/llama-3.3-70b-instruct:free` (rate-limited free tier).
- **Auth:** `OPENROUTER_API_KEY`.
- **Callers as of 2026-05-05:** zero in `src/` and `scripts/`. Marked `@deprecated` in the file header.

Plan: delete the file (and drop the `OPENROUTER` enum value plus the `OPENROUTER_API_KEY` env var) on the next major schema migration. Until then, keep it as a no-op safety net for any external integration that might still POST to it.

---

## 9. Cost & telemetry

### `LLMInteraction` table
Every LLM call to Bedrock is logged here. Schema fields used today:
- `provider` ∈ `{ BEDROCK_ANTHROPIC, MOCK }` (`MOCK` is set by `interpret-alert` when it falls back to rule-based output, so the row is preserved for usage-graph continuity).
- `model` ∈ `{ CLAUDE_HAIKU_4_5, GPT_4O_MINI (legacy fallback marker) }`.
- `interaction_type` ∈ `{ CHAT, ALERT_INTERPRETATION, KNOWLEDGE_QUERY, REPORT_GENERATION, EMBEDDING }`.
- `input_tokens`, `output_tokens`, `cost_usd`, `latency_ms`.
- `org_clerk_id`, `user_clerk_id` (chat path), `plant_id`, `alert_id`, `ticket_id`.

### `LLMUsageSummary` table
Daily/weekly/monthly aggregates with token counts by interaction type and total cost. Populated by `/api/llm/usage` on demand (currently a read-time aggregation — not a background job).

### Token estimation
- **Chat path:** uses `result.totalUsage` from the AI SDK, which Bedrock returns natively in the streaming response. Real numbers.
- **Inverter diagnosis & insights:** Bedrock's non-streaming `InvokeModelCommand` does not return usage in the response payload, so these endpoints don't write `LLMInteraction` rows today. (Adding `InvokeModelWithResponseStreamCommand` and aggregating usage is a follow-up.)
- **Alert interpretation:** approximated as `len(string)/4` for both directions when the LLM path runs. Not exact but tracks within ~15% of real usage for English text.

---

## 10. Environment variables

| Variable | Required? | Default | Used by |
|---|---|---|---|
| `BEDROCK_MODEL_ID` | no | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | `src/lib/ai/bedrock.ts`, `src/lib/ai/bedrock-provider.ts` |
| `BEDROCK_EMBEDDING_MODEL_ID` | no | `amazon.titan-embed-text-v2:0` | `src/lib/ai/embeddings.ts` |
| `AWS_REGION` | no | `eu-west-1` | all Bedrock files |
| `AWS_BEARER_TOKEN_BEDROCK` | yes (prod) | — | AWS SDK auto-pickup for both Bedrock paths |
| `OPENROUTER_API_KEY` | no (deprecated) | — | `src/libs/gpt.ts` only — has zero callers |
| `DATABASE_URL` | yes | — | Prisma — every persistence path |
| `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes (prod) | — | `auth()` in every chat route |

---

## 11. Where to look when debugging

| Symptom | First place to look |
|---|---|
| Chat returns 500 | `console.warn('[chat] ...')` lines in `src/app/api/chat/route.ts` — ensureConversation + persistChatTurn fail-soft. |
| Tool call shows access_denied | `getChatAccessContext` is returning the wrong plants — check `PlantAccess` rows for that user/org and the `expires_at` filter. |
| LLM ignores plant context and asks "which plant?" | The system prompt's `activePlantId` line is missing — check `body.plantId` is being forwarded by `ChatPanel`. |
| Inverter diagnosis returns "Failed to parse LLM response" | `extractJson` couldn't find `{...}` in the raw output — log `response` and tighten the prompt's JSON instruction. |
| Cost in `LLMInteraction` looks wrong | Pricing constants live in `src/lib/ai/chat-persistence.ts` (`HAIKU_4_5_INPUT_USD_PER_1K`, `HAIKU_4_5_OUTPUT_USD_PER_1K`). |
| Insight card says "Llama 3.2 (Ollama)" | Stale browser cache — the label was updated 2026-05-05 to "Claude Haiku 4.5" / "via AWS Bedrock". Hard-refresh. |
| LLM field-mapper returns "kept-regex" for every column | Bedrock 403 in the TS path — `AWS_BEARER_TOKEN_BEDROCK` is commented out in `.env`. Uncomment, restart dev. Or set `NURAVOLT_LLM_FIELD_MAPPING_ENABLED=0` to silence. |
| Threshold tuner returns 0 overrides | Either Bedrock auth failed (check `[threshold_tuner] Bedrock error:` log) or the LLM's suggestions all fell out of physics bounds (check `[threshold_tuner] rejected ...` lines). Cache TTL is 30 days — delete `backenddata/cache/threshold_tuner/{hash}.json` to force re-run. |
| Fleet insights endpoint returns 404 | Either no plants accessible to the calling user (`getChatAccessContext` returned empty) OR Bedrock failed. Demo callers need `userId='demo_user'` + `orgId='demo_org'` paths in the route's auth fallback. |
| Cascade Layer 4 never fires | Triage gate filtered every fault. Lower `NURAVOLT_AI_DEMO_MODE=1` (relaxes confidence/revenue floors) or call `should_invoke_ai` with `TriageConfig()` to debug which gate rejected. |
| Warranty extractor returns 0 terms | Either the PDF text was too short / blank → check input passed to `extract_warranty_terms`. Or LLM hallucinated field names not in the closed schema → check `[warranty_extractor] rejected ...` lines. |

---

## 12. Phase K additions (2026-06)

Six LLM call sites shipped after the May 2026 review. Each follows the same Bedrock connector + closed-output validation + graceful fallback pattern used by the original 8.

### 12.1 Cascade Layer 4 — Fault Classifier Override

**File**: `nuravolt/fault/ai_classifier.py:BedrockFaultClassifier`
**Caller**: `nuravolt/fault/cascade_attribution.py:attribute_layers` when prior layers all <0.7 confidence
**Provider**: AWS Bedrock (Python boto3 path, model `qwen.qwen3-32b-v1:0`)
**Cost gates**:
1. **Triage gate** (`should_invoke_ai`): skips faults with confidence <0.50, days_to_fault >30, urgency not in {critical, urgent, soon, high, warning}, revenue_at_risk <€100. ~25% of cascade-uncertain faults pass.
2. **Disk cache** (24h TTL at `backenddata/cache/ai_classifications/{hash}.json`): same noisy inverter + signal fingerprint → cached.
**Closed taxonomy**: 47 fault types (rejected if LLM returns anything else).
**Fallback**: synthetic candidate from `cascade_attribution._synthesise_ai_confidence()`.
**Persisted**: results stored inline in `predictive_faults` JSON when regen runs (`scripts/regenerate_all_faults.py`).

### 12.2 Onboarding — Field-Mapper Polish (TS)

**File**: `src/lib/services/field-mapping-llm.ts:llmPolishMappings`
**Caller**: `src/app/api/connections/[connectionId]/discover/route.ts` after `mapFields()` regex pass when any mapping's confidence <0.7
**Provider**: AWS Bedrock (TypeScript SDK, Claude Haiku 4.5)
**Cost gates**: only fires when regex confidence <0.7; concurrency cap 3 parallel Bedrock calls
**Closed taxonomy**: every Prisma `DataFieldType` enum value (~45 types). LLM output validated; out-of-taxonomy rejected → keep regex result.
**Confidence clamping**: LLM confidence floored 0.5 / ceiling 0.85 — never lets LLM override a high-confidence regex match.
**Fallback**: regex result kept on Bedrock error.
**Env override**: `NURAVOLT_LLM_FIELD_MAPPING_ENABLED=0` to disable.
**Persisted**: through to `FieldMapping` table (same as regex output).

### 12.3 Onboarding — Threshold Tuner (Python)

**File**: `nuravolt/llm/threshold_tuner.py:tune_thresholds`
**Caller**: at plant provisioning (currently manual via `scripts/smoke_test_threshold_tuner.py`; wiring into the discover route is pending)
**Provider**: AWS Bedrock (Python boto3, Qwen 3 32B)
**Closed schema**: 13 tunable thresholds across `inverter`, `string`, `mppt`, `soiling`, `sensor_health`, `efficiency`, `thermal_twin` — every value validated against physics bounds before acceptance.
**Cost gates**: one call per plant at onboarding; 30-day disk cache at `backenddata/cache/threshold_tuner/{hash}.json` (LLM output stable for ≥30 days).
**Output**: `TunerResult.overrides_dict` shaped `{section: {field: value}}` — applied via `FaultDetectionConfig.apply_overrides()`.
**Fallback**: empty result → fleet defaults kept.

### 12.4 Onboarding — BESS Warranty PDF Extractor

**File**: `nuravolt/llm/warranty_extractor.py:extract_warranty_terms`
**Caller**: when a client uploads a BESS contract / warranty PDF
**Provider**: AWS Bedrock (Python boto3, Qwen 3 32B)
**Closed schema**: 10 warranty fields (`soh_eol_threshold_pct`, `cycle_count_warranty`, `max_temp_dwell_c`, `max_c_rate_charge/discharge`, `min_rte_pct`, `max_throughput_mwh_per_year`, `warranty_years`, `max_soc_high_dwell_hours_year`, `max_soc_low_dwell_hours_year`) — all physics-bounded.
**Input**: raw PDF text (caller extracts via `pdf-parse` on TS side or any Python lib). LLM never sees the PDF binary.
**Fallback**: empty result → universal warranty rules in `BessFaultDetector` kept.
**Cost**: one call per warranty PDF, ~€0.001 per upload.

### 12.5 Cross-Fleet Insight Synthesizer

**File**: `src/lib/ai/briefings.ts:generateFleetInsights` (function), `src/app/api/llm/fleet-insights/route.ts` (HTTP endpoint)
**Caller**: `GET /api/llm/fleet-insights` — intended weekly cron, also on-demand from dashboard
**Provider**: AWS Bedrock (Claude Haiku 4.5)
**Inputs**: aggregated state across all plants the org has access to — open tickets by priority/status + 7-day soiling forecast averages per plant (no per-row data).
**Output schema**:
```json
{
  "headline": "<1 sentence>",
  "action_items": [{"priority": "high|medium|low", "plant_slug": "...", "summary": "..."}],
  "emerging_risks": [{"risk": "...", "affected_plants": [...], "evidence": "..."}]
}
```
**Hard rules** in system prompt: 3-5 action items, 0-3 risks, cite only values present in input, risks cluster across ≥2 plants OR single very-high-stakes plant.
**Cost**: ~1 LLM call per org per week (~€0.005). Cap protects scaling.
**Fallback**: returns null → UI hides the tile.
**Auth**: Clerk `auth()` with fallback to `demo_user` / `demo_org` for unauthenticated calls.

### 12.6 (Decommissioned) Reply Generation — Claude Sonnet 4

**File**: `automation/ai/claude_client.py`
**Status**: still works but no live callers in the running app. Kept for the automation/scheduler.py path if it gets reactivated.

---

## 13. New env vars (Phase K)

| Variable | Required? | Default | Used by |
|---|---|---|---|
| `BEDROCK_FAULT_MODEL_ID` | no | `qwen.qwen3-32b-v1:0` | `ai_classifier.py` — swap to Claude Haiku 4.5 when AWS account has Anthropic approval |
| `BEDROCK_THRESHOLD_TUNER_MODEL_ID` | no | inherits `BEDROCK_FAULT_MODEL_ID` | `threshold_tuner.py` |
| `BEDROCK_WARRANTY_MODEL_ID` | no | inherits `BEDROCK_FAULT_MODEL_ID` | `warranty_extractor.py` |
| `NURAVOLT_AI_CLASSIFY_ENABLED` | no | unset | `cascade_attribution.py` — explicit on/off for Layer 4 |
| `NURAVOLT_AI_DEMO_MODE` | no | unset | relaxes triage thresholds for demo data |
| `NURAVOLT_LLM_FIELD_MAPPING_ENABLED` | no | `1` (on) | set to `0` to disable LLM polish in discover route |

## 14. LangGraph agent service (Python)

`nuravolt/agent` is a separate planner/executor agent (LangGraph, FastAPI) that consumes the product through the MCP server with an API key. It has an explicit graph (classify, plan, execute, verify, synthesize), a durable human-approval interrupt before every write, Postgres checkpoints and a per-organisation memory store in schema `agent`, and an offline eval suite that runs in CI with a scripted model. Model provider is Bedrock when AWS credentials exist, otherwise any OpenAI-compatible endpoint. Usage rows land in `LLMInteraction` with `request_hash` prefixed `agent:`. Full description, diagrams and runbook: `docs/AGENT.md`. LangChain is therefore back in the repository, but only on the Python side; the web app stays on the Vercel AI SDK.

