"""Long-term memory: durable facts about an organisation, kept in a LangGraph
Store namespace per org and rendered into the system prompt each turn.

Facts are extracted by the model with a structured call after each answer
(see nodes/memory.py), validated, and upserted under a stable key so a
repeated statement updates instead of duplicating.
"""
from __future__ import annotations

import re
from typing import Any

from .state import MemoryFact

MIN_CONFIDENCE = 0.6
MAX_FACTS_PER_TURN = 5
MAX_FACTS_IN_PROMPT = 8


def facts_namespace(org_id: str) -> tuple[str, ...]:
    return ("org", org_id, "facts")


def fact_key(fact: MemoryFact) -> str:
    subject = re.sub(r"[^a-z0-9]+", "_", fact.subject.lower()).strip("_")[:60] or "unknown"
    return f"{fact.kind}:{subject}"


def accept(facts: list[MemoryFact]) -> list[MemoryFact]:
    kept = [f for f in facts if f.confidence >= MIN_CONFIDENCE and f.value.strip()]
    return kept[:MAX_FACTS_PER_TURN]


async def load_facts(store: Any, org_id: str, query: str | None = None) -> list[dict[str, Any]]:
    items = await store.asearch(facts_namespace(org_id), query=query, limit=MAX_FACTS_IN_PROMPT)
    return [dict(item.value, key=item.key) for item in items]


async def save_facts(store: Any, org_id: str, facts: list[MemoryFact]) -> list[str]:
    keys = []
    for f in accept(facts):
        key = fact_key(f)
        await store.aput(facts_namespace(org_id), key, f.model_dump())
        keys.append(key)
    return keys


def render_facts(facts: list[dict[str, Any]]) -> str:
    if not facts:
        return ""
    lines = [f"- {f.get('kind')}: {f.get('subject')} = {f.get('value')}" for f in facts]
    return "What I remember about this organisation:\n" + "\n".join(lines)
