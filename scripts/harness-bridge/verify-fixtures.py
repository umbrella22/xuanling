#!/usr/bin/env python3
"""Integrity oracle for the crates/xuanling-harness-bridge W0 contracts and fixtures.

Checks, in order, stopping at the first failure:

1. Every contract JSON parses.
2. tools.json exposes exactly the four controller tools and the stable error codes.
3. final-result.schema.json matches the FinalResult contract in src/jobs.rs.
4. report-format.json fixes the version-1 Markdown header and body rules.
5. adapters.json records fixed argv, prompt transport, terminal success and
   live-success status (Codex and ZCode are verified).
6. host-capabilities.json records the stdio transport, wait semantics and an
   unverified W3 journey for each controller host.
7. manifest.json has the required shape and deterministic order.
8. Every referenced file exists and matches its recorded sha256.
9. Every stdout/stderr stream parses according to its declared format.
10. Each fixture carries the expected native terminal signal, and the derived
    outcome matches expected_status/expected_error_code.
11. No captured or derived fixture contains an obvious live secret. Documented
    placeholders are allowed.

Python 3 standard library only.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
BRIDGE_ROOT = REPO_ROOT / "crates" / "xuanling-harness-bridge"
CONTRACTS_DIR = BRIDGE_ROOT / "contracts"
FIXTURES_DIR = BRIDGE_ROOT / "tests" / "fixtures"
MANIFEST_PATH = FIXTURES_DIR / "manifest.json"

CONTRACT_FILES = [
    "tools.json",
    "final-result.schema.json",
    "report-format.json",
    "adapters.json",
    "host-capabilities.json",
]

TOOL_NAMES = ["harness_health", "harness_submit", "harness_wait", "harness_cancel"]
ADAPTER_IDS = ["codex", "claude", "dsh", "zcode"]
TERMINAL_STATUSES = [
    "completed",
    "failed",
    "cancelled",
    "timed_out",
    "needs_input",
    "interrupted",
]
FIXTURE_KINDS = ["success", "failure", "missing_frame", "needs_input", "malformed"]
STREAM_FORMATS = ["ndjson", "json", "text", "empty"]

# Exact order and spelling from crates/xuanling-harness-bridge/src/error.rs ErrorCode.
ERROR_CODES = [
    "INVALID_REQUEST",
    "UNKNOWN_TOOL",
    "INSTANCE_CHANGED",
    "REQUEST_CONFLICT",
    "BUSY",
    "MEMORY_CAPACITY",
    "PATH_OUTSIDE_ROOT",
    "TASK_READ_FAILED",
    "ADAPTER_UNAVAILABLE",
    "INCOMPATIBLE_CLI",
    "AUTH_REQUIRED",
    "RATE_LIMIT",
    "WORKER_FAILED",
    "NEEDS_INPUT",
    "STREAM_INCOMPLETE",
    "SPAWN_FAILED",
    "CLEANUP_UNCONFIRMED",
    "JOB_NOT_FOUND",
    "JOB_CONTEXT_LOST",
    "RESULT_TOO_LARGE",
    "REPORT_WRITE_FAILED",
    "SENSITIVE_PAYLOAD",
    "CONFIG_INVALID",
    "DEADLINE_EXCEEDED",
    "INTERRUPTED",
]

# Exact required list and optional fields from crates/xuanling-harness-bridge/src/jobs.rs FinalResult.
REQUIRED_FINAL_FIELDS = [
    "job_id",
    "instance_id",
    "request_id",
    "harness",
    "adapter_version",
    "status",
    "output_complete",
    "redacted",
    "cleanup",
    "started_at",
    "finished_at",
]
OPTIONAL_FINAL_FIELDS = [
    "worker_final_output",
    "exit_code",
    "error",
    "delivery_error",
    "report_path",
    "report_error",
]

# Header render order from crates/xuanling-harness-bridge/src/report.rs.
REPORT_FIELDS = [
    "format_version",
    "job_id",
    "harness",
    "adapter_version",
    "status",
    "started_at",
    "finished_at",
    "exit_code",
    "output_complete",
    "redacted",
    "cleanup_confirmed",
    "report_is_data",
]

EXPECTED_MANIFEST_KEYS = ["schema_version", "fixture_root", "path_base", "entries"]
EXPECTED_ENTRY_KEYS = [
    "id",
    "adapter",
    "kind",
    "derived",
    "provenance",
    "cli_version",
    "argv",
    "exit_code",
    "stdout",
    "stderr",
    "expected_status",
    "expected_error_code",
]
EXPECTED_STREAM_KEYS = ["path", "sha256", "format"]
FORMAT_SUFFIX = {
    "ndjson": ".ndjson",
    "json": ".json",
    "text": ".stderr",
    "empty": ".stdout",
}

HOST_IDS = ["codex", "claude-code", "dsh", "zcode", "trae"]
HOST_NAMES = ["Codex", "Claude Code", "DSH", "ZCode", "Trae"]
HOST_JOURNEY = {
    "verified": False,
    "status": "not_run",
    "reason": "W3 requires an independent host profile; not executed in this environment",
}

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

SECRET_PATTERNS = [
    ("OpenAI-style key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")),
    ("Bearer token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE)),
    ("32+ character hex token", re.compile(r"\b[0-9a-fA-F]{32,}\b")),
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
]
PLACEHOLDER_MARKERS = (
    "redacted",
    "placeholder",
    "example",
    "synthetic",
    "sample",
    "fake",
    "dummy",
)

AUTH_MARKERS = ("auth", "unauthorized", "credential", "insufficient account balance", "401", "403")
RATE_MARKERS = ("rate limit", "ratelimit", "too many requests", "429")
INPUT_MARKERS = (
    "needs_input",
    "needs input",
    "requires approval",
    "approval required",
    "permission required",
)


CHECKS_RUN = 0


class CheckFailed(Exception):
    """A single verification check failed."""


def fail(message: str) -> None:
    raise CheckFailed(message)


def expect(condition: Any, message: str) -> None:
    if not condition:
        fail(message)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(BRIDGE_ROOT))
    except ValueError:
        return str(path)


def run(name: str, check) -> None:
    global CHECKS_RUN
    try:
        check()
    except CheckFailed as exc:
        print(f"FAIL {name}: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
    except Exception as exc:  # noqa: BLE001 - one clear diagnostic, then exit
        print(f"FAIL {name}: unexpected {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
    CHECKS_RUN += 1
    print(f"PASS {name}", flush=True)


def load_json(path: Path) -> Any:
    expect(path.is_file(), f"missing file: {rel(path)}")
    text = path.read_text(encoding="utf-8")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        fail(f"{rel(path)} is not valid JSON: {exc}")


# ---------------------------------------------------------------------------
# Contract checks
# ---------------------------------------------------------------------------


def load_contract(state: dict[str, Any], name: str) -> None:
    state[name] = load_json(CONTRACTS_DIR / name)


def check_tools(state: dict[str, Any]) -> None:
    tools = state["tools.json"]
    expect(isinstance(tools, dict), "tools.json must be a JSON object")
    expect(tools.get("contract_version") == 1, "contract_version must be 1")
    expect(tools.get("transport") == "mcp_stdio", "transport must be mcp_stdio")

    tool_list = tools.get("tools")
    expect(isinstance(tool_list, list), "tools must be an array")
    names = [tool.get("name") if isinstance(tool, dict) else None for tool in tool_list]
    expect(
        names == TOOL_NAMES,
        f"tool names/order must be exactly {TOOL_NAMES}, got {names}",
    )

    by_name: dict[str, dict[str, Any]] = {}
    for tool in tool_list:
        name = tool["name"]
        by_name[name] = tool
        schema = tool.get("input_schema")
        expect(isinstance(schema, dict), f"{name}: input_schema must be an object")
        expect(schema.get("type") == "object", f"{name}: input_schema.type must be object")
        expect(
            schema.get("additionalProperties") is False,
            f"{name}: input_schema must reject unknown fields (additionalProperties=false)",
        )
        expect(isinstance(schema.get("required"), list), f"{name}: input_schema.required must be an array")
        expect(isinstance(schema.get("properties"), dict), f"{name}: input_schema.properties must be an object")

        parameters = tool.get("parameters")
        expect(isinstance(parameters, list), f"{name}: parameters must be an array")
        required = [param["name"] for param in parameters if param.get("required") is True]
        expect(
            sorted(required) == sorted(schema["required"]),
            f"{name}: parameters and input_schema disagree on required fields "
            f"({required} vs {schema['required']})",
        )
        for param in parameters:
            expect(
                param.get("name") in schema["properties"],
                f"{name}: parameter {param.get('name')!r} is missing from input_schema.properties",
            )
            expect(
                isinstance(param.get("type"), str) and param["type"],
                f"{name}: parameter {param.get('name')!r} needs a type",
            )

    health = by_name["harness_health"]
    expect(health["input_schema"]["required"] == [], "harness_health takes no required parameters")
    expect(health["input_schema"]["properties"] == {}, "harness_health takes no parameters")

    submit = by_name["harness_submit"]["input_schema"]
    expect(
        submit["required"] == ["instance_id", "request_id", "adapter", "workspace_id"],
        f"harness_submit required must be [instance_id, request_id, adapter, workspace_id], got {submit['required']}",
    )
    one_of = submit.get("oneOf")
    expect(isinstance(one_of, list) and len(one_of) == 2, "harness_submit needs a two-branch oneOf")
    branches = sorted(tuple(branch.get("required", [])) for branch in one_of)
    expect(
        branches == [("prompt",), ("task_file",)],
        f"harness_submit must require exactly one of prompt/task_file, got {branches}",
    )
    expect(
        submit["properties"]["save_result"].get("default") is False,
        "harness_submit save_result must default to false",
    )
    expect(
        submit["properties"]["adapter"].get("enum") == ADAPTER_IDS,
        f"harness_submit adapter enum must be {ADAPTER_IDS}",
    )

    wait = by_name["harness_wait"]["input_schema"]
    expect(wait["required"] == ["job_id"], "harness_wait must require job_id")
    expect("wait_ms" in wait["properties"], "harness_wait must declare wait_ms")
    expect(wait["properties"]["wait_ms"].get("type") == "integer", "wait_ms must be an integer")
    expect("wait_ms" not in wait["required"], "wait_ms must be optional")

    cancel = by_name["harness_cancel"]["input_schema"]
    expect(cancel["required"] == ["job_id"], "harness_cancel must require job_id")
    expect(set(cancel["properties"]) == {"job_id"}, "harness_cancel must accept only job_id")

    error_codes = tools.get("error_codes")
    expect(isinstance(error_codes, dict), "error_codes must be an object")
    expect(
        list(error_codes) == ERROR_CODES,
        f"error code set/order must match src/error.rs ({len(ERROR_CODES)} codes), got {list(error_codes)}",
    )
    for code, description in error_codes.items():
        expect(
            isinstance(description, str) and description.strip(),
            f"error code {code} needs a non-empty description",
        )


def check_final_result_schema(state: dict[str, Any]) -> None:
    schema = state["final-result.schema.json"]
    expect(isinstance(schema, dict), "final-result schema must be a JSON object")
    expect(
        schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema",
        "final-result schema must be JSON Schema draft 2020-12",
    )
    expect(schema.get("type") == "object", "final-result schema type must be object")
    expect(schema.get("additionalProperties") is False, "final-result schema must be closed")
    expect(
        schema.get("required") == REQUIRED_FINAL_FIELDS,
        f"required fields must be {REQUIRED_FINAL_FIELDS}, got {schema.get('required')}",
    )

    properties = schema.get("properties")
    expect(isinstance(properties, dict), "properties must be an object")
    expected_properties = set(REQUIRED_FINAL_FIELDS) | set(OPTIONAL_FINAL_FIELDS)
    expect(
        set(properties) == expected_properties,
        f"property set mismatch: extra={sorted(set(properties) - expected_properties)}, "
        f"missing={sorted(expected_properties - set(properties))}",
    )
    for field in OPTIONAL_FINAL_FIELDS:
        expect(field not in schema["required"], f"{field} is optional in FinalResult and must not be required")

    expect(
        properties["status"].get("enum") == TERMINAL_STATUSES,
        f"status enum must be {TERMINAL_STATUSES}, got {properties['status'].get('enum')}",
    )
    expect(properties["output_complete"].get("type") == "boolean", "output_complete must be boolean")
    expect(properties["redacted"].get("type") == "boolean", "redacted must be boolean")
    expect(
        properties["started_at"].get("format") == "date-time",
        "started_at must be an RFC3339 date-time",
    )
    expect(
        properties["finished_at"].get("format") == "date-time",
        "finished_at must be an RFC3339 date-time",
    )

    defs = schema.get("$defs")
    expect(isinstance(defs, dict), "$defs must be an object")
    expect(
        defs.get("cleanup", {}).get("required") == ["confirmed"],
        "cleanup must require confirmed",
    )
    expect(
        defs.get("result_error", {}).get("required") == ["code", "message"],
        "result_error must require code and message",
    )


def check_report_format(state: dict[str, Any]) -> None:
    report = state["report-format.json"]
    expect(isinstance(report, dict), "report-format must be a JSON object")
    expect(report.get("format_version") == 1, "report format_version must be 1")

    header = report.get("header")
    expect(isinstance(header, dict), "report header must be an object")
    expect(header.get("syntax") == "yaml_front_matter", "report header must be YAML front matter")
    fields = header.get("fields")
    expect(isinstance(fields, list), "report header.fields must be an array")
    field_names = [field.get("name") for field in fields]
    expect(field_names == REPORT_FIELDS, f"header fields must be {REPORT_FIELDS}, got {field_names}")
    expect(
        header.get("field_order") == REPORT_FIELDS,
        "header.field_order must match the rendered header order",
    )
    for field in fields:
        expect(isinstance(field.get("type"), str), f"header field {field.get('name')!r} needs a type")
        expect(field.get("required") is True, f"header field {field.get('name')!r} must be required")

    body = report.get("body")
    expect(isinstance(body, dict), "report body must be an object")
    sections = body.get("sections")
    expect(isinstance(sections, list) and sections, "report body.sections must be a non-empty array")
    headings = [section.get("heading") for section in sections]
    expect(headings[0] == "## Worker final answer", "first body section must be the worker final answer")
    expect("## Failure diagnostic" in headings, "body must define the failure diagnostic section")
    expect("## Delivery diagnostic" in headings, "body must define the delivery diagnostic section")
    expect(isinstance(body.get("rules"), list) and body["rules"], "report body.rules must be non-empty")


def check_adapters(state: dict[str, Any]) -> None:
    contract = state["adapters.json"]
    expect(isinstance(contract, dict), "adapters.json must be an object")
    expect(contract.get("contract_version") == 1, "adapters contract_version must be 1")
    adapters = contract.get("adapters")
    expect(isinstance(adapters, list), "adapters must be an array")
    ids = [adapter.get("id") for adapter in adapters]
    expect(ids == ADAPTER_IDS, f"adapter ids/order must be {ADAPTER_IDS}, got {ids}")

    expected_prompt_transport = {"codex": "stdin", "claude": "stdin", "dsh": "stdin", "zcode": "argv"}
    expected_needs_input = {"codex": False, "claude": True, "dsh": True, "zcode": False}
    expected_live_success = {
        "codex": "verified",
        "claude": "blocked_missing_credentials",
        "dsh": "blocked_missing_credentials",
        "zcode": "verified",
    }
    expected_required_env = {
        "codex": [],
        "claude": [],
        "dsh": [],
        "zcode": [
            "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
            "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
        ],
    }

    for adapter in adapters:
        adapter_id = adapter["id"]
        template = adapter.get("argv_template")
        expect(
            isinstance(template, list) and template and all(isinstance(arg, str) and arg for arg in template),
            f"{adapter_id}: argv_template must be a non-empty array of strings",
        )
        expect(
            adapter.get("prompt_transport") == expected_prompt_transport[adapter_id],
            f"{adapter_id}: prompt_transport must be {expected_prompt_transport[adapter_id]}",
        )
        capabilities = adapter.get("capabilities")
        expect(isinstance(capabilities, dict), f"{adapter_id}: capabilities must be an object")
        expect(capabilities.get("non_interactive") is True, f"{adapter_id}: must declare non_interactive")
        expect(
            capabilities.get("needs_input") is expected_needs_input[adapter_id],
            f"{adapter_id}: needs_input must be {expected_needs_input[adapter_id]}",
        )
        terminal = adapter.get("terminal_success")
        expect(isinstance(terminal, dict), f"{adapter_id}: terminal_success must be an object")
        expect(
            isinstance(terminal.get("rule"), str) and terminal["rule"].strip(),
            f"{adapter_id}: terminal_success.rule must be non-empty",
        )
        expect(
            isinstance(terminal.get("required_signals"), list) and terminal["required_signals"],
            f"{adapter_id}: terminal_success.required_signals must be non-empty",
        )
        observed_version = adapter.get("observed_version")
        expect(
            isinstance(observed_version, str) and observed_version.strip(),
            f"{adapter_id}: observed_version must be recorded",
        )
        expect(
            adapter.get("required_env") == expected_required_env[adapter_id],
            f"{adapter_id}: required_env must be {expected_required_env[adapter_id]}, "
            f"got {adapter.get('required_env')!r}",
        )

        live = adapter.get("live_success")
        expect(
            isinstance(live, str),
            f"{adapter_id}: live_success must be the string status, got {type(live).__name__}",
        )
        expect(
            live == expected_live_success[adapter_id],
            f"{adapter_id}: live_success must be {expected_live_success[adapter_id]}, got {live!r}",
        )
        evidence = adapter.get("live_success_evidence")
        expect(isinstance(evidence, dict), f"{adapter_id}: live_success_evidence must be an object")
        if live == "verified":
            expect(evidence.get("observed_exit_code") == 0, f"{adapter_id}: verified success must record exit 0")
            expect(
                isinstance(evidence.get("observed_final_text"), str)
                and evidence["observed_final_text"].strip(),
                f"{adapter_id}: verified success must record the observed final text",
            )
        else:
            expect(
                isinstance(evidence.get("observed_error"), str) and evidence["observed_error"].strip(),
                f"{adapter_id}: blocked live success must record the exact observed error",
            )
            expect(
                isinstance(evidence.get("blocker"), str) and evidence["blocker"].strip(),
                f"{adapter_id}: blocked live success must record the blocker",
            )
            expect(
                adapter.get("success_verified_version") is None,
                f"{adapter_id}: must not claim a verified success version",
            )
            if adapter_id == "zcode":
                additional = evidence.get("additional_observed_errors")
                expect(
                    isinstance(additional, list) and additional,
                    "zcode: the additional provider-config failure must be recorded",
                )
                joined = json.dumps(additional, ensure_ascii=False)
                expect(
                    "无法定位 CLI ZCode Built-in Provider Config" in joined,
                    "zcode: the observed provider-config error text must be recorded verbatim",
                )
                expect(
                    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE" in joined
                    and "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" in joined,
                    "zcode: the provider-config failure must name both required_env variables",
                )


def check_host_capabilities(state: dict[str, Any]) -> None:
    contract = state["host-capabilities.json"]
    expect(isinstance(contract, dict), "host-capabilities.json must be an object")
    transport = contract.get("transport")
    expect(isinstance(transport, dict), "transport must be an object")
    expect(transport.get("type") == "mcp_stdio", "transport.type must be mcp_stdio")
    expect(
        transport.get("server_tools") == TOOL_NAMES,
        f"transport.server_tools must be exactly {TOOL_NAMES}",
    )

    wait = contract.get("wait_semantics")
    expect(isinstance(wait, dict), "wait_semantics must be an object")
    expect(wait.get("host_wakeup_on_completion") is False, "no host wake-up may be claimed")
    expect(wait.get("completion_notification") is False, "no completion notification may be claimed")
    expect(wait.get("notification_replay") is False, "no notification replay may be claimed")
    expect(wait.get("durable_job_recovery") is False, "no durable job recovery may be claimed")
    expect(wait.get("wait_cancel_keeps_job") is True, "wait cancellation must keep the job")
    expect(wait.get("wait_end_does_not_stop_worker") is True, "wait expiry must not stop the worker")
    expect(wait.get("default_task_deadline") is None, "there must be no default task deadline")

    hosts = contract.get("hosts")
    expect(isinstance(hosts, list), "hosts must be an array")
    expect([host.get("id") for host in hosts] == HOST_IDS, f"host ids must be {HOST_IDS}")
    expect([host.get("name") for host in hosts] == HOST_NAMES, f"host names must be {HOST_NAMES}")
    for host in hosts:
        expect(host.get("role") == "controller", f"{host['id']}: role must be controller")
        expect(
            host.get("journey") == HOST_JOURNEY,
            f"{host['id']}: unverified journey must be exactly {HOST_JOURNEY}, got {host.get('journey')}",
        )


# ---------------------------------------------------------------------------
# Manifest checks
# ---------------------------------------------------------------------------


def check_manifest_shape(state: dict[str, Any]) -> None:
    manifest = load_json(MANIFEST_PATH)
    state["manifest"] = manifest
    expect(isinstance(manifest, dict), "manifest must be a JSON object")
    expect(
        list(manifest.keys()) == EXPECTED_MANIFEST_KEYS,
        f"manifest keys must be {EXPECTED_MANIFEST_KEYS}, got {list(manifest.keys())}",
    )
    expect(manifest["schema_version"] == 1, "manifest schema_version must be 1")
    expect(manifest["path_base"] == "manifest", "manifest path_base must be 'manifest'")
    expect(
        manifest["fixture_root"] == "crates/xuanling-harness-bridge/tests/fixtures",
        "fixture_root must be crates/xuanling-harness-bridge/tests/fixtures",
    )

    entries = manifest["entries"]
    expect(isinstance(entries, list) and entries, "manifest.entries must be a non-empty array")

    ids: list[str] = []
    for index, entry in enumerate(entries):
        expect(isinstance(entry, dict), f"entry {index} must be an object")
        expect(
            list(entry.keys()) == EXPECTED_ENTRY_KEYS,
            f"entry {index} keys must be {EXPECTED_ENTRY_KEYS}, got {list(entry.keys())}",
        )
        entry_id = entry["id"]
        expect(isinstance(entry_id, str) and entry_id, f"entry {index}: id must be non-empty")
        expect(entry_id not in ids, f"duplicate fixture id: {entry_id}")
        ids.append(entry_id)

        expect(entry["adapter"] in ADAPTER_IDS, f"{entry_id}: unknown adapter {entry['adapter']!r}")
        expect(entry["kind"] in FIXTURE_KINDS, f"{entry_id}: unknown kind {entry['kind']!r}")
        expect(isinstance(entry["derived"], bool), f"{entry_id}: derived must be boolean")
        expect(
            isinstance(entry["cli_version"], str) and entry["cli_version"].strip(),
            f"{entry_id}: cli_version must be non-empty",
        )
        expect(
            isinstance(entry["argv"], list)
            and entry["argv"]
            and all(isinstance(arg, str) and arg for arg in entry["argv"]),
            f"{entry_id}: argv must be a non-empty array of strings",
        )
        expect(
            isinstance(entry["exit_code"], int) and not isinstance(entry["exit_code"], bool),
            f"{entry_id}: exit_code must be an integer",
        )

        # Guard the stream shapes before the provenance checks dereference them;
        # the full shape/hash/extension validation follows below.
        stdout = entry["stdout"]
        expect(isinstance(stdout, dict), f"{entry_id}: stdout must be an object")
        expect(
            isinstance(stdout.get("path"), str) and stdout["path"],
            f"{entry_id}: stdout.path must be non-empty",
        )
        expect(
            stdout.get("format") in STREAM_FORMATS,
            f"{entry_id}: stdout.format must be one of {STREAM_FORMATS}",
        )
        stderr = entry["stderr"]
        expect(stderr is None or isinstance(stderr, dict), f"{entry_id}: stderr must be an object or null")
        if isinstance(stderr, dict):
            expect(
                isinstance(stderr.get("path"), str) and stderr["path"],
                f"{entry_id}: stderr.path must be non-empty",
            )
            expect(
                stderr.get("format") in STREAM_FORMATS,
                f"{entry_id}: stderr.format must be one of {STREAM_FORMATS}",
            )

        provenance = entry["provenance"]
        expect(
            isinstance(provenance, str) and provenance.strip(),
            f"{entry_id}: provenance must be non-empty",
        )
        if entry["derived"]:
            expect(
                provenance.startswith("derived"),
                f"{entry_id}: derived fixture provenance must start with 'derived': {provenance!r}",
            )
            expect(
                "not a live capture" in provenance,
                f"{entry_id}: derived fixture must say it is not a live capture: {provenance!r}",
            )
            expect(
                entry["stdout"]["path"].startswith("data/"),
                f"{entry_id}: derived stdout must live under data/",
            )
        else:
            expect(
                provenance.startswith("live capture"),
                f"{entry_id}: non-derived fixture provenance must start with 'live capture': {provenance!r}",
            )
            expect(
                "not a live capture" not in provenance,
                f"{entry_id}: non-derived fixture must not be described as derived: {provenance!r}",
            )
            for stream_name in ("stdout", "stderr"):
                stream = entry[stream_name]
                if stream is None:
                    continue
                # An empty captured stdout is represented by a documented
                # zero-byte placeholder under data/ because captured/ is read-only.
                if stream["format"] != "empty":
                    expect(
                        stream["path"].startswith("captured/"),
                        f"{entry_id}: {stream_name} of a live capture must reference captured/, "
                        f"got {stream['path']!r}",
                    )

        expect(
            entry["expected_status"] in TERMINAL_STATUSES,
            f"{entry_id}: unknown expected_status {entry['expected_status']!r}",
        )
        expected_code = entry["expected_error_code"]
        if expected_code is not None:
            expect(
                expected_code in ERROR_CODES,
                f"{entry_id}: unknown expected_error_code {expected_code!r}",
            )
        if entry["expected_status"] == "completed":
            expect(expected_code is None, f"{entry_id}: completed must not carry an error code")
        else:
            expect(expected_code is not None, f"{entry_id}: non-completed status needs an error code")

        for stream_name in ("stdout", "stderr"):
            stream = entry[stream_name]
            if stream is None:
                expect(stream_name == "stderr", f"{entry_id}: stdout may not be null")
                continue
            expect(isinstance(stream, dict), f"{entry_id}: {stream_name} must be an object or null")
            expect(
                list(stream.keys()) == EXPECTED_STREAM_KEYS,
                f"{entry_id}: {stream_name} keys must be {EXPECTED_STREAM_KEYS}, got {list(stream.keys())}",
            )
            expect(
                isinstance(stream["path"], str) and stream["path"],
                f"{entry_id}: {stream_name}.path must be non-empty",
            )
            expect(
                SHA256_RE.match(stream["sha256"]) is not None,
                f"{entry_id}: {stream_name}.sha256 must be 64 lowercase hex characters",
            )
            expect(
                stream["format"] in STREAM_FORMATS,
                f"{entry_id}: {stream_name}.format must be one of {STREAM_FORMATS}",
            )
            expected_suffix = FORMAT_SUFFIX[stream["format"]]
            expect(
                stream["path"].endswith(expected_suffix),
                f"{entry_id}: format={stream['format']} requires a {expected_suffix} file, "
                f"got {stream['path']!r}",
            )

    expect(ids == sorted(ids), "manifest entries must be sorted by id")


def check_data_inventory(state: dict[str, Any]) -> None:
    data_dir = FIXTURES_DIR / "data"
    expect(data_dir.is_dir(), "tests/fixtures/data/ must exist")
    actual = {f"data/{path.name}" for path in data_dir.iterdir() if path.is_file()}
    referenced: set[str] = set()
    for entry in state["manifest"]["entries"]:
        for stream_name in ("stdout", "stderr"):
            stream = entry[stream_name]
            if stream is not None and stream["path"].startswith("data/"):
                referenced.add(stream["path"])
    unreferenced = sorted(actual - referenced)
    missing = sorted(referenced - actual)
    expect(not unreferenced, f"files under data/ missing from the manifest: {unreferenced}")
    expect(not missing, f"manifest references missing data/ files: {missing}")
    expect(len(actual) > 0, "data/ has no fixture files")


# ---------------------------------------------------------------------------
# Fixture checks
# ---------------------------------------------------------------------------


def resolve_stream(entry: dict[str, Any], stream_name: str) -> dict[str, Any]:
    stream = entry[stream_name]
    expect(stream is not None, f"{entry['id']}: {stream_name} is missing")
    path = FIXTURES_DIR / stream["path"]
    expect(path.is_file(), f"{entry['id']}: missing {stream_name} file {rel(path)}")
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    expect(
        digest == stream["sha256"],
        f"{entry['id']}: {stream_name} sha256 mismatch (manifest {stream['sha256']}, actual {digest})",
    )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        fail(f"{entry['id']}: {stream_name} is not valid UTF-8: {exc}")
    return {
        "path": path,
        "raw": raw,
        "text": text,
        "events": [],
        "invalid": [],
        "value": None,
        "json_error": None,
    }


def parse_stream(entry: dict[str, Any], stream_name: str, info: dict[str, Any]) -> None:
    fmt = entry[stream_name]["format"]
    name = f"{entry['id']} {stream_name}"

    expect(
        info["path"].name.endswith(FORMAT_SUFFIX[fmt]),
        f"{name}: format={fmt} requires a {FORMAT_SUFFIX[fmt]} file",
    )

    if fmt == "empty":
        expect(len(info["raw"]) == 0, f"{name}: format=empty but the file has {len(info['raw'])} bytes")
        return

    if fmt == "ndjson":
        non_empty = 0
        for lineno, line in enumerate(info["text"].splitlines(), 1):
            if not line.strip():
                continue
            non_empty += 1
            try:
                info["events"].append((lineno, json.loads(line)))
            except json.JSONDecodeError as exc:
                info["invalid"].append((lineno, line, str(exc)))
        expect(non_empty > 0, f"{name}: ndjson file has no non-empty lines")
        if stream_name == "stdout" and entry["kind"] == "malformed":
            expect(info["invalid"], f"{name}: kind=malformed but every ndjson line parsed")
        elif info["invalid"]:
            lineno, _, error = info["invalid"][0]
            fail(f"{name}: line {lineno} is not JSON: {error}")
        return

    if fmt == "json":
        try:
            info["value"] = json.loads(info["text"])
        except json.JSONDecodeError as exc:
            info["json_error"] = str(exc)
            if not (stream_name == "stdout" and entry["kind"] == "malformed"):
                fail(f"{name}: not valid JSON: {exc}")
        if stream_name == "stdout" and entry["kind"] == "malformed":
            expect(
                info["json_error"] is not None or not isinstance(info["value"], dict),
                f"{name}: kind=malformed but the payload is a JSON object",
            )
        return

    if fmt == "text":
        expect(
            info["path"].name.endswith(".stderr"),
            f"{name}: format=text is only allowed for a trailing .stderr fixture",
        )
        return

    fail(f"{name}: unsupported format {fmt!r}")


def as_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def diagnostic_of(streams: dict[str, Any]) -> str | None:
    stderr = streams.get("stderr")
    if stderr is None:
        return None
    text = stderr["text"].strip()
    return text or None


def join_text(text: str, diagnostic: str | None) -> str:
    return f"{text} | {diagnostic}" if diagnostic else text


def outcome(status: str, error_code: str | None = None, final_text: str | None = None, detail: str = "") -> dict[str, Any]:
    return {"status": status, "error_code": error_code, "final_text": final_text, "detail": detail}


def classify(message: str) -> str:
    """Mirror collector::classify_failure for the fixture oracle."""
    lower = message.lower()
    if any(marker in lower for marker in AUTH_MARKERS):
        return "AUTH_REQUIRED"
    if any(marker in lower for marker in RATE_MARKERS):
        return "RATE_LIMIT"
    if any(marker in lower for marker in INPUT_MARKERS):
        return "NEEDS_INPUT"
    return "WORKER_FAILED"


def derive_codex(entry: dict[str, Any], streams: dict[str, Any]) -> dict[str, Any]:
    events = streams["stdout"]["events"]
    diagnostic = diagnostic_of(streams)
    failure: str | None = None
    turn_completed = False
    final_text: str | None = None

    for _, event in events:
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "turn.completed":
            turn_completed = True
        elif kind == "turn.failed":
            failure = as_str(as_dict(event.get("error")).get("message")) or "codex turn failed"
        elif kind == "error":
            failure = as_str(event.get("message")) or "codex reported an error"
        elif kind == "item.completed":
            item = as_dict(event.get("item"))
            if item.get("type") == "agent_message" and isinstance(item.get("text"), str):
                final_text = item["text"]

    if failure is not None:
        message = join_text(failure, diagnostic)
        return outcome("failed", classify(message), final_text, message)
    if entry["exit_code"] != 0:
        message = join_text(f"worker exited with code {entry['exit_code']}", diagnostic)
        return outcome("failed", classify(message), final_text, message)
    if not turn_completed:
        return outcome("failed", "STREAM_INCOMPLETE", final_text, "turn.completed missing")
    if final_text is not None and final_text.strip():
        return outcome("completed", None, final_text, "turn.completed with agent_message")
    return outcome("failed", "STREAM_INCOMPLETE", final_text, "agent_message missing or empty")


def derive_claude(entry: dict[str, Any], streams: dict[str, Any]) -> dict[str, Any]:
    value = streams["stdout"]["value"]
    diagnostic = diagnostic_of(streams)

    if not isinstance(value, dict):
        if entry["exit_code"] != 0:
            message = diagnostic or f"worker exited with code {entry['exit_code']}"
            return outcome("failed", classify(message), None, message)
        return outcome("failed", "STREAM_INCOMPLETE", None, "stdout is not a single JSON result")

    is_error = value.get("is_error") is True
    subtype = as_str(value.get("subtype"))
    result = as_str(value.get("result"))
    terminal_reason = as_str(value.get("terminal_reason")) or ""
    denials = value.get("permission_denials")
    denial_count = len(denials) if isinstance(denials, list) else 0

    if is_error or entry["exit_code"] != 0 or subtype != "success":
        message = result or f"claude reported subtype={subtype or 'unknown'} terminal_reason={terminal_reason}"
        if denial_count > 0 and not result:
            return outcome("needs_input", "NEEDS_INPUT", None, "permission_denials with empty result")
        return outcome("failed", classify(join_text(message, diagnostic)), None, message)
    if result is not None and result.strip():
        return outcome("completed", None, result, "subtype=success, is_error=false, result present")
    return outcome("failed", "STREAM_INCOMPLETE", None, "success result has no final text")


def derive_dsh(entry: dict[str, Any], streams: dict[str, Any]) -> dict[str, Any]:
    events = streams["stdout"]["events"]
    diagnostic = diagnostic_of(streams)
    error_event: str | None = None
    turn_end: dict[str, Any] | None = None
    final_text: str | None = None

    for _, event in events:
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "error":
            error_event = as_str(event.get("message")) or "dsh reported an error"
        elif kind == "status" and event.get("phase") == "turn_end":
            reason = as_dict(event.get("reason"))
            if not reason:
                continue
            error = as_dict(reason.get("error"))
            turn_end = {
                "kind": as_str(reason.get("kind")) or "unknown",
                "code": as_str(error.get("code")),
                "message": as_str(error.get("message")),
            }
        elif kind == "final" and isinstance(event.get("text"), str):
            final_text = event["text"]

    if error_event is not None:
        message = join_text(error_event, diagnostic)
        return outcome("failed", classify(message), final_text, message)
    if turn_end is None:
        if entry["exit_code"] != 0:
            message = diagnostic or f"worker exited with code {entry['exit_code']}"
            return outcome("failed", classify(message), final_text, message)
        return outcome("failed", "STREAM_INCOMPLETE", final_text, "turn_end missing")

    kind = turn_end["kind"]
    if kind == "completed":
        if entry["exit_code"] != 0:
            message = join_text(f"worker exited with code {entry['exit_code']}", diagnostic)
            return outcome("failed", classify(message), final_text, message)
        if final_text is not None and final_text.strip():
            return outcome("completed", None, final_text, "turn_end completed with final text")
        return outcome("failed", "STREAM_INCOMPLETE", final_text, "completed turn with empty final")
    if kind == "blocked":
        return outcome("needs_input", "NEEDS_INPUT", final_text, "turn_end blocked")

    code = turn_end["code"]
    message = turn_end["message"]
    if code and message:
        native = f"{code}: {message}"
    elif code:
        native = code
    elif message:
        native = message
    else:
        native = f"native turn ended with reason {kind}"
    classified = classify(join_text(native, diagnostic)) if kind == "error" else "WORKER_FAILED"
    return outcome("failed", classified, final_text, native)


def derive_zcode(entry: dict[str, Any], streams: dict[str, Any]) -> dict[str, Any]:
    info = streams["stdout"]
    diagnostic = diagnostic_of(streams)
    text = info["text"].strip()

    if not text:
        if entry["exit_code"] != 0:
            message = diagnostic or f"worker exited with code {entry['exit_code']}"
            return outcome("failed", classify(message), None, message)
        return outcome("failed", "STREAM_INCOMPLETE", None, "empty stdout")

    value = info["value"]
    if not isinstance(value, dict):
        value = None
        for line in reversed(info["text"].splitlines()):
            if not line.strip():
                continue
            try:
                candidate = json.loads(line)
            except json.JSONDecodeError:
                continue
            value = candidate
            break
    if not isinstance(value, dict):
        return outcome("failed", "STREAM_INCOMPLETE", None, "stdout is not a JSON result object")

    is_result = value.get("type") == "result" or (
        value.get("type") is None and isinstance(value.get("response"), str)
    )
    if not is_result:
        message = (
            as_str(value.get("message"))
            or as_str(value.get("error"))
            or "zcode reported an unrecognized object"
        )
        return outcome("failed", classify(message), None, message)

    response = as_str(value.get("response"))
    if entry["exit_code"] != 0:
        message = f"worker produced a result object but exited with code {entry['exit_code']}"
        return outcome("failed", classify(message), response, message)
    if response is not None and response.strip():
        return outcome("completed", None, response, "type=result with response")
    return outcome("failed", "STREAM_INCOMPLETE", response, "result has no response text")


DERIVERS = {
    "codex": derive_codex,
    "claude": derive_claude,
    "dsh": derive_dsh,
    "zcode": derive_zcode,
}


def has_native_failure(entry: dict[str, Any], streams: dict[str, Any]) -> bool:
    adapter = entry["adapter"]
    if adapter == "codex":
        return any(
            isinstance(event, dict) and event.get("type") in {"turn.failed", "error"}
            for _, event in streams["stdout"]["events"]
        )
    if adapter == "claude":
        value = streams["stdout"]["value"]
        return isinstance(value, dict) and (
            value.get("is_error") is True or as_str(value.get("subtype")) != "success"
        )
    if adapter == "dsh":
        for _, event in streams["stdout"]["events"]:
            if not isinstance(event, dict):
                continue
            if event.get("type") == "error":
                return True
            if event.get("type") == "status" and event.get("phase") == "turn_end":
                reason = as_dict(event.get("reason"))
                if as_str(reason.get("kind")) not in {None, "completed", "blocked"}:
                    return True
        return False
    if adapter == "zcode":
        value = streams["stdout"]["value"]
        return isinstance(value, dict) and value.get("type") != "result"
    return False


def success_terminal_present(entry: dict[str, Any], streams: dict[str, Any]) -> bool:
    adapter = entry["adapter"]
    if adapter == "codex":
        turn_completed = False
        final_text: str | None = None
        for _, event in streams["stdout"]["events"]:
            if not isinstance(event, dict):
                continue
            if event.get("type") == "turn.completed":
                turn_completed = True
            if event.get("type") == "item.completed":
                item = as_dict(event.get("item"))
                if item.get("type") == "agent_message" and isinstance(item.get("text"), str):
                    final_text = item["text"]
        return turn_completed and final_text is not None and bool(final_text.strip())
    if adapter == "claude":
        value = streams["stdout"]["value"]
        if not isinstance(value, dict):
            return False
        result = as_str(value.get("result"))
        return (
            value.get("subtype") == "success"
            and value.get("is_error") is False
            and result is not None
            and bool(result.strip())
        )
    if adapter == "dsh":
        turn_completed = False
        final_text: str | None = None
        for _, event in streams["stdout"]["events"]:
            if not isinstance(event, dict):
                continue
            if event.get("type") == "status" and event.get("phase") == "turn_end":
                reason = as_dict(event.get("reason"))
                if reason.get("kind") == "completed":
                    turn_completed = True
            if event.get("type") == "final" and isinstance(event.get("text"), str):
                final_text = event["text"]
        return turn_completed and final_text is not None and bool(final_text.strip())
    if adapter == "zcode":
        value = streams["stdout"]["value"]
        if not isinstance(value, dict):
            return False
        response = as_str(value.get("response"))
        return value.get("type") == "result" and response is not None and bool(response.strip())
    return False


def native_needs_input_present(entry: dict[str, Any], streams: dict[str, Any]) -> bool:
    adapter = entry["adapter"]
    if adapter == "dsh":
        for _, event in streams["stdout"]["events"]:
            if not isinstance(event, dict):
                continue
            if event.get("type") == "status" and event.get("phase") == "turn_end":
                reason = as_dict(event.get("reason"))
                if reason.get("kind") == "blocked":
                    return True
        return False
    if adapter == "claude":
        value = streams["stdout"]["value"]
        if not isinstance(value, dict):
            return False
        denials = value.get("permission_denials")
        return isinstance(denials, list) and len(denials) > 0
    return False


def malformed_detected(entry: dict[str, Any], streams: dict[str, Any]) -> bool:
    info = streams["stdout"]
    return (
        info["json_error"] is not None
        or bool(info["invalid"])
        or entry["stdout"]["format"] == "text"
    )


def assert_kind(entry: dict[str, Any], streams: dict[str, Any], result: dict[str, Any]) -> None:
    kind = entry["kind"]
    entry_id = entry["id"]

    if kind == "success":
        expect(entry["exit_code"] == 0, f"{entry_id}: success requires exit_code 0")
        expect(result["status"] == "completed", f"{entry_id}: success must derive completed")
        expect(
            result["final_text"] is not None and bool(result["final_text"].strip()),
            f"{entry_id}: success must carry a non-empty final answer",
        )
    elif kind == "failure":
        expect(
            entry["exit_code"] != 0 or has_native_failure(entry, streams),
            f"{entry_id}: failure requires a non-zero exit code or an explicit native error signal",
        )
        expect(result["status"] == "failed", f"{entry_id}: failure must derive failed")
        expect(result["error_code"] is not None, f"{entry_id}: failure must carry an error code")
    elif kind == "missing_frame":
        expect(
            not success_terminal_present(entry, streams),
            f"{entry_id}: missing_frame must lack the native success terminal event",
        )
        expect(result["status"] == "failed", f"{entry_id}: missing_frame must derive failed")
        expect(result["error_code"] is not None, f"{entry_id}: missing_frame must carry an error code")
    elif kind == "needs_input":
        expect(
            native_needs_input_present(entry, streams),
            f"{entry_id}: needs_input must carry a native blocked or denial signal",
        )
        expect(result["status"] == "needs_input", f"{entry_id}: needs_input must derive needs_input")
        expect(result["error_code"] == "NEEDS_INPUT", f"{entry_id}: needs_input must map to NEEDS_INPUT")
    elif kind == "malformed":
        expect(
            malformed_detected(entry, streams),
            f"{entry_id}: malformed fixture parsed as a native protocol payload",
        )
        expect(result["status"] == "failed", f"{entry_id}: malformed fixture must derive failed")
        expect(
            result["error_code"] is not None,
            f"{entry_id}: malformed fixture must carry an error code",
        )
    else:
        fail(f"{entry_id}: unsupported kind {kind!r}")


def check_entry(entry: dict[str, Any]) -> None:
    stdout = resolve_stream(entry, "stdout")
    stderr = resolve_stream(entry, "stderr") if entry["stderr"] is not None else None
    streams = {"stdout": stdout, "stderr": stderr}

    parse_stream(entry, "stdout", stdout)
    if stderr is not None:
        parse_stream(entry, "stderr", stderr)

    result = DERIVERS[entry["adapter"]](entry, streams)
    expect(
        result["status"] == entry["expected_status"],
        f"derived status {result['status']!r} does not match expected_status "
        f"{entry['expected_status']!r} (derivation: {result['detail']})",
    )
    expect(
        result["error_code"] == entry["expected_error_code"],
        f"derived error code {result['error_code']!r} does not match expected_error_code "
        f"{entry['expected_error_code']!r} (derivation: {result['detail']})",
    )
    assert_kind(entry, streams, result)


# ---------------------------------------------------------------------------
# Secret scan
# ---------------------------------------------------------------------------


def is_placeholder(token: str) -> bool:
    lower = token.lower()
    if any(marker in lower for marker in PLACEHOLDER_MARKERS):
        return True
    return set(token) <= {"0"}


def mask(token: str) -> str:
    return f"{token[:6]}... ({len(token)} chars)"


def check_secret_scan() -> None:
    targets = []
    for sub in ("captured", "data"):
        directory = FIXTURES_DIR / sub
        if directory.is_dir():
            targets.extend(sorted(path for path in directory.rglob("*") if path.is_file()))
    expect(targets, "no fixture files found to scan")
    for path in targets:
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in SECRET_PATTERNS:
            for match in pattern.finditer(text):
                token = match.group(0)
                if is_placeholder(token):
                    continue
                fail(f"{rel(path)} contains a {label}: {mask(token)}")


def main() -> int:
    state: dict[str, Any] = {}

    for name in CONTRACT_FILES:
        run(f"contract parse: {name}", lambda name=name: load_contract(state, name))

    run("contracts: four-tool surface and error codes", lambda: check_tools(state))
    run("contracts: FinalResult schema", lambda: check_final_result_schema(state))
    run("contracts: report format v1", lambda: check_report_format(state))
    run("contracts: adapters", lambda: check_adapters(state))
    run("contracts: host capabilities", lambda: check_host_capabilities(state))

    run("manifest: shape, order and labels", lambda: check_manifest_shape(state))
    run("fixtures: data inventory", lambda: check_data_inventory(state))

    entries = state["manifest"]["entries"]
    for entry in entries:
        run(f"fixture: {entry['id']}", lambda entry=entry: check_entry(entry))

    run("fixtures: secret scan", check_secret_scan)

    print(
        f"OK: {len(entries)} fixtures, {len(CONTRACT_FILES)} contracts, "
        f"{CHECKS_RUN} checks passed"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
