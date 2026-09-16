"""
LLM Service Layer

Provides LLM-powered features for NuraVolt:
- Alert interpretation: Convert ML anomalies to human-readable explanations
- Knowledge base: RAG over equipment manuals and O&M documentation
- Report generation: Automated daily/weekly performance reports

Supports:
- Azure OpenAI (GPT-4o, GPT-4o-mini)
- AWS Bedrock (Claude, Llama) - future

Cost tracking and caching built-in for production use.
"""

from nuravolt.llm.client import (
    LLMClient,
    AzureOpenAIClient,
    LLMResponse,
    get_client,
)
from nuravolt.llm.alert_interpreter import (
    AlertInterpreter,
    InterpretedAlert,
    AnomalyContext,
    HistoricalMatch,
)

__all__ = [
    # Client
    "LLMClient",
    "AzureOpenAIClient",
    "LLMResponse",
    "get_client",
    # Alert Interpreter
    "AlertInterpreter",
    "InterpretedAlert",
    "AnomalyContext",
    "HistoricalMatch",
]
