"""Pure routing functions and guard rails, no model involved."""
from nuravolt.agent.graph import route_after_classify, route_after_plan, route_execute
from nuravolt.agent.nodes.verify import route_after_verify
from nuravolt.agent.tools.mcp_client import WRITE_TOOLS, check_write_coverage, idempotency_key, is_write_tool


def step(i, tool, is_write=False, status="pending"):
    return {"id": i, "goal": "g", "tool": tool, "args": {}, "is_write": is_write, "status": status, "result_ref": None}


def test_chitchat_and_out_of_scope_skip_planning():
    assert route_after_classify({"intent": "chitchat"}) == "synthesize"
    assert route_after_classify({"intent": "out_of_scope"}) == "synthesize"
    assert route_after_classify({"intent": "question"}) == "plan"


def test_empty_plan_goes_straight_to_answer():
    assert route_after_plan({"plan": []}) == "synthesize"
    assert route_after_plan({"plan": [step(1, "nuravolt_list_plants")]}) == "execute_step"


def test_writes_are_routed_to_approval_until_approved():
    st = {"plan": [step(1, "nuravolt_create_ticket", is_write=True)], "current_step": 0}
    assert route_execute(st) == "request_approval"
    st["plan"][0]["status"] = "approved"
    assert route_execute(st) == "execute_step"
    assert route_execute({"plan": [step(1, "nuravolt_list_plants")], "current_step": 0}) == "execute_step"


def test_verify_routing_follows_last_verdict_then_cursor():
    plan = [step(1, "a", status="done"), step(2, "b")]
    assert route_after_verify({"plan": plan, "current_step": 1, "verdicts": [{"step_id": 1, "passed": True, "reason": "", "action": "continue"}]}) == "execute_step"
    assert route_after_verify({"plan": plan, "current_step": 2, "verdicts": [{"step_id": 2, "passed": True, "reason": "", "action": "continue"}]}) == "synthesize"
    assert route_after_verify({"plan": plan, "current_step": 1, "verdicts": [{"step_id": 1, "passed": False, "reason": "", "action": "replan"}]}) == "plan"
    assert route_after_verify({"plan": plan, "current_step": 1, "verdicts": [{"step_id": 1, "passed": False, "reason": "", "action": "retry_step"}]}) == "retry"
    assert route_after_verify({"plan": plan, "current_step": 1, "verdicts": [{"step_id": 1, "passed": True, "reason": "", "action": "finish"}]}) == "synthesize"


def test_skipped_steps_are_jumped_over():
    plan = [step(1, "a", status="done"), step(2, "nuravolt_create_ticket", is_write=True, status="skipped")]
    assert route_after_verify({"plan": plan, "current_step": 1, "verdicts": [{"step_id": 1, "passed": True, "reason": "", "action": "continue"}]}) == "synthesize"


def test_write_tool_set_is_explicit_and_complete():
    assert is_write_tool("nuravolt_create_ticket")
    assert not is_write_tool("nuravolt_list_plants")
    assert check_write_coverage(list(WRITE_TOOLS) + ["nuravolt_list_plants"]) == []
    assert check_write_coverage(["nuravolt_create_widget"]) == ["nuravolt_create_widget"]


def test_idempotency_key_is_stable_per_step_and_args():
    a = idempotency_key("t1", 3, {"x": 1, "y": "z"})
    assert a == idempotency_key("t1", 3, {"y": "z", "x": 1})
    assert a != idempotency_key("t1", 4, {"x": 1, "y": "z"})
    assert len(a) <= 64
