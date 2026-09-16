from __future__ import annotations

import json

from langchain_core.messages import AIMessage

from ..models import call_text
from ..state import AgentState
from ..tools.mcp_client import is_write_tool
from . import Runtime, chat_history, prompt


def write_outcome_sentence(state: AgentState) -> str:
    """One deterministic sentence per write that did not succeed, drawn from
    the tool results (which survive replans) and the current plan."""
    parts = []
    seen: set[str] = set()
    for r in state.get("tool_results", []):
        if is_write_tool(r["tool"]) and not r["ok"]:
            err = r["output"] if isinstance(r["output"], dict) else {}
            detail = err.get("detail") or err.get("error") or str(r["output"])[:120]
            parts.append(f"The requested change ({r['tool']}) was not applied: {detail}.")
            seen.add(r["tool"])
    rejected = {a["step_id"] for a in state.get("approvals", []) if a["decision"] == "rejected"}
    for step in state.get("plan", []):
        if not step["is_write"] or step["tool"] in seen:
            continue
        if step["id"] in rejected:
            parts.append(f"The requested change ({step['tool']}) was not applied: you rejected it.")
        elif step["status"] == "skipped":
            continue  # skipped by policy (a write the user never asked for); nothing to report
        elif step["status"] in ("pending", "approved", "failed"):
            parts.append(f"The requested change ({step['tool']}) was not applied: the plan stopped before it completed.")
    return " ".join(parts)


def synthesize(state: AgentState, rt: Runtime) -> dict:
    rt.mark("synthesize")
    intent = state.get("intent")
    if intent == "out_of_scope":
        text = "I can only help with plant operations on this platform: soiling, faults, batteries, contracts, tickets and reports. That request is outside what I can do."
    elif intent == "chitchat":
        text = call_text(rt.model, prompt("system"), history=chat_history(state, 6))
    else:
        results = [
            {"step": r["step_id"], "tool": r["tool"], "ok": r["ok"], "output": r["output"]}
            for r in state.get("tool_results", [])
        ]
        text = call_text(
            rt.model,
            prompt("system") + "\n\n" + prompt(
                "synthesize",
                results=json.dumps(results, default=str)[:12000],
                approvals=json.dumps(state.get("approvals", []), default=str)[:2000],
                verdicts=json.dumps([v for v in state.get("verdicts", []) if not v["passed"]], default=str)[:2000],
            ),
            history=chat_history(state, 12),
        )
        # Writes are never left to the model's memory of what happened.
        prefix = write_outcome_sentence(state)
        if prefix:
            text = prefix + " " + text
    usage = dict(state.get("usage", {}))
    if rt.usage:
        usage.update(rt.usage.totals)
    return {"final_answer": text, "messages": [AIMessage(content=text)], "usage": usage}
