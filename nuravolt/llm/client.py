"""
LLM Client Abstraction

Supports:
- Azure OpenAI (GPT-4o, GPT-4o-mini)
- AWS Bedrock (Claude 3.5, Claude 3 Haiku, Llama 3) - planned

Features:
- Automatic cost tracking per request
- Token counting for budgeting
- Retry logic with exponential backoff
- Streaming support for chat/reports

Pricing (per 1M tokens, January 2025):
- gpt-4o: $2.50 input, $10.00 output
- gpt-4o-mini: $0.15 input, $0.60 output
- text-embedding-3-small: $0.02 input
- text-embedding-3-large: $0.13 input
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import List, Dict, Optional, Any, Iterator
import os
import time
import logging

logger = logging.getLogger(__name__)


@dataclass
class LLMResponse:
    """Standardized response from any LLM provider."""
    content: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: float

    def __str__(self):
        return self.content

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            'content': self.content,
            'model': self.model,
            'inputTokens': self.input_tokens,
            'outputTokens': self.output_tokens,
            'costUsd': round(self.cost_usd, 6),
            'latencyMs': round(self.latency_ms, 2),
        }


class LLMClient(ABC):
    """Abstract base for LLM providers."""

    @abstractmethod
    def complete(
        self,
        messages: List[Dict[str, str]],
        **kwargs
    ) -> LLMResponse:
        """Generate completion from messages."""
        pass

    @abstractmethod
    def embed(self, texts: List[str]) -> List[List[float]]:
        """Generate embeddings for texts."""
        pass

    def stream(
        self,
        messages: List[Dict[str, str]],
        **kwargs
    ) -> Iterator[str]:
        """Stream completion chunks. Override for streaming support."""
        response = self.complete(messages, **kwargs)
        yield response.content


class AzureOpenAIClient(LLMClient):
    """
    Azure OpenAI implementation.

    Models and pricing (per 1M tokens, January 2025):
    - gpt-4o: $2.50 input, $10.00 output
    - gpt-4o-mini: $0.15 input, $0.60 output
    - text-embedding-3-large: $0.13 input
    - text-embedding-3-small: $0.02 input

    Example:
        client = AzureOpenAIClient(deployment_name="gpt-4o-mini")
        response = client.complete([
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Explain this anomaly..."}
        ])
        print(f"Response: {response.content}")
        print(f"Cost: ${response.cost_usd:.4f}")
    """

    # Pricing per 1M tokens
    PRICING = {
        "gpt-4o": {"input": 2.50, "output": 10.00},
        "gpt-4o-mini": {"input": 0.15, "output": 0.60},
        "gpt-4-turbo": {"input": 10.00, "output": 30.00},
        "text-embedding-3-large": {"input": 0.13, "output": 0},
        "text-embedding-3-small": {"input": 0.02, "output": 0},
    }

    def __init__(
        self,
        deployment_name: str = "gpt-4o-mini",
        embedding_deployment: str = "text-embedding-3-small",
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
        api_version: str = "2024-08-01-preview",
        max_retries: int = 3,
        retry_delay: float = 1.0,
    ):
        """
        Initialize Azure OpenAI client.

        Args:
            deployment_name: Deployment name for chat completions
            embedding_deployment: Deployment name for embeddings
            api_key: Azure OpenAI API key (or set AZURE_OPENAI_API_KEY env var)
            endpoint: Azure OpenAI endpoint (or set AZURE_OPENAI_ENDPOINT env var)
            api_version: API version
            max_retries: Max retry attempts for transient failures
            retry_delay: Base delay between retries (exponential backoff)
        """
        self._api_key = api_key or os.environ.get("AZURE_OPENAI_API_KEY")
        self._endpoint = endpoint or os.environ.get("AZURE_OPENAI_ENDPOINT")
        self._api_version = api_version
        self.deployment = deployment_name
        self.embedding_deployment = embedding_deployment
        self.max_retries = max_retries
        self.retry_delay = retry_delay

        # Lazy initialize client
        self._client = None

    def _get_client(self):
        """Lazy initialize OpenAI client."""
        if self._client is None:
            try:
                from openai import AzureOpenAI
            except ImportError:
                raise ImportError(
                    "openai package required. Install with: pip install openai"
                )

            if not self._api_key:
                raise ValueError(
                    "Azure OpenAI API key required. "
                    "Set AZURE_OPENAI_API_KEY environment variable or pass api_key."
                )
            if not self._endpoint:
                raise ValueError(
                    "Azure OpenAI endpoint required. "
                    "Set AZURE_OPENAI_ENDPOINT environment variable or pass endpoint."
                )

            self._client = AzureOpenAI(
                api_key=self._api_key,
                api_version=self._api_version,
                azure_endpoint=self._endpoint,
            )

        return self._client

    def complete(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.1,
        max_tokens: int = 1000,
        **kwargs
    ) -> LLMResponse:
        """
        Generate completion from messages.

        Args:
            messages: List of message dicts with 'role' and 'content'
            temperature: Sampling temperature (0-2)
            max_tokens: Maximum tokens in response

        Returns:
            LLMResponse with content, tokens, cost, and latency
        """
        client = self._get_client()
        start = time.time()

        last_error = None
        for attempt in range(self.max_retries):
            try:
                response = client.chat.completions.create(
                    model=self.deployment,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    **kwargs
                )
                break
            except Exception as e:
                last_error = e
                if attempt < self.max_retries - 1:
                    delay = self.retry_delay * (2 ** attempt)
                    logger.warning(f"LLM request failed (attempt {attempt + 1}): {e}, retrying in {delay}s")
                    time.sleep(delay)
                else:
                    raise

        latency = (time.time() - start) * 1000

        # Calculate cost
        pricing = self.PRICING.get(self.deployment, {"input": 0, "output": 0})
        input_cost = (response.usage.prompt_tokens / 1_000_000) * pricing["input"]
        output_cost = (response.usage.completion_tokens / 1_000_000) * pricing["output"]

        return LLMResponse(
            content=response.choices[0].message.content or "",
            model=self.deployment,
            input_tokens=response.usage.prompt_tokens,
            output_tokens=response.usage.completion_tokens,
            cost_usd=input_cost + output_cost,
            latency_ms=latency,
        )

    def stream(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.1,
        max_tokens: int = 1000,
        **kwargs
    ) -> Iterator[str]:
        """
        Stream completion chunks.

        Args:
            messages: List of message dicts
            temperature: Sampling temperature
            max_tokens: Maximum tokens in response

        Yields:
            Content chunks as they arrive
        """
        client = self._get_client()

        response = client.chat.completions.create(
            model=self.deployment,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True,
            **kwargs
        )

        for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content

    def embed(self, texts: List[str]) -> List[List[float]]:
        """
        Generate embeddings for texts.

        Args:
            texts: List of text strings to embed

        Returns:
            List of embedding vectors
        """
        client = self._get_client()

        response = client.embeddings.create(
            model=self.embedding_deployment,
            input=texts,
        )

        return [e.embedding for e in response.data]

    def embed_single(self, text: str) -> List[float]:
        """Generate embedding for a single text."""
        return self.embed([text])[0]


class MockLLMClient(LLMClient):
    """
    Mock LLM client for testing.

    Returns predefined responses without making API calls.
    """

    def __init__(self, default_response: str = "Mock response"):
        self.default_response = default_response
        self.call_history: List[Dict] = []

    def complete(
        self,
        messages: List[Dict[str, str]],
        **kwargs
    ) -> LLMResponse:
        """Return mock response."""
        self.call_history.append({
            'messages': messages,
            'kwargs': kwargs,
        })

        return LLMResponse(
            content=self.default_response,
            model="mock",
            input_tokens=100,
            output_tokens=50,
            cost_usd=0.0,
            latency_ms=10.0,
        )

    def embed(self, texts: List[str]) -> List[List[float]]:
        """Return mock embeddings."""
        import random
        return [[random.random() for _ in range(1536)] for _ in texts]


def get_client(
    provider: str = "azure",
    **kwargs
) -> LLMClient:
    """
    Factory function to get LLM client.

    Args:
        provider: "azure", "bedrock", or "mock"
        **kwargs: Provider-specific arguments

    Returns:
        Configured LLMClient instance
    """
    if provider == "azure":
        return AzureOpenAIClient(**kwargs)
    elif provider == "mock":
        return MockLLMClient(**kwargs)
    elif provider == "bedrock":
        raise NotImplementedError("Bedrock client not yet implemented")
    else:
        raise ValueError(f"Unknown provider: {provider}")
