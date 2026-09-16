"""Tools come from the product's own MCP server.

The agent is a customer of NuraVolt's public MCP surface (docs/MCP_SERVER.md):
Streamable HTTP, bearer API key, scope-checked, rate-limited and audited on
the server side. This module loads those tools as LangChain tools, knows which
of them write, and injects the idempotency key that makes a resumed or retried
write safe.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any, Iterable, Optional

from langchain_core.tools import BaseTool, StructuredTool

log = logging.getLogger("nuravolt.agent.tools")

# Server-side writes. Kept as a hard-coded set on purpose: the graph must not
# learn from a description whether a tool mutates state. Cross-checked at
# load time against the tool names the server advertises.
WRITE_TOOLS: frozenset[str] = frozenset(
    {
        "nuravolt_create_ticket",
        "nuravolt_update_ticket_status",
        "nuravolt_comment_on_ticket",
        "nuravolt_schedule_report",
        "nuravolt_approve_cleaning_schedule",
    }
)
WRITE_SUFFIXES = ("_create_", "_update_", "_approve_", "_schedule_", "_comment_")


def is_write_tool(name: str) -> bool:
    return name in WRITE_TOOLS


def check_write_coverage(tool_names: Iterable[str]) -> list[str]:
    """Names that look like writes but are not in WRITE_TOOLS. A non-empty
    list is a configuration error: refuse to start rather than run an unknown
    mutating tool without approval."""
    return sorted(n for n in tool_names if any(s in n for s in WRITE_SUFFIXES) and n not in WRITE_TOOLS)


def unwrap_mcp_content(out: Any) -> Any:
    """MCP tools return content blocks; the product's blocks carry one JSON
    document as text. Give the graph the parsed object."""
    if isinstance(out, str):
        try:
            return json.loads(out)
        except ValueError:
            return out
    if isinstance(out, list) and out and all(isinstance(b, dict) and b.get("type") == "text" for b in out):
        text = "\n".join(str(b.get("text", "")) for b in out)
        try:
            return json.loads(text)
        except ValueError:
            return text
    return out


def idempotency_key(thread_id: str, step_id: int, args: dict[str, Any]) -> str:
    digest = hashlib.sha256(json.dumps(args, sort_keys=True, default=str).encode()).hexdigest()[:8]
    return f"{thread_id}:{step_id}:{digest}"


class ToolRegistry:
    """Name -> tool, plus JSON schemas for the planner prompt and argument
    validation before anything reaches the product."""

    def __init__(self, tools: list[BaseTool]):
        self.tools = {t.name: t for t in tools}
        bad = check_write_coverage(self.tools)
        if bad:
            raise RuntimeError(f"tools look like writes but are not in WRITE_TOOLS: {bad}")

    def names(self) -> list[str]:
        return sorted(self.tools)

    def catalogue(self) -> list[dict[str, Any]]:
        out = []
        for name in self.names():
            t = self.tools[name]
            schema: dict[str, Any] = {}
            raw = getattr(t, "args_schema", None)
            if isinstance(raw, dict):                      # langchain-mcp-adapters: JSON schema dict
                schema = raw
            else:
                try:
                    schema = raw.model_json_schema() if raw is not None else {}  # pydantic model
                except Exception:  # noqa: BLE001
                    schema = {"properties": t.args} if getattr(t, "args", None) else {}
            out.append({"name": name, "description": (t.description or "").strip(), "is_write": is_write_tool(name), "parameters": schema.get("properties", {}), "required": schema.get("required", [])})
        return out

    def validate_args(self, name: str, args: dict[str, Any]) -> list[str]:
        """Missing required fields / unknown fields, as human-readable problems."""
        spec = next((c for c in self.catalogue() if c["name"] == name), None)
        if spec is None:
            return [f"unknown tool {name}"]
        problems = [f"missing required argument '{r}'" for r in spec["required"] if r not in args]
        known = set(spec["parameters"])
        if known:
            problems += [f"unknown argument '{k}'" for k in args if k not in known and k != "idempotency_key"]
        return problems

    async def acall(self, name: str, args: dict[str, Any], timeout_s: float = 60.0) -> tuple[Any, bool, int]:
        tool = self.tools[name]
        t0 = time.perf_counter()
        try:
            out = unwrap_mcp_content(await asyncio.wait_for(tool.ainvoke(args), timeout=timeout_s))
            ok = not (isinstance(out, dict) and out.get("error"))
            return out, ok, int((time.perf_counter() - t0) * 1000)
        except Exception as exc:  # noqa: BLE001
            return {"error": "tool_failed", "detail": str(exc)[:500]}, False, int((time.perf_counter() - t0) * 1000)


async def load_mcp_registry(url: str, api_key: Optional[str], timeout_s: float = 60.0) -> ToolRegistry:
    """Connect to the product MCP endpoint and load its tools."""
    from langchain_mcp_adapters.client import MultiServerMCPClient

    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    client = MultiServerMCPClient(
        {"nuravolt": {"url": url, "transport": "streamable_http", "headers": headers}}
    )
    tools = await client.get_tools()
    log.info("loaded %d MCP tools from %s", len(tools), url)
    return ToolRegistry(list(tools))


def fake_registry(outputs: dict[str, Any], schemas: dict[str, dict[str, Any]], calls: list[tuple[str, dict[str, Any]]]) -> ToolRegistry:
    """Offline registry for tests and evals: real tool names and JSON schemas,
    canned outputs, and every call recorded into `calls`."""
    from pydantic import create_model

    tools: list[BaseTool] = []
    for name, schema in schemas.items():
        fields = {}
        for pname, pspec in (schema.get("properties") or {}).items():
            ptype = {"string": str, "integer": int, "number": float, "boolean": bool}.get(pspec.get("type", "string"), Any)
            required = pname in (schema.get("required") or [])
            fields[pname] = (ptype if required else Optional[ptype], ... if required else None)
        fields["idempotency_key"] = (Optional[str], None)
        model = create_model(f"{name}_args", **fields)  # type: ignore[call-overload]

        def _make(n: str):
            def _run(**kwargs: Any) -> Any:
                calls.append((n, {k: v for k, v in kwargs.items() if v is not None}))
                return outputs.get(n, {"ok": True})

            return _run

        tools.append(StructuredTool.from_function(func=_make(name), name=name, description=schema.get("description", name), args_schema=model))
    return ToolRegistry(tools)
