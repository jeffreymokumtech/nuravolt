"""YAML case loader with schema validation.

Cases are loaded into plain dicts (no dataclasses) so they serialize straight
into `manifest.json` without extra conversion. Validation is intentionally
strict: unknown keys or missing required keys raise immediately, because a
typo in a rubric silently makes a test meaningless.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

UI_REQUIRED = {"id", "type", "url", "rubric"}
UI_OPTIONAL = {
    "description",
    "actions",
    "screenshot",
    "viewport",
    # --- deterministic assertions (turn a screenshot case into pass/fail) ---
    "authed",                # attach QA_SESSION_COOKIE so /dashboard loads as the org user
    "forbid_requests",       # list[str]: FAIL if any network request URL contains one (e.g. "/data/", "/demo")
    "forbid_selectors",      # list[str]: FAIL if any element matches (e.g. 'a[href^="/demo"]')
    "expect_selectors",      # list[str]: FAIL if any of these selectors is absent
    "max_console_errors",    # int (default 0): FAIL above this many non-allowlisted console errors
    "allow_console_substrings",  # list[str]: console errors containing one of these are ignored (known-benign)
}
API_REQUIRED = {"id", "type", "path", "rubric"}
API_OPTIONAL = {"description", "method", "headers", "json", "expect_status"}

_STR_LIST_KEYS = ("forbid_requests", "forbid_selectors", "expect_selectors", "allow_console_substrings")

API_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}

ALLOWED_ACTIONS = {"wait_for_selector", "click", "fill", "wait_for_timeout"}


class CaseValidationError(ValueError):
    """Raised when a case file fails schema validation."""


def load_cases(path: Path) -> list[dict[str, Any]]:
    """Load and validate a YAML suite file.

    Returns the list of case dicts. Raises CaseValidationError on any
    malformed case.
    """
    with path.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    if not isinstance(raw, list) or not raw:
        raise CaseValidationError(
            f"{path}: expected a non-empty YAML list of cases at the top level"
        )

    seen_ids: set[str] = set()
    cases: list[dict[str, Any]] = []
    for idx, case in enumerate(raw):
        if not isinstance(case, dict):
            raise CaseValidationError(f"{path}: case #{idx} is not a mapping")
        _validate_case(case, idx, path)
        if case["id"] in seen_ids:
            raise CaseValidationError(
                f"{path}: duplicate case id '{case['id']}'"
            )
        seen_ids.add(case["id"])
        cases.append(case)

    return cases


def _validate_case(case: dict[str, Any], idx: int, path: Path) -> None:
    ctype = case.get("type")
    if ctype == "ui":
        required, optional = UI_REQUIRED, UI_OPTIONAL
    elif ctype == "api":
        required, optional = API_REQUIRED, API_OPTIONAL
    else:
        raise CaseValidationError(
            f"{path}: case #{idx} has invalid type={ctype!r} (expected 'ui' or 'api')"
        )

    missing = required - case.keys()
    if missing:
        raise CaseValidationError(
            f"{path}: case #{idx} ({case.get('id', '?')}) missing required keys: {sorted(missing)}"
        )

    unknown = case.keys() - (required | optional)
    if unknown:
        raise CaseValidationError(
            f"{path}: case #{idx} ({case['id']}) has unknown keys: {sorted(unknown)}"
        )

    if ctype == "ui":
        actions = case.get("actions", [])
        if not isinstance(actions, list):
            raise CaseValidationError(
                f"{path}: case {case['id']} actions must be a list"
            )
        for ai, action in enumerate(actions):
            if not isinstance(action, dict) or not action:
                raise CaseValidationError(
                    f"{path}: case {case['id']} action #{ai} must be a non-empty mapping"
                )
            primary = set(action.keys()) & ALLOWED_ACTIONS
            if len(primary) != 1:
                raise CaseValidationError(
                    f"{path}: case {case['id']} action #{ai} must have exactly one "
                    f"of {sorted(ALLOWED_ACTIONS)}, got keys {sorted(action.keys())}"
                )
            extra = action.keys() - primary - {"timeout"}
            if extra:
                raise CaseValidationError(
                    f"{path}: case {case['id']} action #{ai} has unknown keys: "
                    f"{sorted(extra)} (only 'timeout' is allowed alongside the action)"
                )

        # Assertion keys must be well-typed so a typo fails loudly, not silently.
        for key in _STR_LIST_KEYS:
            val = case.get(key)
            if val is not None and not (
                isinstance(val, list) and all(isinstance(v, str) for v in val)
            ):
                raise CaseValidationError(
                    f"{path}: case {case['id']} {key} must be a list of strings"
                )
        if "authed" in case and not isinstance(case["authed"], bool):
            raise CaseValidationError(f"{path}: case {case['id']} authed must be a boolean")
        if "max_console_errors" in case and not isinstance(case["max_console_errors"], int):
            raise CaseValidationError(
                f"{path}: case {case['id']} max_console_errors must be an integer"
            )

    if ctype == "api":
        method = case.get("method", "GET").upper()
        if method not in API_METHODS:
            raise CaseValidationError(
                f"{path}: case {case['id']} method={method!r} - expected one of {sorted(API_METHODS)}"
            )
        headers = case.get("headers")
        if headers is not None and not (
            isinstance(headers, dict) and all(isinstance(v, str) for v in headers.values())
        ):
            raise CaseValidationError(
                f"{path}: case {case['id']} headers must be a string->string mapping"
            )
        expect = case.get("expect_status")
        if expect is not None:
            values = expect if isinstance(expect, list) else [expect]
            if not all(isinstance(v, int) and 100 <= v <= 599 for v in values):
                raise CaseValidationError(
                    f"{path}: case {case['id']} expect_status must be an HTTP status int or list of ints"
                )
