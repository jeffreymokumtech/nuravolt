"""Quality Test Agent - collector.

Reads a YAML suite, drives Playwright for UI cases and `requests` for API
cases, and writes artifacts + a manifest.json into a timestamped run folder
under automation/qa/outputs/. The manifest is what `/qa-judge` consumes.

Usage:
    python -m automation.qa.collect \\
        --cases automation/qa/cases/smoke.yaml \\
        [--base-url http://localhost:3000] \\
        [--filter demo-*] \\
        [--headless/--headed]
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

from automation.qa.case_loader import load_cases

QA_DIR = Path(__file__).parent
OUTPUTS_DIR = QA_DIR / "outputs"
DEFAULT_ACTION_TIMEOUT_MS = 10_000
DEFAULT_API_TIMEOUT_S = 30


def _run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")


def _filter_cases(cases: list[dict[str, Any]], pattern: str | None) -> list[dict[str, Any]]:
    if not pattern:
        return cases
    return [c for c in cases if fnmatch.fnmatch(c["id"], pattern)]


def _api_headers(case: dict[str, Any]) -> dict[str, str]:
    """Case headers + ambient auth.

    QA_SESSION_COOKIE (staging: a Better Auth session cookie captured from a
    signed-in browser) is attached to every request unless the case sets its
    own Cookie. Header values support ${ENV_VAR} interpolation so suites can
    reference tokens (e.g. MCP bearer) without hardcoding secrets in YAML.
    """
    headers: dict[str, str] = {}
    session_cookie = os.getenv("QA_SESSION_COOKIE")
    if session_cookie:
        headers["Cookie"] = session_cookie
    for key, value in (case.get("headers") or {}).items():
        if value.startswith("${") and value.endswith("}"):
            value = os.getenv(value[2:-1], "")
        headers[key] = value
    return headers


def _run_api_case(case: dict[str, Any], base_url: str, run_dir: Path) -> dict[str, Any]:
    url = base_url.rstrip("/") + case["path"]
    method = case.get("method", "GET").upper()
    artifact_name = f"{case['id']}.json"
    meta_name = f"{case['id']}.meta.json"
    started = time.perf_counter()
    meta: dict[str, Any] = {"case_id": case["id"], "type": "api", "url": url, "method": method}
    ok = True
    try:
        resp = requests.request(
            method,
            url,
            headers=_api_headers(case),
            json=case.get("json"),
            timeout=DEFAULT_API_TIMEOUT_S,
        )
        meta["status_code"] = resp.status_code
        # Deterministic assertion: expect_status (int or list) => passed flag.
        expect = case.get("expect_status")
        if expect is not None:
            allowed = expect if isinstance(expect, list) else [expect]
            meta["expect_status"] = allowed
            meta["passed"] = resp.status_code in allowed
            if not meta["passed"]:
                ok = False
        # Try to pretty-print JSON; fall back to raw text
        try:
            body = resp.json()
            (run_dir / artifact_name).write_text(
                json.dumps(body, indent=2, sort_keys=False), encoding="utf-8"
            )
            meta["content_type"] = "application/json"
        except ValueError:
            (run_dir / artifact_name).write_text(resp.text, encoding="utf-8")
            meta["content_type"] = resp.headers.get("content-type", "unknown")
    except Exception as exc:  # noqa: BLE001 - we want to capture any collector failure
        ok = False
        meta["error"] = f"{type(exc).__name__}: {exc}"
        meta["traceback"] = traceback.format_exc()
        # Write an empty artifact so the judge always has a file to read
        (run_dir / artifact_name).write_text("", encoding="utf-8")
    meta["duration_ms"] = int((time.perf_counter() - started) * 1000)
    (run_dir / meta_name).write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return {
        "id": case["id"],
        "type": "api",
        "description": case.get("description", ""),
        "url": url,
        "method": method,
        "rubric": case["rubric"],
        "artifact": artifact_name,
        "meta": meta_name,
        "collector_ok": ok,
        "passed": meta.get("passed"),
        "duration_ms": meta["duration_ms"],
    }


def _session_cookies(base_url: str) -> list[dict[str, Any]]:
    """Parse QA_SESSION_COOKIE ("name=value; name2=value2") into Playwright
    cookie dicts scoped to the base_url host, so `authed: true` UI cases load
    protected /dashboard routes as the signed-in org user."""
    raw = os.getenv("QA_SESSION_COOKIE")
    if not raw:
        return []
    from urllib.parse import urlparse

    host = urlparse(base_url).hostname or "localhost"
    cookies: list[dict[str, Any]] = []
    for pair in raw.split(";"):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        name, value = pair.split("=", 1)
        cookies.append({"name": name.strip(), "value": value.strip(), "domain": host, "path": "/"})
    return cookies


def _evaluate_ui_assertions(case: dict[str, Any], page, meta: dict[str, Any]) -> list[str]:
    """Deterministic pass/fail on top of the screenshot. Returns failures."""
    failures: list[str] = []

    # 1. No forbidden network requests (fixture /data leaks, /demo fetches).
    forbid_requests = case.get("forbid_requests") or []
    if forbid_requests:
        offenders = [
            u for u in meta.get("requests", [])
            if any(pat in u for pat in forbid_requests)
        ]
        meta["forbidden_requests_hit"] = offenders[:15]
        if offenders:
            failures.append(f"{len(offenders)} forbidden request(s), e.g. {offenders[0]}")

    # 2. No forbidden selectors present (e.g. leaked /demo links on /dashboard).
    for sel in case.get("forbid_selectors") or []:
        try:
            n = len(page.query_selector_all(sel))
        except Exception:  # noqa: BLE001
            n = 0
        if n:
            failures.append(f"forbidden selector present ({n}x): {sel}")

    # 3. Required selectors present (page actually rendered its content).
    for sel in case.get("expect_selectors") or []:
        try:
            present = page.query_selector(sel) is not None
        except Exception:  # noqa: BLE001
            present = False
        if not present:
            failures.append(f"expected selector missing: {sel}")

    # 4. Console errors under the threshold, ignoring the benign allowlist.
    allow = case.get("allow_console_substrings") or []
    real_errors = [
        e for e in meta.get("console_errors", [])
        if not any(a in e for a in allow)
    ]
    meta["real_console_errors"] = real_errors[:15]
    max_errors = int(case.get("max_console_errors", 0))
    if len(real_errors) > max_errors:
        failures.append(f"{len(real_errors)} console error(s) > allowed {max_errors}")

    return failures


def _apply_action(page, action: dict[str, Any]) -> None:
    timeout = action.get("timeout", DEFAULT_ACTION_TIMEOUT_MS)
    if "wait_for_selector" in action:
        page.wait_for_selector(action["wait_for_selector"], timeout=timeout)
    elif "click" in action:
        page.click(action["click"], timeout=timeout)
    elif "fill" in action:
        # Expected form: fill: {selector: "#foo", value: "bar"}
        spec = action["fill"]
        page.fill(spec["selector"], spec["value"], timeout=timeout)
    elif "wait_for_timeout" in action:
        page.wait_for_timeout(int(action["wait_for_timeout"]))


def _run_ui_case(
    case: dict[str, Any], base_url: str, run_dir: Path, browser, headless: bool
) -> dict[str, Any]:
    url = base_url.rstrip("/") + case["url"]
    artifact_name = f"{case['id']}.png"
    meta_name = f"{case['id']}.meta.json"
    started = time.perf_counter()
    meta: dict[str, Any] = {
        "case_id": case["id"],
        "type": "ui",
        "url": url,
        "console_errors": [],
        "requests": [],
        "failed_responses": [],
        "headless": headless,
    }
    ok = True

    viewport = case.get("viewport") or {"width": 1440, "height": 900}
    context = browser.new_context(viewport=viewport)
    if case.get("authed"):
        cookies = _session_cookies(base_url)
        if cookies:
            context.add_cookies(cookies)
        else:
            meta.setdefault("warnings", []).append("authed case but QA_SESSION_COOKIE unset")
    page = context.new_page()
    page.on("pageerror", lambda err: meta["console_errors"].append(str(err)))
    page.on(
        "console",
        lambda msg: meta["console_errors"].append(f"{msg.type}: {msg.text}")
        if msg.type == "error"
        else None,
    )
    # Track requests/failed responses for the forbid_requests / leak assertions,
    # ignoring Next's own asset pipeline (never a fixture/demo leak).
    page.on(
        "request",
        lambda req: meta["requests"].append(req.url.replace(base_url, ""))
        if "/_next/" not in req.url
        else None,
    )
    page.on(
        "response",
        lambda resp: meta["failed_responses"].append(f"{resp.status} {resp.url.replace(base_url, '')}")
        if resp.status >= 400 and "/_next/" not in resp.url
        else None,
    )

    assertion_failures: list[str] = []
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        # Settle client-side data fetches (e.g. /api/plants, which drives the
        # asset-gated nav) before asserting. Pages that poll never reach
        # networkidle — that timeout is not a failure, so swallow it.
        try:
            page.wait_for_load_state("networkidle", timeout=15_000)
        except Exception:  # noqa: BLE001
            pass
        for action in case.get("actions", []) or []:
            _apply_action(page, action)
        full_page = case.get("screenshot", "full_page") == "full_page"
        page.screenshot(path=str(run_dir / artifact_name), full_page=full_page)
        assertion_failures = _evaluate_ui_assertions(case, page, meta)
    except Exception as exc:  # noqa: BLE001
        ok = False
        meta["error"] = f"{type(exc).__name__}: {exc}"
        meta["traceback"] = traceback.format_exc()
        # Still attempt a screenshot so the judge can see the broken state
        try:
            page.screenshot(path=str(run_dir / artifact_name), full_page=False)
        except Exception:  # noqa: BLE001
            (run_dir / artifact_name).write_bytes(b"")
    finally:
        context.close()

    # A case with any assertion key gets a deterministic passed flag (like API
    # cases); pure screenshot cases leave it None for the /qa-judge rubric.
    has_assertions = any(
        k in case for k in ("forbid_requests", "forbid_selectors", "expect_selectors", "max_console_errors")
    )
    if has_assertions and ok:
        meta["assertion_failures"] = assertion_failures
        meta["passed"] = len(assertion_failures) == 0
        if not meta["passed"]:
            ok = False
    meta["duration_ms"] = int((time.perf_counter() - started) * 1000)
    (run_dir / meta_name).write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return {
        "id": case["id"],
        "type": "ui",
        "description": case.get("description", ""),
        "url": url,
        "rubric": case["rubric"],
        "artifact": artifact_name,
        "meta": meta_name,
        "collector_ok": ok,
        "passed": meta.get("passed"),
        "duration_ms": meta["duration_ms"],
    }


def run(
    cases_path: Path,
    base_url: str,
    filter_pattern: str | None,
    headless: bool,
) -> Path:
    cases = _filter_cases(load_cases(cases_path), filter_pattern)
    if not cases:
        raise SystemExit(
            f"No cases matched filter={filter_pattern!r} in {cases_path}"
        )

    needs_browser = any(c["type"] == "ui" for c in cases)

    run_id = _run_id()
    run_dir = OUTPUTS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    manifest_cases: list[dict[str, Any]] = []

    if needs_browser:
        try:
            from playwright.sync_api import sync_playwright  # noqa: WPS433
        except ImportError:
            sys.exit(
                "Playwright is not installed. Run:\n"
                "  pip install -r automation/requirements.txt\n"
                "  playwright install chromium"
            )

        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(headless=headless)
            except Exception as exc:  # noqa: BLE001
                sys.exit(
                    f"Failed to launch chromium: {exc}\n"
                    "Hint: `playwright install chromium`"
                )
            try:
                for case in cases:
                    if case["type"] == "ui":
                        print(f"[ui]  {case['id']} -> {case['url']}", flush=True)
                        manifest_cases.append(
                            _run_ui_case(case, base_url, run_dir, browser, headless)
                        )
                    else:
                        print(f"[api] {case['id']} -> {case['path']}", flush=True)
                        manifest_cases.append(_run_api_case(case, base_url, run_dir))
            finally:
                browser.close()
    else:
        for case in cases:
            print(f"[api] {case['id']} -> {case['path']}", flush=True)
            manifest_cases.append(_run_api_case(case, base_url, run_dir))

    manifest = {
        "run_id": run_id,
        "base_url": base_url,
        "cases_file": str(cases_path),
        "filter": filter_pattern,
        "cases": manifest_cases,
    }
    (run_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )

    # Write a latest symlink (best-effort; POSIX only)
    latest = OUTPUTS_DIR / "latest"
    try:
        if latest.is_symlink() or latest.exists():
            latest.unlink()
        latest.symlink_to(run_id)
    except OSError:
        pass  # symlinks not supported; /qa-judge can still find latest by mtime

    print(f"\nRun complete: {run_dir}")
    print(f"Artifacts: {len(manifest_cases)}")
    collector_failures = [c["id"] for c in manifest_cases if not c["collector_ok"]]
    if collector_failures:
        print(f"Collector failures (network/timeout): {collector_failures}")
    assertion_failures = [c["id"] for c in manifest_cases if c.get("passed") is False]
    asserted = [c for c in manifest_cases if c.get("passed") is not None]
    if asserted:
        print(f"Status assertions: {len(asserted) - len(assertion_failures)}/{len(asserted)} passed")
    if assertion_failures:
        print(f"FAILED expect_status: {assertion_failures}")
    print(f"Next: run /qa-judge  (or: /qa-judge {run_id})")
    return run_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ShamsIQ QA collector")
    parser.add_argument(
        "--cases",
        type=Path,
        default=QA_DIR / "cases" / "smoke.yaml",
        help="Path to the YAML case suite",
    )
    parser.add_argument(
        "--base-url",
        default=os.getenv("QA_BASE_URL", "http://localhost:3000"),
        help="Base URL of the app under test (default: QA_BASE_URL env or localhost:3000)",
    )
    parser.add_argument(
        "--filter",
        default=None,
        help="glob pattern on case id, e.g. 'api-*' or 'demo-portfolio'",
    )
    headless_group = parser.add_mutually_exclusive_group()
    headless_group.add_argument("--headless", dest="headless", action="store_true")
    headless_group.add_argument("--headed", dest="headless", action="store_false")
    parser.set_defaults(headless=True)

    args = parser.parse_args(argv)
    run_dir = run(
        cases_path=args.cases,
        base_url=args.base_url,
        filter_pattern=args.filter,
        headless=args.headless,
    )
    # Deterministic exit for CI: any failed expect_status assertion is nonzero.
    manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
    if any(c.get("passed") is False for c in manifest["cases"]):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
