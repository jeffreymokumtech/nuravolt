"""Graph nodes. Each node is a small function of (state, runtime) so it can be
unit tested with a fake model and an in-memory tool registry."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from langchain_core.language_models import BaseChatModel

from ..settings import AgentSettings
from ..telemetry import UsageRecorder
from ..tools.mcp_client import ToolRegistry

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"


def chat_history(state: Any, limit: int = 12) -> list:
    """Human and assistant turns only, for the model-facing history."""
    from langchain_core.messages import AIMessage, HumanMessage

    msgs = [m for m in state.get("messages", []) if isinstance(m, (HumanMessage, AIMessage))]
    return msgs[-limit:]


def prompt(name: str, **fmt: Any) -> str:
    text = (PROMPTS / f"{name}.md").read_text()
    return text.format(**fmt) if fmt else text


@dataclass
class Runtime:
    """Everything a node needs besides the state."""

    settings: AgentSettings
    model: BaseChatModel
    tools: ToolRegistry
    store: Any = None
    usage: Optional[UsageRecorder] = None
    org_id: str = "demo_org_alpha1"
    user_id: str = "agent"
    thread_id: str = "default"
    extra: dict[str, Any] = field(default_factory=dict)

    def mark(self, node: str) -> None:
        if self.usage:
            self.usage.set_node(node)
