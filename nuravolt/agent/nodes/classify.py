from __future__ import annotations

from langchain_core.messages import HumanMessage

from ..models import call_structured
from ..state import AgentState, IntentOut
from . import Runtime, chat_history, prompt


def last_user_text(state: AgentState) -> str:
    for m in reversed(state.get("messages", [])):
        if isinstance(m, HumanMessage):
            return m.content if isinstance(m.content, str) else str(m.content)
    return ""


def classify_intent(state: AgentState, rt: Runtime) -> dict:
    rt.mark("classify_intent")
    out = call_structured(
        rt.model,
        IntentOut,
        system=prompt("system") + "\n\n" + prompt("classify"),
        history=chat_history(state, 6),
    )
    return {"intent": out.intent}
