from __future__ import annotations

import json

from ..models import call_structured
from ..state import AgentState, Verdict, VerdictOut
from . import Runtime, prompt
from .classify import last_user_text
from .execute import current


def verify(state: AgentState, rt: Runtime) -> dict:
    rt.mark("verify")
    step = current(state)
    idx = state.get("current_step", 0)
    if step is None:
        return {"current_step": idx + 1}
    verdicts: list[Verdict] = []
    if step["status"] == "skipped":
        pass  # carries a verdict from the approval or the planner already
    elif step["status"] == "failed":
        res = state["tool_results"][step["result_ref"]] if step.get("result_ref") is not None else None
        if res is not None:  # a tool error (invalid-arg failures already carry a verdict)
            err = res["output"].get("error") if isinstance(res["output"], dict) else "tool_failed"
            detail = res["output"].get("detail") if isinstance(res["output"], dict) else str(res["output"])[:200]
            action = "replan" if state.get("replans", 0) < rt.settings.max_replans else "finish"
            verdicts.append({"step_id": step["id"], "passed": False, "reason": f"tool returned {err}: {detail}", "action": action})
    elif step["tool"] is None:
        verdicts.append({"step_id": step["id"], "passed": True, "reason": "reasoning step", "action": "continue"})
    else:
        res = state["tool_results"][step["result_ref"]] if step.get("result_ref") is not None else None
        out = call_structured(
            rt.model,
            VerdictOut,
            system=prompt("system") + "\n\n" + prompt(
                "verify",
                request=last_user_text(state)[:500],
                goal=step["goal"],
                tool=step["tool"],
                args=json.dumps(step["args"], default=str)[:800],
                result=json.dumps(res["output"] if res else None, default=str)[:20000],
            ),
        )
        action = out.action
        if action == "replan" and state.get("replans", 0) >= rt.settings.max_replans:
            action = "finish"
        verdicts.append({"step_id": step["id"], "passed": out.passed, "reason": out.reason, "action": action})
    return {"verdicts": verdicts, "current_step": idx + 1}


def route_after_verify(state: AgentState) -> str:
    """Pure routing: the last verdict decides, then the plan cursor."""
    verdicts = state.get("verdicts", [])
    last = verdicts[-1] if verdicts else None
    if last and last["action"] == "retry_step":
        return "retry"
    if last and last["action"] == "replan":
        return "plan"
    if last and last["action"] == "finish":
        return "synthesize"
    plan = state.get("plan", [])
    i = state.get("current_step", 0)
    while i < len(plan) and plan[i]["status"] == "skipped":
        i += 1
    return "execute_step" if i < len(plan) else "synthesize"
