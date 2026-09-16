#!/usr/bin/env python3
"""Live agent evals: the offline cases from nuravolt/agent/evals/cases.yaml,
run against a real model and the real MCP server, with an LLM judge on the
final answer.

Unlike the offline suite the model is free to plan, so trajectory checks are
subset checks (every expected tool was called, no forbidden tool was), and
approval interrupts are auto-approved or auto-rejected per the case's resume
decision. Writes hit the real product: point MCP_API_KEY at a demo org.

    MCP_URL=http://localhost:3000/api/mcp/mcp MCP_API_KEY=nv_test_... \
      python scripts/agent_eval_live.py [--case soiling_question] [--out automation/qa/agent-eval.json]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.memory import InMemoryStore
from langgraph.types import Command
from pydantic import BaseModel, Field

from nuravolt.agent.evals.runner import load_cases
from nuravolt.agent.graph import build_graph, graph_config
from nuravolt.agent.models import call_structured, get_chat_model
from nuravolt.agent.nodes import Runtime, prompt
from nuravolt.agent.settings import load_settings
from nuravolt.agent.tools.mcp_client import load_mcp_registry


class JudgeOut(BaseModel):
    score: int = Field(ge=1, le=5)
    rationale: str


async def run(case: dict, settings, model, tools) -> dict:
    calls: list[str] = []
    orig = tools.acall

    async def spy(name, args, timeout_s=60.0):
        calls.append(name)
        return await orig(name, args, timeout_s=timeout_s)

    tools.acall = spy  # type: ignore[method-assign]
    rt = Runtime(settings=settings, model=model, tools=tools, store=InMemoryStore(), org_id=settings.org_id, thread_id=f"live-{case['id']}-{int(time.time())}")
    graph = build_graph(rt, checkpointer=MemorySaver())
    cfg = graph_config(rt.thread_id, rt)
    t0 = time.perf_counter()
    interrupted = False
    async for _mode, chunk in graph.astream({"messages": [HumanMessage(content=case["prompt"])]}, cfg, stream_mode=["updates"]):
        if "__interrupt__" in (chunk or {}):
            interrupted = True
    if interrupted:
        async for _ in graph.astream(Command(resume=case.get("resume") or {"decision": "rejected", "note": "live eval"}), cfg, stream_mode=["updates"]):
            pass
    state = (await graph.aget_state(cfg)).values
    answer = state.get("final_answer") or ""
    judge = call_structured(model, JudgeOut, system=prompt("judge"), user=f"Question: {case['prompt']}\n\nTool results: {json.dumps(state.get('tool_results', []), default=str)[:6000]}\n\nAnswer: {answer}")
    failures = []
    for t in case.get("expected_trajectory", []):
        if t not in calls:
            failures.append(f"expected tool not called: {t}")
    for t in case.get("must_not_call", []):
        if t in calls:
            failures.append(f"forbidden tool called: {t}")
    if bool(case.get("expect_interrupt")) != interrupted:
        failures.append(f"interrupt={interrupted}, expected {bool(case.get('expect_interrupt'))}")
    for needle in case.get("answer_must_contain", []):
        if needle.lower() not in answer.lower():
            failures.append(f"answer missing {needle!r}")
    return {"id": case["id"], "calls": calls, "interrupted": interrupted, "answer": answer, "judge": judge.model_dump(), "usage": state.get("usage", {}), "seconds": round(time.perf_counter() - t0, 1), "failures": failures}


async def main_async(args) -> int:
    settings = load_settings()
    model = get_chat_model(settings)
    tools = await load_mcp_registry(settings.mcp_url, settings.resolved_mcp_api_key(), settings.mcp_timeout_s)
    cases = [c for c in load_cases() if not args.case or c["id"] in args.case]
    results = []
    for case in cases:
        r = await run(case, settings, model, tools)
        results.append(r)
        print(f"{'PASS' if not r['failures'] else 'FAIL'} {r['id']}  judge={r['judge']['score']}/5  {r['seconds']}s  calls={r['calls']}")
        for f in r["failures"]:
            print("   ", f)
    out = Path(args.out or f"automation/qa/agent-eval-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"provider": settings.effective_provider(), "results": results}, indent=2, default=str))
    print(f"wrote {out}")
    return 1 if any(r["failures"] for r in results) else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--case", action="append", help="run only these case ids (repeatable)")
    ap.add_argument("--out")
    return asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
