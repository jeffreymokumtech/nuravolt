import asyncio

from langgraph.store.memory import InMemoryStore

from nuravolt.agent.memory import accept, fact_key, load_facts, render_facts, save_facts
from nuravolt.agent.models import call_structured
from nuravolt.agent.settings import AgentSettings
from nuravolt.agent.state import MemoryFact, IntentOut
from nuravolt.agent.telemetry import estimate_cost_usd, price_for
from nuravolt.agent.evals.fake_model import ScriptedChatModel


def test_provider_resolution_prefers_bedrock_then_openai_then_fake(monkeypatch):
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    assert AgentSettings(AGENT_MODEL_PROVIDER="auto", AWS_BEARER_TOKEN_BEDROCK="x", OPENAI_BASE_URL="http://o").effective_provider() == "bedrock"
    assert AgentSettings(AGENT_MODEL_PROVIDER="auto", OPENAI_BASE_URL="http://o", AWS_BEARER_TOKEN_BEDROCK=None, AWS_ACCESS_KEY_ID=None).effective_provider() == "openai"
    assert AgentSettings(AGENT_MODEL_PROVIDER="auto", AWS_BEARER_TOKEN_BEDROCK=None, AWS_ACCESS_KEY_ID=None, OPENAI_BASE_URL=None).effective_provider() == "fake"


def test_memory_keys_are_stable_and_low_confidence_dropped():
    good = MemoryFact(kind="nickname", subject="Kilima Solar", value="the big one", confidence=0.9)
    weak = MemoryFact(kind="preference", subject="units", value="MWh", confidence=0.3)
    assert fact_key(good) == "nickname:kilima_solar"
    assert accept([good, weak]) == [good]


def test_memory_round_trip_and_rendering():
    store = InMemoryStore()
    fact = MemoryFact(kind="nickname", subject="kilima-solar", value="the big one", confidence=0.9)
    keys = asyncio.run(save_facts(store, "org1", [fact]))
    assert keys == ["nickname:kilima_solar"]
    facts = asyncio.run(load_facts(store, "org1"))
    assert facts[0]["value"] == "the big one"
    assert "the big one" in render_facts(facts)
    assert asyncio.run(load_facts(store, "org2")) == []


def test_call_structured_retries_once_on_bad_output():
    attempts = []

    def answer(_messages):
        attempts.append(1)
        return {"intent": "nope"} if len(attempts) == 1 else {"intent": "question", "needs_tools": True}

    model = ScriptedChatModel(script={"IntentOut": answer}, calls=[])
    out = call_structured(model, IntentOut, system="s", user="u")
    assert out.intent == "question" and len(attempts) == 2


def test_pricing_mirrors_the_web_table():
    assert price_for("qwen.qwen3-next-80b-a3b") == (0.15, 1.20)
    assert estimate_cost_usd("qwen.qwen3-next-80b-a3b", 1_000_000, 0) == 0.15
