from __future__ import annotations

import json
from typing import Literal

from langgraph.types import Command, interrupt

from ..models import call_structured
from ..state import AgentState, ApprovalRecord, ArgsOut, PlanStep, ToolResult, Verdict
from ..tools.mcp_client import idempotency_key
from . import Runtime, prompt


PLACEHOLDERS = {None, "", "undefined", "null", "none", "unknown", "tbd"}


def _is_placeholder(v) -> bool:
    if isinstance(v, str):
        return v.strip().lower() in PLACEHOLDERS or (v.startswith("<") and v.endswith(">")) or v.startswith("{{")
    return v is None


def _ungrounded_ids(step: PlanStep, results: list) -> list[str]:
    """Id-like arguments whose value never appeared in a tool result."""
    if not results:
        return []
    blob = json.dumps(results, default=str)
    return [k for k, v in step["args"].items() if k.lower().endswith("id") and isinstance(v, str) and v not in blob]


def needs_binding(rt: Runtime, step: PlanStep, results: list | None = None) -> bool:
    """True when required arguments are missing, the planner left
    placeholders, or an id was guessed rather than taken from a result."""
    spec = next((c for c in rt.tools.catalogue() if c["name"] == step["tool"]), None)
    if spec is None:
        return False
    required = [r for r in spec["required"] if r != "idempotency_key"]
    if any(r not in step["args"] for r in required):
        return True
    if any(_is_placeholder(v) for v in step["args"].values()):
        return True
    return bool(_ungrounded_ids(step, results or []))


def bind_args(rt: Runtime, state: AgentState, step: PlanStep) -> dict:
    """Executor half of planner/executor: resolve ids from prior results."""
    rt.mark("bind_args")
    spec = next(c for c in rt.tools.catalogue() if c["name"] == step["tool"])
    results = state.get("tool_results", [])
    if not results:
        return dict(step["args"])
    out = call_structured(
        rt.model,
        ArgsOut,
        system=prompt("system") + "\n\n" + prompt(
            "bind",
            goal=step["goal"],
            tool=step["tool"],
            parameters=json.dumps(spec["parameters"], default=str)[:3000],
            required=", ".join(r for r in spec["required"] if r != "idempotency_key") or "none",
            args=json.dumps(step["args"], default=str),
            results="\n".join(f"- {r['tool']}({json.dumps(r['args'], default=str)[:200]}) -> {json.dumps(r['output'], default=str)[:6000]}" for r in results[-6:]),
        ),
    )
    merged = {k: v for k, v in step["args"].items() if not _is_placeholder(v)}
    blob = json.dumps(results, default=str)
    for k, v in out.args.items():
        if k not in spec["parameters"] or _is_placeholder(v):
            continue
        # Identifiers must be grounded: an id that never appeared in a tool
        # result is a hallucination, and a missing argument fails validation
        # loudly (replan) instead of hitting the product with a made-up id.
        if k.lower().endswith("id") and isinstance(v, str) and v not in blob:
            continue
        merged[k] = v
    return merged


def prepare_step(state: AgentState, rt: Runtime) -> dict:
    """Executor prep before routing: bind open arguments from earlier results
    so both the approval preview and the call see the real values."""
    step = current(state)
    if step is None or step["tool"] is None or step["status"] not in ("pending", "approved"):
        return {}
    results = state.get("tool_results", [])
    if not needs_binding(rt, step, results):
        return {}
    plan = [dict(s) for s in state["plan"]]
    # Guessed ids are dropped before binding so the model must re-derive them.
    cleaned = {k: v for k, v in step["args"].items() if k not in _ungrounded_ids(step, results)}
    plan[state.get("current_step", 0)]["args"] = bind_args(rt, state, {**step, "args": cleaned})
    return {"plan": plan}


def current(state: AgentState) -> PlanStep | None:
    plan = state.get("plan", [])
    i = state.get("current_step", 0)
    return plan[i] if 0 <= i < len(plan) else None


def render_preview(step: PlanStep) -> str:
    args = ", ".join(f"{k}={json.dumps(v, default=str)}" for k, v in step["args"].items())
    return f"{step['tool']}({args})\n{step['goal']}"


async def request_approval(state: AgentState, rt: Runtime) -> Command[Literal["execute_step", "verify"]]:
    """Pause the graph for a human decision on a write step. The interrupt is
    checkpointed, so the decision can arrive minutes later from another
    process via Command(resume=...). Async on purpose: interrupt() needs the
    run context, which sync nodes lose under asyncio on Python 3.10."""
    rt.mark("request_approval")
    step = current(state)
    assert step is not None and step["is_write"]
    decision = interrupt(
        {
            "type": "approval_request",
            "step_id": step["id"],
            "tool": step["tool"],
            "args": step["args"],
            "goal": step["goal"],
            "preview": render_preview(step),
        }
    )
    decision = decision or {}
    verdict = str(decision.get("decision", "rejected"))
    edited = decision.get("edited_args") if verdict == "edited" else None
    record: ApprovalRecord = {
        "step_id": step["id"], "tool": step["tool"] or "", "args": step["args"], "decision": verdict,  # type: ignore[typeddict-item]
        "edited_args": edited, "note": decision.get("note"), "decided_by": str(decision.get("decided_by") or rt.user_id),
    }
    plan = [dict(s) for s in state["plan"]]
    idx = state.get("current_step", 0)
    if verdict in ("approved", "edited"):
        plan[idx]["status"] = "approved"
        if edited:
            plan[idx]["args"] = dict(edited)
        return Command(update={"approvals": [record], "plan": plan}, goto="execute_step")
    plan[idx]["status"] = "skipped"
    skipped: Verdict = {"step_id": step["id"], "passed": False, "reason": "write rejected by the user; step skipped", "action": "continue"}
    return Command(update={"approvals": [record], "plan": plan, "verdicts": [skipped]}, goto="verify")


async def execute_step(state: AgentState, rt: Runtime) -> dict:
    rt.mark("execute_step")
    step = current(state)
    if step is None:
        return {}
    plan = [dict(s) for s in state["plan"]]
    idx = state.get("current_step", 0)
    if step["tool"] is None:
        plan[idx]["status"] = "done"
        return {"plan": plan}
    if step["is_write"] and step["status"] != "approved":
        # Belt and braces: the graph routes writes through request_approval,
        # and even if it did not, an unapproved write never executes.
        plan[idx]["status"] = "failed"
        return {"plan": plan, "verdicts": [{"step_id": step["id"], "passed": False, "reason": "write attempted without approval", "action": "finish"}]}
    args = dict(step["args"])
    if step["is_write"]:
        # Same key on every retry/resume of this step: the server dedupes.
        args["idempotency_key"] = idempotency_key(rt.thread_id, step["id"], step["args"])
    problems = rt.tools.validate_args(step["tool"], args)
    if problems:
        plan[idx]["status"] = "failed"
        return {"plan": plan, "verdicts": [{"step_id": step["id"], "passed": False, "reason": "invalid arguments: " + "; ".join(problems), "action": "replan"}]}
    output, ok, latency = await rt.tools.acall(step["tool"], args, timeout_s=rt.settings.mcp_timeout_s)
    result: ToolResult = {"step_id": step["id"], "tool": step["tool"], "args": args, "output": output, "ok": ok, "latency_ms": latency}
    plan[idx]["status"] = "done" if ok else "failed"
    plan[idx]["result_ref"] = len(state.get("tool_results", []))
    # Tool results stay in state (tool_results), not in the chat history: a
    # ToolMessage without a matching tool-use block is rejected by Bedrock.
    return {"plan": plan, "tool_results": [result]}
