"""Chat-model provider factory, retries, and validated structured output.

Provider precedence (settings.effective_provider): an explicit fake for tests,
AWS Bedrock when credentials exist, otherwise any OpenAI-compatible endpoint
(Ollama, OpenRouter, OpenAI). Nodes never let the model free-run tools: every
model call here either returns text or a validated pydantic object, and the
graph decides what to execute.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Sequence, Type, TypeVar

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, ValidationError

from .settings import AgentSettings

log = logging.getLogger("nuravolt.agent.models")
T = TypeVar("T", bound=BaseModel)


class ConfigError(RuntimeError):
    pass


def get_chat_model(settings: AgentSettings, fake: BaseChatModel | None = None) -> BaseChatModel:
    provider = settings.effective_provider()
    if provider == "fake":
        if fake is None:
            raise ConfigError(
                "No model provider configured: set AWS credentials (Bedrock), OPENAI_BASE_URL, "
                "or pass a fake model (tests)."
            )
        return fake
    if provider == "bedrock":
        from langchain_aws import ChatBedrockConverse

        model: BaseChatModel = ChatBedrockConverse(
            model=settings.bedrock_model_id,
            region_name=settings.aws_region,
            temperature=settings.temperature,
            max_tokens=settings.max_output_tokens,
        )
    else:
        from langchain_openai import ChatOpenAI

        model = ChatOpenAI(
            base_url=settings.openai_base_url,
            api_key=settings.openai_api_key or "not-needed",
            model=settings.openai_model,
            temperature=settings.temperature,
            max_tokens=settings.max_output_tokens,
        )
    return model


def _retrying(runnable: Any) -> Any:
    """Transient provider errors (throttling, timeouts) are retried with
    jitter; validation failures are handled separately in call_structured()."""
    try:
        return runnable.with_retry(stop_after_attempt=3, wait_exponential_jitter=True)
    except Exception:  # noqa: BLE001 - fakes may not support it
        return runnable


def _messages(system: str, history: Sequence[BaseMessage], user: str | None) -> list[BaseMessage]:
    msgs: list[BaseMessage] = [SystemMessage(content=system), *history]
    if user:
        msgs.append(HumanMessage(content=user))
    return msgs


def call_structured(
    model: BaseChatModel,
    schema: Type[T],
    system: str,
    history: Sequence[BaseMessage] = (),
    user: str | None = None,
    attempts: int = 2,
) -> T:
    """Ask for a validated object; on validation failure re-prompt once with
    the error text so weaker tool-calling models get a second chance."""
    structured = _retrying(model.with_structured_output(schema, include_raw=False))
    msgs = _messages(system, history, user)
    last_err: Exception | None = None
    for attempt in range(attempts):
        try:
            out = structured.invoke(msgs)
            if isinstance(out, schema):
                return out
            if isinstance(out, dict):
                return schema.model_validate(out)
            raise ValueError(f"model returned no {schema.__name__} object (got {type(out).__name__})")
        except (ValidationError, ValueError) as exc:  # includes OutputParserException
            last_err = exc
            log.warning("structured output for %s failed (attempt %d): %s", schema.__name__, attempt + 1, exc)
            msgs = msgs + [
                HumanMessage(
                    content=(
                        f"Your previous output did not match the required schema ({schema.__name__}). "
                        f"Error: {str(exc)[:800]}. Reply again with a valid object only."
                    )
                )
            ]
    # Last resort for models that answer a schema request by calling a tool
    # (seen with Qwen on Bedrock when the prompt lists tool names): ask for
    # plain JSON and validate it ourselves.
    log.warning("structured output for %s fell back to JSON text mode: %s", schema.__name__, last_err)
    schema_json = json.dumps(schema.model_json_schema(), separators=(",", ":"))
    text = call_text(
        model,
        system + f"\n\nRespond with ONLY a JSON object matching this schema, no prose, no code fences:\n{schema_json}",
        history,
        user,
    )
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise last_err  # type: ignore[misc]
    return schema.model_validate_json(text[start : end + 1])


def call_text(model: BaseChatModel, system: str, history: Sequence[BaseMessage] = (), user: str | None = None) -> str:
    out = _retrying(model).invoke(_messages(system, history, user))
    if isinstance(out, AIMessage):
        content = out.content
        if isinstance(content, list):  # Bedrock converse content blocks
            return "".join(str(b.get("text", "")) if isinstance(b, dict) else str(b) for b in content)
        return str(content)
    return str(out)


def usage_from_message(msg: Any) -> dict[str, int]:
    meta = getattr(msg, "usage_metadata", None) or {}
    return {"input_tokens": int(meta.get("input_tokens", 0) or 0), "output_tokens": int(meta.get("output_tokens", 0) or 0)}
