"""Wiring shared by the CLI and the HTTP server: settings -> model, tools,
persistence, graph. One `AgentService` per process."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

from langchain_core.messages import HumanMessage
from langgraph.types import Command

from .checkpoint import open_persistence
from .graph import build_graph, graph_config
from .models import get_chat_model
from .nodes import Runtime
from .settings import AgentSettings
from .telemetry import UsageRecorder, configure_tracing
from .tools.mcp_client import ToolRegistry, load_mcp_registry

log = logging.getLogger("nuravolt.agent")


class AgentService:
    def __init__(self, settings: AgentSettings, tools: ToolRegistry, checkpointer: Any, store: Any, model: Any = None):
        self.settings = settings
        self.tools = tools
        self.checkpointer = checkpointer
        self.store = store
        self.model = model or get_chat_model(settings)
        self.provider = settings.effective_provider()
        self.tracing = configure_tracing(settings.langsmith_tracing)

    def runtime(self, thread_id: str, org_id: Optional[str] = None, user_id: Optional[str] = None) -> Runtime:
        org = org_id if (org_id and self.settings.allow_org_override) else self.settings.org_id
        user = user_id or self.settings.user_id
        model_id = self.settings.bedrock_model_id if self.provider == "bedrock" else self.settings.openai_model
        usage = UsageRecorder(model_id, org, user, thread_id, self.settings.database_url)
        return Runtime(settings=self.settings, model=self.model, tools=self.tools, store=self.store, usage=usage, org_id=org, user_id=user, thread_id=thread_id)

    def graph(self, rt: Runtime):
        return build_graph(rt, checkpointer=self.checkpointer)

    async def stream_message(self, thread_id: str, content: str, org_id: Optional[str] = None, user_id: Optional[str] = None) -> AsyncIterator[dict[str, Any]]:
        rt = self.runtime(thread_id, org_id, user_id)
        graph = self.graph(rt)
        async for ev in self._stream(graph, {"messages": [HumanMessage(content=content)]}, rt):
            yield ev

    async def stream_resume(self, thread_id: str, decision: dict[str, Any], org_id: Optional[str] = None, user_id: Optional[str] = None) -> AsyncIterator[dict[str, Any]]:
        rt = self.runtime(thread_id, org_id, user_id)
        graph = self.graph(rt)
        state = await graph.aget_state(graph_config(thread_id, rt))
        if not state.tasks or not any(getattr(t, "interrupts", None) for t in state.tasks):
            yield {"type": "error", "error": "no_pending_interrupt"}
            return
        async for ev in self._stream(graph, Command(resume=decision), rt):
            yield ev

    async def _stream(self, graph, inp, rt: Runtime) -> AsyncIterator[dict[str, Any]]:
        cfg = graph_config(rt.thread_id, rt)
        async for mode, chunk in graph.astream(inp, cfg, stream_mode=["updates"]):
            if mode != "updates":
                continue
            for node, update in (chunk or {}).items():
                if node == "__interrupt__":
                    for intr in update:
                        yield {"type": "interrupt", "payload": getattr(intr, "value", intr)}
                    continue
                if not isinstance(update, dict):
                    continue
                summary: dict[str, Any] = {"type": "node", "node": node}
                if "intent" in update:
                    summary["intent"] = update["intent"]
                if "plan" in update:
                    summary["plan"] = [{"id": s["id"], "goal": s["goal"], "tool": s["tool"], "status": s["status"], "is_write": s["is_write"]} for s in update["plan"]]
                if update.get("tool_results"):
                    for r in update["tool_results"]:
                        yield {"type": "tool_result", "step_id": r["step_id"], "tool": r["tool"], "ok": r["ok"], "latency_ms": r["latency_ms"], "output": r["output"]}
                if update.get("verdicts"):
                    summary["verdicts"] = update["verdicts"]
                if update.get("approvals"):
                    summary["approvals"] = update["approvals"]
                yield summary
                if node == "memory_write" or (node == "synthesize" and update.get("final_answer")):
                    if update.get("final_answer"):
                        yield {"type": "done", "final_answer": update["final_answer"], "usage": update.get("usage", {})}

    async def state(self, thread_id: str) -> dict[str, Any]:
        rt = self.runtime(thread_id)
        graph = self.graph(rt)
        snap = await graph.aget_state(graph_config(thread_id, rt))
        values = snap.values or {}
        pending = [getattr(i, "value", i) for t in (snap.tasks or []) for i in (getattr(t, "interrupts", None) or [])]
        return {
            "thread_id": thread_id,
            "next": list(snap.next or []),
            "pending_interrupt": pending[0] if pending else None,
            "values": {
                "intent": values.get("intent"),
                "plan": values.get("plan", []),
                "approvals": values.get("approvals", []),
                "verdicts": values.get("verdicts", []),
                "final_answer": values.get("final_answer"),
                "usage": values.get("usage", {}),
                "messages": [{"type": m.type, "content": (m.content if isinstance(m.content, str) else str(m.content))[:2000]} for m in values.get("messages", [])[-20:]],
            },
        }

    async def history(self, thread_id: str, limit: int = 20) -> list[dict[str, Any]]:
        rt = self.runtime(thread_id)
        graph = self.graph(rt)
        out = []
        async for snap in graph.aget_state_history(graph_config(thread_id, rt)):
            out.append({"checkpoint_id": snap.config["configurable"].get("checkpoint_id"), "next": list(snap.next or []), "step": snap.metadata.get("step") if snap.metadata else None, "created_at": snap.created_at})
            if len(out) >= limit:
                break
        return out


@asynccontextmanager
async def open_service(settings: AgentSettings, model: Any = None, tools: Optional[ToolRegistry] = None, persistent: bool = True) -> AsyncIterator[AgentService]:
    if tools is None:
        key = settings.resolved_mcp_api_key()
        tools = await load_mcp_registry(settings.mcp_url, key, settings.mcp_timeout_s)
    async with open_persistence(settings.database_url if persistent else None, settings.checkpoint_schema) as (saver, store):
        yield AgentService(settings, tools, saver, store, model=model)
