"""Offline trajectory evals: every case in cases.yaml runs through the real
graph with a scripted model and fake MCP tools. No network, no keys."""
import asyncio
import sys

import pytest

from nuravolt.agent.evals.runner import load_cases, run_case

CASES = load_cases()

# LangGraph interrupts inside async nodes need the run context that only
# Python 3.11+ propagates into tasks; the service and CI run 3.11.
pytestmark = pytest.mark.skipif(sys.version_info < (3, 11), reason="agent graph needs Python 3.11+")


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_case(case):
    res = asyncio.run(run_case(case))
    assert res.ok, "; ".join(res.failures)
