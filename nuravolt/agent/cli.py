"""Command line entry points.

    python -m nuravolt.agent chat --thread t1 "Which inverter at Kilima is soiling fastest?"
    python -m nuravolt.agent chat --thread t1            # interactive REPL, approvals prompted inline
    python -m nuravolt.agent serve                        # FastAPI on AGENT_PORT
    python -m nuravolt.agent tools --dump                 # print the MCP tool catalogue as JSON
    python -m nuravolt.agent eval                         # offline evals with the scripted fake model
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from typing import Any

from .settings import load_settings


def _print_event(ev: dict[str, Any]) -> None:
    t = ev.get("type")
    if t == "node":
        line = f"[{ev['node']}]"
        if "intent" in ev:
            line += f" intent={ev['intent']}"
        if "plan" in ev:
            line += "\n" + "\n".join(f"   {s['id']}. {s['goal']}  ->  {s['tool'] or 'reason'}{'  (write)' if s['is_write'] else ''}" for s in ev["plan"])
        if ev.get("verdicts"):
            line += "\n" + "\n".join(f"   verdict step {v['step_id']}: {'ok' if v['passed'] else 'FAIL'} ({v['action']}) {v['reason']}" for v in ev["verdicts"])
        print(line)
    elif t == "tool_result":
        print(f"   {ev['tool']} -> {'ok' if ev['ok'] else 'error'} in {ev['latency_ms']} ms: {json.dumps(ev['output'], default=str)[:300]}")
    elif t == "interrupt":
        print("\nAPPROVAL NEEDED\n" + ev["payload"].get("preview", json.dumps(ev["payload"])))
    elif t == "done":
        print("\n" + ev["final_answer"] + f"\n\n(usage: {json.dumps(ev.get('usage', {}))})")
    elif t == "error":
        print("error:", ev.get("error"), file=sys.stderr)


async def _chat(args: argparse.Namespace) -> int:
    from .service import open_service

    settings = load_settings()
    thread = args.thread or uuid.uuid4().hex[:12]
    async with open_service(settings, persistent=not args.ephemeral) as svc:
        print(f"thread {thread}  provider={svc.provider}  tools={len(svc.tools.names())}")

        async def run(text: str) -> None:
            pending = None
            async for ev in svc.stream_message(thread, text):
                _print_event(ev)
                if ev.get("type") == "interrupt":
                    pending = ev["payload"]
            while pending is not None:
                ans = (await asyncio.get_event_loop().run_in_executor(None, input, "approve / reject / edit {json}: ")).strip()
                decision: dict[str, Any] = {"decision": "rejected", "decided_by": "cli"}
                if ans.startswith("approve"):
                    decision = {"decision": "approved", "decided_by": "cli"}
                elif ans.startswith("edit"):
                    decision = {"decision": "edited", "edited_args": json.loads(ans[4:].strip() or "{}"), "decided_by": "cli"}
                pending = None
                async for ev in svc.stream_resume(thread, decision):
                    _print_event(ev)
                    if ev.get("type") == "interrupt":
                        pending = ev["payload"]

        if args.message:
            await run(" ".join(args.message))
            return 0
        while True:
            try:
                text = input("\nyou> ").strip()
            except (EOFError, KeyboardInterrupt):
                return 0
            if text in ("", "exit", "quit"):
                return 0
            await run(text)


async def _tools(args: argparse.Namespace) -> int:
    from .tools.mcp_client import load_mcp_registry

    settings = load_settings()
    reg = await load_mcp_registry(settings.mcp_url, settings.resolved_mcp_api_key(), settings.mcp_timeout_s)
    cat = reg.catalogue()
    if args.dump:
        print(json.dumps({c["name"]: {"description": c["description"], "properties": c["parameters"], "required": c["required"], "is_write": c["is_write"]} for c in cat}, indent=2))
    else:
        for c in cat:
            print(f"{c['name']:40s} {'write' if c['is_write'] else 'read '}  {c['description'][:80]}")
    return 0


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    settings = load_settings()
    uvicorn.run("nuravolt.agent.server:app", host=settings.host, port=settings.port, log_level="info")
    return 0


def _eval(args: argparse.Namespace) -> int:
    from .evals.runner import run_all

    return run_all(verbose=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="nuravolt.agent", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("chat"); c.add_argument("message", nargs="*"); c.add_argument("--thread"); c.add_argument("--ephemeral", action="store_true", help="in-memory checkpoints (no DATABASE_URL needed)")
    t = sub.add_parser("tools"); t.add_argument("--dump", action="store_true")
    sub.add_parser("serve")
    sub.add_parser("eval")
    args = ap.parse_args(argv)
    if args.cmd == "chat":
        return asyncio.run(_chat(args))
    if args.cmd == "tools":
        return asyncio.run(_tools(args))
    if args.cmd == "serve":
        return _serve(args)
    return _eval(args)
