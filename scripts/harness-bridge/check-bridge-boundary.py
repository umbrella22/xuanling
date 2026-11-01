#!/usr/bin/env python3
"""Boundary guard for the result-only harness bridge (plan W1.1 / W4.1).

Run from the repository root:

    python3 scripts/harness-bridge/check-bridge-boundary.py

The bridge is allowed to run one native worker, collect a bounded final answer
and optionally publish one terminal Markdown file. It is NOT allowed to grow a
database, a periodic progress/event log, a lease/heartbeat mechanism or extra
process-inspection tools. This script enforces that boundary:

  1. dependency-closure: `cargo tree -p xuanling-harness-bridge -e normal` must
     not contain xuanling-memory, xuanling-mcp, sqlx, rusqlite or libsqlite3-sys.
     The old memory crate may use SQLite; the bridge closure must not.
  2. manifest: crates/xuanling-harness-bridge/Cargo.toml must not list a SQLite/DB dependency.
  3. source-scan: crates/xuanling-harness-bridge/src/**/*.rs must not reference forbidden
     persistence/process-exposure APIs or lease/event-log identifiers.
  4. tool-surface: crates/xuanling-harness-bridge/src/mcp.rs must register exactly
     harness_health, harness_submit, harness_wait and harness_cancel.
  5. budget-deadline: no `--max-budget-usd` anywhere in src, and supervisor.rs
     must not construct a default task deadline when task.deadline_at is None.

Exit 0 with a per-check PASS summary, or exit 1 with file:line diagnostics.
Python 3 standard library only.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

CRATE = "xuanling-harness-bridge"
FORBIDDEN_CLOSURE = ("xuanling-memory", "xuanling-mcp", "sqlx", "rusqlite", "libsqlite3-sys")

# Manifest names that would reintroduce a SQLite/DB dependency into this crate.
FORBIDDEN_MANIFEST = (
    "xuanling-memory",
    "xuanling-mcp",
    "sqlx",
    "rusqlite",
    "libsqlite3-sys",
    "sqlite",
    "sqlite3",
    "tokio-rusqlite",
    "r2d2_sqlite",
    "diesel",
    "sea-orm",
    "sled",
)

# (label, compiled pattern, files where the pattern is allowed). The allowlist
# is limited to report.rs: it is the only module permitted to create files, and
# only through create_new + hard_link for the optional terminal report.
SOURCE_PATTERNS = (
    ("sqlx", re.compile(r"\bsqlx\b", re.IGNORECASE), frozenset()),
    ("rusqlite", re.compile(r"\brusqlite\b", re.IGNORECASE), frozenset()),
    ("libsqlite3", re.compile(r"\blibsqlite3\b", re.IGNORECASE), frozenset()),
    (
        "OpenOptions::new().append",
        re.compile(r"OpenOptions\s*::\s*new\s*\(\s*\)\s*\.\s*append"),
        frozenset(),
    ),
    (".append(true)", re.compile(r"\.append\s*\(\s*true\s*\)"), frozenset()),
    ("std::fs::write", re.compile(r"std\s*::\s*fs\s*::\s*write"), frozenset({"report.rs"})),
    (
        "std::fs::File::create",
        re.compile(r"(?:std\s*::\s*fs\s*::\s*)?File\s*::\s*create"),
        frozenset({"report.rs"}),
    ),
    # task.rs opens the validated task file read-only with O_NOFOLLOW/O_NONBLOCK
    # for the identity-bound frozen read; it still may not create or write.
    (
        "OpenOptions",
        re.compile(r"\bOpenOptions\b"),
        frozenset({"report.rs", "task.rs"}),
    ),
    (
        "tokio::fs::write",
        re.compile(r"tokio\s*::\s*fs\s*::\s*write"),
        frozenset(),
    ),
    # Persistent-coordination identifiers. `release_slot` and "release" do not
    # match because the lookarounds exclude a preceding/following ASCII letter.
    (
        "heartbeat/lease/event-log/sqlite identifier",
        re.compile(
            r"(?<![A-Za-z])(?:heartbeat|lease|event[_-]?log|event[_-]?file|sqlite)(?![A-Za-z])",
            re.IGNORECASE,
        ),
        frozenset(),
    ),
)

EXPECTED_TOOLS = {"harness_health", "harness_submit", "harness_wait", "harness_cancel"}
RETIRED_TOOLS = {
    "harness_events",
    "harness_status",
    "harness_list",
    "harness_reply",
    "harness_approve",
    "harness_continue",
}

BUDGET_PATTERNS = (
    re.compile(r"--max-budget-usd", re.IGNORECASE),
    re.compile(r"\bmax_budget_usd\b", re.IGNORECASE),
    re.compile(r"--max-budget\b", re.IGNORECASE),
)


class CheckFailure(Exception):
    """One check failed; the message is printed as a FAIL diagnostic."""


def find_repo_root() -> Path:
    """Prefer the checkout that contains this script; fall back to the cwd."""
    script_root = Path(__file__).resolve().parents[2]
    if (script_root / "crates" / "xuanling-harness-bridge" / "Cargo.toml").is_file():
        return script_root
    cwd = Path.cwd().resolve()
    if (cwd / "crates" / "xuanling-harness-bridge" / "Cargo.toml").is_file():
        return cwd
    raise CheckFailure(
        "cannot locate the repository root (expected crates/xuanling-harness-bridge/Cargo.toml)"
    )


def rust_sources(root: Path) -> list[Path]:
    return sorted((root / "crates" / "xuanling-harness-bridge" / "src").rglob("*.rs"))


def relative(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def check_dependency_closure(root: Path) -> str:
    """Inspect only the normal-edge closure of the bridge package."""
    command = [
        "cargo",
        "tree",
        "-p",
        CRATE,
        "-e",
        "normal",
        "--prefix",
        "none",
        "--format",
        "{p}",
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError as error:
        raise CheckFailure(f"cargo is not available: {error}") from error
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise CheckFailure(f"`{' '.join(command)}` failed ({completed.returncode}): {detail}")

    names = set()
    for line in completed.stdout.splitlines():
        line = line.strip()
        if line:
            names.add(line.split()[0])
    if not names:
        raise CheckFailure("cargo tree returned an empty dependency list")

    present = sorted(name for name in FORBIDDEN_CLOSURE if name in names)
    if present:
        raise CheckFailure(
            "forbidden crate(s) in the normal dependency closure: " + ", ".join(present)
        )
    return f"{len(names)} normal-edge packages, none of {', '.join(FORBIDDEN_CLOSURE)}"


def collect_manifest_dependencies(node, path: str = "") -> list[tuple[str, str]]:
    """Walk parsed TOML and collect (dependency name, table path) pairs."""
    found: list[tuple[str, str]] = []
    if not isinstance(node, dict):
        return found
    for key, value in node.items():
        if key in ("dependencies", "dev-dependencies", "build-dependencies"):
            if isinstance(value, dict):
                for name in value:
                    found.append((name, f"{path}{key}"))
            continue
        if isinstance(value, dict):
            found.extend(collect_manifest_dependencies(value, f"{path}{key}."))
    return found


def check_manifest(root: Path) -> str:
    """Reject any SQLite/DB dependency entry in the bridge manifest."""
    manifest = root / "crates" / "xuanling-harness-bridge" / "Cargo.toml"
    try:
        import tomllib
    except ModuleNotFoundError as error:  # Python < 3.11
        raise CheckFailure(f"tomllib is required (Python 3.11+): {error}") from error
    try:
        data = tomllib.loads(manifest.read_text(encoding="utf-8"))
    except OSError as error:
        raise CheckFailure(f"cannot read {relative(root, manifest)}: {error}") from error
    except tomllib.TOMLDecodeError as error:
        raise CheckFailure(f"invalid {relative(root, manifest)}: {error}") from error

    hits = []
    for name, table in collect_manifest_dependencies(data):
        lowered = name.lower()
        for forbidden in FORBIDDEN_MANIFEST:
            if lowered == forbidden or lowered.startswith(forbidden + "-"):
                hits.append(f"{relative(root, manifest)}: [{table}] {name}")
                break
    if hits:
        raise CheckFailure("forbidden SQLite/DB manifest dependency:\n  " + "\n  ".join(hits))
    return "no SQLite/DB dependency entry"


def production_lines(text: str) -> list[tuple[int, str]]:
    """Return non-test lines.

    The crate convention puts `#[cfg(test)] mod tests` at the end of a source
    file. Test modules may create temporary fixture executables, so they are
    excluded from the runtime-persistence scan. Everything else is scanned.
    """
    lines: list[tuple[int, str]] = []
    skipping = False
    depth = 0
    for number, line in enumerate(text.splitlines(), start=1):
        if not skipping and line.strip().startswith("#[cfg(test)]"):
            skipping = True
            depth = 0
            continue
        if skipping:
            depth += line.count("{") - line.count("}")
            if depth <= 0 and "}" in line:
                skipping = False
            continue
        lines.append((number, line))
    return lines


def check_sources(root: Path) -> str:
    """Scan Rust sources for forbidden persistence/process-exposure patterns."""
    files = rust_sources(root)
    if not files:
        raise CheckFailure("crates/xuanling-harness-bridge/src contains no Rust sources")
    hits: list[str] = []
    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace")
        for number, line in production_lines(text):
            for label, pattern, allowed in SOURCE_PATTERNS:
                if path.name in allowed:
                    continue
                if pattern.search(line):
                    hits.append(f"{relative(root, path)}:{number}: [{label}] {line.strip()}")
    if hits:
        raise CheckFailure(f"{len(hits)} forbidden source hit(s):\n  " + "\n  ".join(hits))
    return f"{len(files)} source files, no forbidden persistence/process pattern"


def check_tool_surface(root: Path) -> str:
    """The controller surface is exactly the four result/control tools."""
    path = root / "crates" / "xuanling-harness-bridge" / "src" / "mcp.rs"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise CheckFailure(f"cannot read {relative(root, path)}: {error}") from error

    literals = set(re.findall(r'"(harness_[A-Za-z0-9_]+)"', text))
    if literals != EXPECTED_TOOLS:
        missing = sorted(EXPECTED_TOOLS - literals)
        extra = sorted(literals - EXPECTED_TOOLS)
        detail = []
        if missing:
            detail.append("missing: " + ", ".join(missing))
        if extra:
            detail.append("unexpected: " + ", ".join(extra))
        raise CheckFailure("tool surface mismatch (" + "; ".join(detail) + ")")

    retired = sorted(tool for tool in RETIRED_TOOLS if tool in text)
    if retired:
        raise CheckFailure("retired tool name(s) present: " + ", ".join(retired))

    registered = set(
        re.findall(r'tool\s*::\s*<[^>]*>\s*\(\s*"(harness_[A-Za-z0-9_]+)"', text)
    )
    if registered != EXPECTED_TOOLS:
        raise CheckFailure(
            "list_tools registrations do not match the four tools: "
            + ", ".join(sorted(registered))
        )
    return "exactly " + ", ".join(sorted(EXPECTED_TOOLS))


def check_budget_and_deadline(root: Path) -> str:
    """No injected consumption budget and no default task deadline.

    The supervisor check is deliberately textual. The authoritative spawn
    deadline is `tokio_deadline(job.task.deadline_time())`, which is `None` when
    `job.task.deadline_at` is `None`; `sleep_until(None)` must park forever. Any
    `Duration::from_*` on a line that also names a deadline, or any
    `unwrap_or`-style fallback for a missing deadline, is rejected.
    """
    files = rust_sources(root)
    hits: list[str] = []
    for path in files:
        for number, line in production_lines(
            path.read_text(encoding="utf-8", errors="replace")
        ):
            for pattern in BUDGET_PATTERNS:
                if pattern.search(line):
                    hits.append(f"{relative(root, path)}:{number}: {line.strip()}")
    if hits:
        raise CheckFailure("consumption budget injection found:\n  " + "\n  ".join(hits))

    supervisor = (root / "crates" / "xuanling-harness-bridge" / "src" / "supervisor.rs").read_text(encoding="utf-8")
    if "tokio_deadline(job.task.deadline_time())" not in supervisor:
        raise CheckFailure(
            "supervisor.rs no longer derives its deadline from the explicit "
            "`job.task.deadline_time()`"
        )
    duration_line = re.compile(r"Duration\s*::\s*from_(?:secs|millis)", re.IGNORECASE)
    for number, line in enumerate(supervisor.splitlines(), start=1):
        if duration_line.search(line) and "deadline" in line.lower():
            raise CheckFailure(
                f"crates/xuanling-harness-bridge/src/supervisor.rs:{number}: a Duration constant is "
                f"used as a task deadline: {line.strip()}"
            )
    default_deadline = re.compile(
        r"deadline(?:_time|_at)?\s*\([^)]*\)\s*\.\s*"
        r"(?:unwrap|unwrap_or|unwrap_or_else|unwrap_or_default)\b"
    )
    match = default_deadline.search(supervisor)
    if match:
        raise CheckFailure(
            "supervisor.rs supplies a default when the explicit deadline is absent: "
            + match.group(0)
        )
    # A missing deadline must be represented as a pending future, never a timer.
    if "None => std::future::pending().await" not in supervisor:
        raise CheckFailure("supervisor.rs sleep_until no longer parks when deadline is None")
    return "no --max-budget-usd; deadline only from explicit task.deadline_at"


CHECKS = (
    ("dependency-closure", check_dependency_closure),
    ("manifest", check_manifest),
    ("source-scan", check_sources),
    ("tool-surface", check_tool_surface),
    ("budget-deadline", check_budget_and_deadline),
)


def main() -> int:
    try:
        root = find_repo_root()
    except CheckFailure as failure:
        print(f"FAIL  setup: {failure}")
        return 1

    passed = 0
    failures = 0
    for name, check in CHECKS:
        try:
            summary = check(root)
        except CheckFailure as failure:
            failures += 1
            print(f"FAIL  {name}: {failure}")
        except Exception as error:  # noqa: BLE001 - report unexpected errors clearly
            failures += 1
            print(f"FAIL  {name}: unexpected {type(error).__name__}: {error}")
        else:
            passed += 1
            print(f"PASS  {name}: {summary}")

    total = len(CHECKS)
    status = "PASS" if failures == 0 else "FAIL"
    print(f"bridge boundary check: {status} ({passed}/{total} checks passed)")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
