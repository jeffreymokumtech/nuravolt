"""The planner/executor graph.

    memory_read -> classify_intent -> plan -> execute_step <-> verify -> synthesize -> memory_write
                                   \\-> synthesize (chitchat / out of scope)
    execute_step -> request_approval (interrupt) -> execute_step | verify   for write steps
    verify -> plan (replan, bounded) | execute_step (next / retry) | synthesize

Routing functions are pure functions of state so they are unit-testable
without a model.
"""
from __future__ import annotations

from functools import partial
from typing import Any, Literal

from langgraph.graph import END, START, StateGraph
from langgraph.types import RetryPolicy

from .nodes import Runtime
from .nodes.classify import classify_intent
from .nodes.execute import current, execute_step, prepare_step, request_approval
from .nodes.memory import memory_read, memory_write
from .nodes.plan import plan
from .nodes.synthesize import synthesize
from .nodes.verify import route_after_verify, verify
from .state import AgentState


def route_after_classify(state: AgentState) -> Literal["plan", "synthesize"]:
    return "synthesize" if state.get("intent") in ("chitchat", "out_of_scope") else "plan"


def route_after_plan(state: AgentState) -> Literal["execute_step", "synthesize"]:
    return "execute_step" if any(s["status"] == "pending" for s in state.get("plan", [])) else "synthesize"


def route_execute(state: AgentState) -> Literal["request_approval", "execute_step"]:
    step = current(state)
    if step and step["is_write"] and step["status"] == "pending":
        return "request_approval"
    return "execute_step"


def _retry_route(state: AgentState) -> str:
    """After a retry_step verdict, rewind the cursor to the failed step."""
    return route_after_verify(state)


def build_graph(rt: Runtime, checkpointer: Any = None) -> Any:
    g = StateGraph(AgentState)
    g.add_node("memory_read", partial(memory_read, rt=rt))
    g.add_node("classify_intent", partial(classify_intent, rt=rt))
    g.add_node("plan", partial(plan, rt=rt), retry_policy=RetryPolicy(max_attempts=2))
    g.add_node("dispatch", partial(prepare_step, rt=rt))  # binds open args, then routes to approval or execution
    g.add_node("request_approval", partial(request_approval, rt=rt))
    g.add_node("execute_step", partial(execute_step, rt=rt))
    g.add_node("verify", partial(verify, rt=rt), retry_policy=RetryPolicy(max_attempts=2))
    g.add_node("rewind", _rewind)
    g.add_node("synthesize", partial(synthesize, rt=rt))
    g.add_node("memory_write", partial(memory_write, rt=rt))

    g.add_edge(START, "memory_read")
    g.add_edge("memory_read", "classify_intent")
    g.add_conditional_edges("classify_intent", route_after_classify, {"plan": "plan", "synthesize": "synthesize"})
    g.add_conditional_edges("plan", route_after_plan, {"execute_step": "dispatch", "synthesize": "synthesize"})
    g.add_conditional_edges("dispatch", route_execute, {"request_approval": "request_approval", "execute_step": "execute_step"})
    # request_approval returns Command(goto=...) itself.
    g.add_edge("execute_step", "verify")
    g.add_conditional_edges(
        "verify",
        route_after_verify,
        {"execute_step": "dispatch", "plan": "plan", "synthesize": "synthesize", "retry": "rewind"},
    )
    g.add_edge("rewind", "dispatch")
    g.add_edge("synthesize", "memory_write")
    g.add_edge("memory_write", END)
    return g.compile(checkpointer=checkpointer)


def _rewind(state: AgentState) -> dict:
    idx = max(0, state.get("current_step", 1) - 1)
    plan_ = [dict(s) for s in state.get("plan", [])]
    if idx < len(plan_):
        plan_[idx]["status"] = "approved" if plan_[idx]["is_write"] else "pending"
    return {"current_step": idx, "plan": plan_}


def graph_config(thread_id: str, rt: Runtime) -> dict[str, Any]:
    cfg: dict[str, Any] = {"configurable": {"thread_id": thread_id}, "recursion_limit": rt.settings.recursion_limit}
    if rt.usage:
        cfg["callbacks"] = [rt.usage]
    return cfg
