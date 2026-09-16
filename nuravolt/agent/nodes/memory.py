from __future__ import annotations

from ..memory import load_facts, save_facts
from ..models import call_structured
from ..state import AgentState, MemoryFactsOut
from . import Runtime, prompt
from .classify import last_user_text


async def memory_read(state: AgentState, rt: Runtime) -> dict:
    rt.mark("memory_read")
    if rt.store is None:
        return {"memories": []}
    try:
        facts = await load_facts(rt.store, rt.org_id, query=last_user_text(state) or None)
    except Exception:  # noqa: BLE001 - memory is a convenience, never a blocker
        facts = []
    return {"memories": facts}


async def memory_write(state: AgentState, rt: Runtime) -> dict:
    rt.mark("memory_write")
    if rt.store is None or state.get("intent") in ("chitchat", "out_of_scope"):
        return {}
    text = last_user_text(state)
    if not text:
        return {}
    try:
        out = call_structured(rt.model, MemoryFactsOut, system=prompt("system") + "\n\n" + prompt("memory_extract"), user=text)
        keys = await save_facts(rt.store, rt.org_id, out.facts)
    except Exception:  # noqa: BLE001
        keys = []
    return {"usage": {**state.get("usage", {}), "memory_keys_written": keys}}
