"""Graph state and the structured outputs each node asks the model for.

The state is the single source of truth for a thread: it is what the Postgres
checkpointer persists between requests and across an approval interrupt.
"""
from __future__ import annotations

import operator
from typing import Annotated, Any, Literal, Optional, TypedDict

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field

Intent = Literal["question", "action", "chitchat", "out_of_scope"]
StepStatus = Literal["pending", "approved", "rejected", "done", "failed", "skipped"]
VerdictAction = Literal["continue", "retry_step", "replan", "finish"]
Decision = Literal["approved", "rejected", "edited"]


class PlanStep(TypedDict):
    id: int
    goal: str
    tool: Optional[str]          # MCP tool name; None means "reason only"
    args: dict[str, Any]
    is_write: bool               # set by code from WRITE_TOOLS, never by the model
    status: StepStatus
    result_ref: Optional[int]    # index into tool_results


class ToolResult(TypedDict):
    step_id: int
    tool: str
    args: dict[str, Any]
    output: Any
    ok: bool
    latency_ms: int


class Verdict(TypedDict):
    step_id: Optional[int]       # None = whole-plan verdict
    passed: bool
    reason: str
    action: VerdictAction


class ApprovalRecord(TypedDict):
    step_id: int
    tool: str
    args: dict[str, Any]
    decision: Decision
    edited_args: Optional[dict[str, Any]]
    note: Optional[str]
    decided_by: str


class AgentState(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    intent: Optional[Intent]
    plan: list[PlanStep]
    current_step: int
    tool_results: Annotated[list[ToolResult], operator.add]
    verdicts: Annotated[list[Verdict], operator.add]
    approvals: Annotated[list[ApprovalRecord], operator.add]
    memories: list[dict[str, Any]]
    replans: int
    usage: dict[str, Any]
    final_answer: Optional[str]


# ---------------------------------------------------------------- structured outputs

class IntentOut(BaseModel):
    intent: Intent
    needs_tools: bool = True
    rationale: str = ""


class PlannedStep(BaseModel):
    goal: str = Field(description="What this step establishes, in one sentence")
    tool: Optional[str] = Field(default=None, description="Exact tool name from the catalogue, or null to reason without a tool")
    args: dict[str, Any] = Field(default_factory=dict)


class PlanOut(BaseModel):
    steps: list[PlannedStep] = Field(default_factory=list)
    note: str = ""


class VerdictOut(BaseModel):
    passed: bool
    reason: str
    action: VerdictAction = "continue"


class ArgsOut(BaseModel):
    """Arguments for one step, resolved from earlier tool results."""

    args: dict[str, Any] = Field(default_factory=dict)
    note: str = ""


class MemoryFact(BaseModel):
    kind: Literal["nickname", "preference", "contact", "threshold", "other"]
    subject: str
    value: str
    confidence: float = Field(ge=0.0, le=1.0)


class MemoryFactsOut(BaseModel):
    facts: list[MemoryFact] = Field(default_factory=list)


def new_state() -> AgentState:
    return AgentState(
        messages=[], intent=None, plan=[], current_step=0, tool_results=[], verdicts=[],
        approvals=[], memories=[], replans=0, usage={"llm_calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0},
        final_answer=None,
    )
