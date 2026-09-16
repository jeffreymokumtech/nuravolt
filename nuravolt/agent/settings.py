"""Runtime configuration for the agent service.

Everything comes from the environment (or a local .env) so the same package
runs as a FastAPI container, a CLI, or under pytest with a fake model.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Literal, Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AgentSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", ".env.local"), env_file_encoding="utf-8", extra="ignore")

    # Product surface the agent consumes (its own MCP server) and the key it uses.
    mcp_url: str = Field(default="http://localhost:3000/api/mcp/mcp", alias="MCP_URL")
    mcp_api_key: Optional[str] = Field(default=None, alias="MCP_API_KEY")
    # docker-compose hands the seeded key over through a file rather than env.
    agent_key_env_file: Optional[str] = Field(default=None, alias="AGENT_KEY_ENV_FILE")
    mcp_timeout_s: float = Field(default=60.0, alias="MCP_TIMEOUT_S")

    # Tenant the service acts for (v1: one org per deployment).
    org_id: str = Field(default="demo_org_alpha1", alias="AGENT_ORG_ID")
    user_id: str = Field(default="agent", alias="AGENT_USER_ID")
    allow_org_override: bool = Field(default=False, alias="AGENT_ALLOW_ORG_OVERRIDE")

    # Durable state.
    database_url: Optional[str] = Field(default=None, alias="DATABASE_URL")
    checkpoint_schema: str = Field(default="agent", alias="AGENT_CHECKPOINT_SCHEMA")

    # Model providers, in precedence order: explicit fake, Bedrock, OpenAI-compatible.
    model_provider: Literal["auto", "bedrock", "openai", "fake"] = Field(default="auto", alias="AGENT_MODEL_PROVIDER")
    bedrock_model_id: str = Field(default="qwen.qwen3-next-80b-a3b", alias="BEDROCK_MODEL_ID")
    aws_region: str = Field(default="eu-west-1", alias="AWS_REGION")
    aws_bearer_token: Optional[str] = Field(default=None, alias="AWS_BEARER_TOKEN_BEDROCK")
    aws_access_key_id: Optional[str] = Field(default=None, alias="AWS_ACCESS_KEY_ID")
    openai_base_url: Optional[str] = Field(default=None, alias="OPENAI_BASE_URL")
    openai_api_key: Optional[str] = Field(default=None, alias="OPENAI_API_KEY")
    openai_model: str = Field(default="qwen2.5:14b", alias="OPENAI_MODEL")
    temperature: float = Field(default=0.0, alias="AGENT_TEMPERATURE")
    max_output_tokens: int = Field(default=2048, alias="AGENT_MAX_OUTPUT_TOKENS")

    # Loop guards.
    max_steps: int = Field(default=8, alias="AGENT_MAX_STEPS")
    max_replans: int = Field(default=2, alias="AGENT_MAX_REPLANS")
    recursion_limit: int = Field(default=40, alias="AGENT_RECURSION_LIMIT")

    # HTTP transport.
    service_token: Optional[str] = Field(default=None, alias="AGENT_SERVICE_TOKEN")
    host: str = Field(default="0.0.0.0", alias="AGENT_HOST")
    port: int = Field(default=8100, alias="AGENT_PORT")

    # Observability.
    langsmith_tracing: bool = Field(default=False, alias="LANGSMITH_TRACING")

    def resolved_mcp_api_key(self) -> Optional[str]:
        """MCP_API_KEY, or the AGENT_MCP_API_KEY line of the seed-written env file."""
        if self.mcp_api_key:
            return self.mcp_api_key
        if self.agent_key_env_file and Path(self.agent_key_env_file).exists():
            for line in Path(self.agent_key_env_file).read_text().splitlines():
                if line.startswith("AGENT_MCP_API_KEY="):
                    return line.split("=", 1)[1].strip() or None
        return os.environ.get("AGENT_MCP_API_KEY") or None

    def has_aws(self) -> bool:
        return bool(self.aws_bearer_token or self.aws_access_key_id or os.environ.get("AWS_PROFILE"))

    def effective_provider(self) -> Literal["bedrock", "openai", "fake"]:
        if self.model_provider != "auto":
            return self.model_provider
        if self.has_aws():
            return "bedrock"
        if self.openai_base_url:
            return "openai"
        return "fake"


def load_settings(**overrides) -> AgentSettings:
    return AgentSettings(**overrides)
