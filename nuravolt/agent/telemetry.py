"""Per-call usage accounting into the product's LLMInteraction table, plus the
LangSmith tracing switch.

One row per model call (not per turn), tagged with the node name and thread
in request_hash so cost can be broken down by step in /admin/usage.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Optional

from langchain_core.callbacks import BaseCallbackHandler

log = logging.getLogger("nuravolt.agent.telemetry")

# USD per 1M tokens (input, output); mirror of src/lib/ai/llm-pricing.ts.
PRICING = {
    "qwen": (0.15, 1.20),
    "anthropic": (1.00, 5.00),
    "haiku": (1.00, 5.00),
}
DEFAULT_PRICE = (0.15, 1.20)


def price_for(model_id: str) -> tuple[float, float]:
    mid = (model_id or "").lower()
    for key, price in PRICING.items():
        if key in mid:
            return price
    return DEFAULT_PRICE


def estimate_cost_usd(model_id: str, input_tokens: int, output_tokens: int) -> float:
    pin, pout = price_for(model_id)
    return round((input_tokens * pin + output_tokens * pout) / 1_000_000, 6)


def configure_tracing(enabled: bool) -> str:
    """LangGraph/LangChain pick LangSmith up from the environment; this only
    reports which mode is active so it shows in the service logs."""
    if enabled and os.environ.get("LANGSMITH_API_KEY"):
        os.environ.setdefault("LANGSMITH_TRACING", "true")
        return "langsmith"
    os.environ.pop("LANGSMITH_TRACING", None)
    return "off"


class UsageRecorder(BaseCallbackHandler):
    """Collects token usage per LLM call and, when a DATABASE_URL is given,
    writes an LLMInteraction row for each. Failures never break a turn."""

    def __init__(self, model_id: str, org_id: str, user_id: str, thread_id: str, database_url: Optional[str] = None):
        self.model_id = model_id
        self.org_id = org_id
        self.user_id = user_id
        self.thread_id = thread_id
        self.database_url = database_url
        self.totals = {"llm_calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
        self.node = "unknown"
        self._started: dict[Any, float] = {}
        self._pool = None

    def set_node(self, node: str) -> None:
        self.node = node

    # -- LangChain callback hooks -------------------------------------------------
    def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):  # noqa: D401
        self._started[run_id] = time.perf_counter()

    def on_llm_end(self, response, *, run_id, **kwargs):
        latency_ms = int((time.perf_counter() - self._started.pop(run_id, time.perf_counter())) * 1000)
        inp = out = 0
        try:
            gen = response.generations[0][0]
            meta = getattr(gen.message, "usage_metadata", None) or {}
            inp, out = int(meta.get("input_tokens", 0) or 0), int(meta.get("output_tokens", 0) or 0)
        except Exception:  # noqa: BLE001
            pass
        cost = estimate_cost_usd(self.model_id, inp, out)
        self.totals["llm_calls"] += 1
        self.totals["input_tokens"] += inp
        self.totals["output_tokens"] += out
        self.totals["cost_usd"] = round(self.totals["cost_usd"] + cost, 6)
        self._record(inp, out, cost, latency_ms, True, None)

    def on_llm_error(self, error, *, run_id, **kwargs):
        latency_ms = int((time.perf_counter() - self._started.pop(run_id, time.perf_counter())) * 1000)
        self._record(0, 0, 0.0, latency_ms, False, str(error)[:500])

    # -- persistence --------------------------------------------------------------
    def _record(self, inp: int, out: int, cost: float, latency_ms: int, ok: bool, err: Optional[str]) -> None:
        if not self.database_url:
            return
        mid = self.model_id.lower()
        provider = "BEDROCK_QWEN" if "qwen" in mid else ("BEDROCK_ANTHROPIC" if "anthropic" in mid else "MOCK")
        model_enum = "QWEN3_NEXT_80B" if "qwen" in mid else None
        if model_enum is None:
            return  # no matching LLMModel enum value; totals still accumulate
        try:
            import psycopg

            with psycopg.connect(self.database_url, connect_timeout=5) as conn:
                conn.execute(
                    """
                    INSERT INTO "LLMInteraction"
                      (id, org_clerk_id, user_clerk_id, provider, model, interaction_type,
                       input_tokens, output_tokens, cost_usd, latency_ms, request_hash, success, error_message)
                    VALUES (gen_random_uuid()::text, %s, %s, %s::"LLMProvider", %s::"LLMModel", 'CHAT'::"LLMInteractionType",
                            %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (self.org_id, self.user_id, provider, model_enum, inp, out, cost, latency_ms,
                     f"agent:{self.node}:{self.thread_id}", ok, err),
                )
        except Exception as exc:  # noqa: BLE001
            log.debug("LLMInteraction insert skipped: %s", exc)
