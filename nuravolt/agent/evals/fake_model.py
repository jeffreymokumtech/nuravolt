"""A scripted chat model for offline evals and unit tests.

Nodes only ever call `with_structured_output(Schema)` or plain `invoke`, so
the fake answers by schema name from a per-case script and returns canned
text otherwise. No network, no keys, deterministic.
"""
from __future__ import annotations

from typing import Any, Callable, Iterator, Optional

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableLambda
from pydantic import BaseModel

from ..state import ArgsOut, IntentOut, MemoryFactsOut, PlanOut, VerdictOut


class ScriptedChatModel(BaseChatModel):
    """`script` maps a schema name (IntentOut, PlanOut, VerdictOut,
    MemoryFactsOut) to an object, a list of objects consumed in order, or a
    callable(messages) -> object. `text` is the free-text reply."""

    script: dict[str, Any] = {}
    text: str = "Scripted answer."
    calls: list[str] = []

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def _generate(self, messages: list[BaseMessage], stop: Optional[list[str]] = None, run_manager: Optional[CallbackManagerForLLMRun] = None, **kwargs: Any) -> ChatResult:
        self.calls.append("text")
        msg = AIMessage(content=self.text, usage_metadata={"input_tokens": 100, "output_tokens": 20, "total_tokens": 120})
        return ChatResult(generations=[ChatGeneration(message=msg)])

    def _next(self, name: str, messages: list[BaseMessage]) -> Any:
        item = self.script.get(name)
        if isinstance(item, list):
            if not item:
                return DEFAULTS[name]()  # script exhausted: behave like a model with nothing more to add
            return item.pop(0)
        if callable(item) and not isinstance(item, BaseModel):
            return item(messages)
        if item is None:
            return DEFAULTS[name]()
        return item

    def with_structured_output(self, schema: Any, **kwargs: Any):  # type: ignore[override]
        name = getattr(schema, "__name__", str(schema))

        def _run(messages: Any) -> Any:
            self.calls.append(name)
            out = self._next(name, messages)
            return schema.model_validate(out) if isinstance(out, dict) else out

        return RunnableLambda(_run)

    def with_retry(self, **kwargs: Any):  # type: ignore[override]
        return self

    def bind_tools(self, tools: Any, **kwargs: Any):  # type: ignore[override]
        return self


DEFAULTS: dict[str, Callable[[], BaseModel]] = {
    "IntentOut": lambda: IntentOut(intent="question", needs_tools=True),
    "PlanOut": lambda: PlanOut(steps=[]),
    "VerdictOut": lambda: VerdictOut(passed=True, reason="ok", action="continue"),
    "MemoryFactsOut": lambda: MemoryFactsOut(facts=[]),
    "ArgsOut": lambda: ArgsOut(args={}),
}
