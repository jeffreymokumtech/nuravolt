"""Runs cases.yaml through the real graph with a scripted model and fake
tools. Used by tests/agent and `python -m nuravolt.agent eval`."""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.memory import InMemoryStore
from langgraph.types import Command

from ..graph import build_graph, graph_config
from ..nodes import Runtime
from ..settings import AgentSettings
from ..state import ArgsOut, IntentOut, MemoryFactsOut, PlanOut, VerdictOut
from ..tools.mcp_client import fake_registry
from .fake_model import ScriptedChatModel

HERE = Path(__file__).resolve().parent


def load_cases(path: Path | None = None) -> list[dict[str, Any]]:
    return yaml.safe_load((path or HERE / "cases.yaml").read_text())


def load_schemas() -> dict[str, dict[str, Any]]:
    return json.loads((HERE / "tool_schemas.json").read_text())


@dataclass
class CaseResult:
    case_id: str
    calls: list[tuple[str, dict[str, Any]]]
    interrupt: dict[str, Any] | None
    calls_after_resume: list[tuple[str, dict[str, Any]]]
    final_answer: str | None
    state: dict[str, Any]
    memory_keys: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures


def build_case_model(case: dict[str, Any]) -> ScriptedChatModel:
    plans = [PlanOut(steps=case.get("plan", []))]
    if case.get("replan"):
        plans.append(PlanOut(steps=case["replan"]))
    script: dict[str, Any] = {
        "IntentOut": IntentOut(intent=case.get("intent", "question"), needs_tools=bool(case.get("plan"))),
        "PlanOut": plans,
        "MemoryFactsOut": MemoryFactsOut(facts=case.get("memory_facts", [])),
    }
    if case.get("verdicts"):
        script["VerdictOut"] = [VerdictOut(**v) for v in case["verdicts"]]
    if case.get("bind_args"):
        script["ArgsOut"] = [ArgsOut(args=a) for a in case["bind_args"]]
    return ScriptedChatModel(script=script, text=case.get("answer_text", "Scripted answer."), calls=[])


async def run_case(case: dict[str, Any], settings: AgentSettings | None = None) -> CaseResult:
    settings = settings or AgentSettings(AGENT_MODEL_PROVIDER="fake", DATABASE_URL=None)
    calls: list[tuple[str, dict[str, Any]]] = []
    tools = fake_registry(case.get("tool_outputs", {}), load_schemas(), calls)
    store = InMemoryStore()
    rt = Runtime(settings=settings, model=build_case_model(case), tools=tools, store=store, org_id="org_test", thread_id=f"eval-{case['id']}")
    graph = build_graph(rt, checkpointer=MemorySaver())
    cfg = graph_config(rt.thread_id, rt)

    interrupt_payload = None
    async for mode, chunk in graph.astream({"messages": [HumanMessage(content=case["prompt"])]}, cfg, stream_mode=["updates"]):
        for node, update in (chunk or {}).items():
            if node == "__interrupt__":
                interrupt_payload = getattr(update[0], "value", update[0])
    before = list(calls)
    after: list[tuple[str, dict[str, Any]]] = []
    if interrupt_payload is not None and case.get("resume"):
        n = len(calls)
        async for _ in graph.astream(Command(resume=case["resume"]), cfg, stream_mode=["updates"]):
            pass
        after = calls[n:]
    snap = await graph.aget_state(cfg)
    values = snap.values
    mem = [item.key for item in await store.asearch(("org", "org_test", "facts"))]
    res = CaseResult(case["id"], before, interrupt_payload, after, values.get("final_answer"), values, memory_keys=mem)
    res.failures = check(case, res)
    return res


def check(case: dict[str, Any], res: CaseResult) -> list[str]:
    f: list[str] = []
    traj = [c[0] for c in res.calls]
    if traj != case.get("expected_trajectory", []):
        f.append(f"trajectory {traj} != {case.get('expected_trajectory', [])}")
    for name in case.get("must_not_call", []):
        if any(c[0] == name for c in res.calls + res.calls_after_resume):
            f.append(f"forbidden tool called: {name}")
    if bool(res.interrupt) != bool(case.get("expect_interrupt")):
        f.append(f"interrupt={bool(res.interrupt)} expected {bool(case.get('expect_interrupt'))}")
    if res.interrupt and case.get("interrupt_tool") and res.interrupt.get("tool") != case["interrupt_tool"]:
        f.append(f"interrupt tool {res.interrupt.get('tool')} != {case['interrupt_tool']}")
    if "after_resume_calls" in case:
        got = [c[0] for c in res.calls_after_resume]
        if got != case["after_resume_calls"]:
            f.append(f"after-resume calls {got} != {case['after_resume_calls']}")
    for tool, expected in (case.get("after_resume_args_contain") or {}).items():
        actual = next((a for n, a in res.calls_after_resume if n == tool), None)
        if actual is None or any(actual.get(k) != v for k, v in expected.items()):
            f.append(f"{tool} args {actual} do not contain {expected}")
    for tool, expected in (case.get("expected_args") or {}).items():
        actual = next((a for n, a in res.calls + res.calls_after_resume if n == tool), None)
        if actual is None or any(actual.get(k) != v for k, v in expected.items()):
            f.append(f"{tool} args {actual} do not contain {expected}")
    for needle in case.get("answer_must_contain", []):
        if needle not in (res.final_answer or ""):
            f.append(f"answer missing {needle!r}")
    if "expect_replans" in case and res.state.get("replans", 0) != case["expect_replans"]:
        f.append(f"replans {res.state.get('replans')} != {case['expect_replans']}")
    for key in case.get("expect_memory_keys", []):
        if key not in res.memory_keys:
            f.append(f"memory key {key} not written (have {res.memory_keys})")
    return f


def run_all(verbose: bool = False, path: Path | None = None) -> int:
    results = [asyncio.run(run_case(c)) for c in load_cases(path)]
    bad = 0
    for r in results:
        status = "PASS" if r.ok else "FAIL"
        bad += not r.ok
        if verbose or not r.ok:
            print(f"{status} {r.case_id}" + ("" if r.ok else ": " + "; ".join(r.failures)))
    print(f"{len(results) - bad}/{len(results)} cases passed")
    return 1 if bad else 0
