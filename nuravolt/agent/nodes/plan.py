from __future__ import annotations

import json

from ..memory import render_facts
from ..models import call_structured
from ..state import AgentState, PlanOut, PlanStep, Verdict
from ..tools.mcp_client import is_write_tool
from . import Runtime, chat_history, prompt


def _catalogue_text(rt: Runtime) -> str:
    lines = []
    for c in rt.tools.catalogue():
        req = ", ".join(c["required"]) or "none"
        lines.append(f"- {c['name']} (write={'yes' if c['is_write'] else 'no'}; required: {req}): {c['description'][:300]}")
    return "\n".join(lines)


def _prior_verdicts(state: AgentState) -> str:
    parts = []
    bad = [v for v in state.get("verdicts", []) if not v["passed"]]
    if bad:
        parts.append("Earlier attempts failed verification; fix these:\n" + "\n".join(f"- step {v['step_id']}: {v['reason']}" for v in bad[-4:]))
    results = state.get("tool_results", [])
    if results:
        parts.append("Results already obtained in this thread (reuse ids from them, do not repeat the calls):\n" + "\n".join(
            f"- {r['tool']}({json.dumps(r['args'], default=str)[:200]}) -> {json.dumps(r['output'], default=str)[:1200]}" for r in results[-6:]))
    return "\n\n".join(parts)


def plan(state: AgentState, rt: Runtime) -> dict:
    rt.mark("plan")
    replanning = bool(state.get("plan"))
    out = call_structured(
        rt.model,
        PlanOut,
        system=prompt("system") + "\n\n" + prompt(
            "plan",
            catalogue=_catalogue_text(rt),
            memories=render_facts(state.get("memories", [])),
            prior_verdicts=_prior_verdicts(state),
        ),
        history=chat_history(state, 12),
    )
    steps: list[PlanStep] = []
    dropped: list[Verdict] = []
    known = set(rt.tools.names())
    for i, s in enumerate(out.steps[: rt.settings.max_steps]):
        if s.tool is not None and s.tool not in known:
            # A hallucinated tool never reaches execution; the verifier sees it.
            dropped.append({"step_id": i + 1, "passed": False, "reason": f"planner named unknown tool {s.tool!r}; step dropped", "action": "continue"})
            continue
        args = {k: v for k, v in dict(s.args).items() if k != "idempotency_key"}  # ours, never the planner's
        steps.append({"id": len(steps) + 1, "goal": s.goal, "tool": s.tool, "args": args, "is_write": bool(s.tool and is_write_tool(s.tool)), "status": "pending", "result_ref": None})
    writes = [s for s in steps if s["is_write"]]
    if writes and state.get("intent") != "action":
        # A question never earns a write, whatever the planner thought.
        for w in writes:
            w["status"] = "skipped"
            dropped.append({"step_id": w["id"], "passed": False, "reason": f"{w['tool']} is a write and the request was a question; step skipped", "action": "continue"})
        writes = []
    if len(writes) > 1:
        for extra in writes[1:]:
            extra["status"] = "skipped"
            dropped.append({"step_id": extra["id"], "passed": False, "reason": "only one write per request is allowed; extra write skipped", "action": "continue"})
    update: dict = {"plan": steps, "current_step": 0, "verdicts": dropped}
    if replanning:
        update["replans"] = state.get("replans", 0) + 1
    if out.note and not steps:
        update["final_answer"] = None
        update["verdicts"] = dropped + [{"step_id": None, "passed": False, "reason": out.note, "action": "finish"}]
    return update


def serialize_plan(state: AgentState) -> str:
    return json.dumps(state.get("plan", []), indent=1, default=str)
