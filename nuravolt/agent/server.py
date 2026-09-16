"""FastAPI transport for the agent.

    GET  /healthz
    POST /threads/{thread_id}/messages   {"content": "..."}          -> SSE
    POST /threads/{thread_id}/approve    {"decision": "approved"|"rejected"|"edited", "edited_args"?, "note"?} -> SSE
    GET  /threads/{thread_id}/state
    GET  /threads/{thread_id}/history

An approval interrupt ends the first stream with an `interrupt` event; the
client keeps the thread id and calls /approve, which resumes the same
checkpointed run.
"""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from .service import AgentService, open_service
from .settings import load_settings


class MessageIn(BaseModel):
    content: str
    user_id: Optional[str] = None


class ApproveIn(BaseModel):
    decision: str
    edited_args: Optional[dict[str, Any]] = None
    note: Optional[str] = None
    decided_by: Optional[str] = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = load_settings()
    async with open_service(settings) as svc:
        app.state.svc = svc
        yield


app = FastAPI(title="NuraVolt agent", version="0.1.0", lifespan=lifespan)


def svc(request: Request) -> AgentService:
    return request.app.state.svc


def authorize(request: Request, authorization: Optional[str] = Header(default=None)) -> None:
    token = svc(request).settings.service_token
    if token and authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="bad service token")


def org_from(request: Request, x_org_id: Optional[str] = Header(default=None)) -> Optional[str]:
    return x_org_id


def _sse(gen: AsyncIterator[dict[str, Any]]) -> EventSourceResponse:
    async def events():
        async for ev in gen:
            yield {"event": ev.get("type", "message"), "data": json.dumps(ev, default=str)}

    return EventSourceResponse(events())


@app.get("/healthz")
async def healthz(request: Request) -> dict[str, Any]:
    s = svc(request)
    return {"ok": True, "model_provider": s.provider, "mcp_tools": len(s.tools.names()), "checkpointer": type(s.checkpointer).__name__, "tracing": s.tracing}


@app.post("/threads/{thread_id}/messages", dependencies=[Depends(authorize)])
async def post_message(thread_id: str, body: MessageIn, request: Request, org_id: Optional[str] = Depends(org_from)):
    return _sse(svc(request).stream_message(thread_id, body.content, org_id=org_id, user_id=body.user_id))


@app.post("/threads/{thread_id}/approve", dependencies=[Depends(authorize)])
async def approve(thread_id: str, body: ApproveIn, request: Request, org_id: Optional[str] = Depends(org_from)):
    state = await svc(request).state(thread_id)
    if not state["pending_interrupt"]:
        raise HTTPException(status_code=409, detail="no pending interrupt on this thread")
    return _sse(svc(request).stream_resume(thread_id, body.model_dump(exclude_none=True), org_id=org_id))


@app.get("/threads/{thread_id}/state", dependencies=[Depends(authorize)])
async def get_state(thread_id: str, request: Request) -> dict[str, Any]:
    return await svc(request).state(thread_id)


@app.get("/threads/{thread_id}/history", dependencies=[Depends(authorize)])
async def get_history(thread_id: str, request: Request, limit: int = 20) -> list[dict[str, Any]]:
    return await svc(request).history(thread_id, limit=limit)
