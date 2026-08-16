//! Dependency-island guard (plan §3, §10 W0, §12.2).
//!
//! Asserts the dependency graph of both new crates contains none of the
//! forbidden legacy control-plane crates. This is the single most important
//! anti-regression guard for the cross-platform line: once a legacy crate
//! sneaks in, the hidden timeout / root-containment / policy semantics leak
//! back into the toolkit.

use std::process::Command;

/// Crates the toolkit/MCP island MUST NOT depend on (plan §3).
const FORBIDDEN: &[&str] = &[
    "xuanling-core",
    "xuanling-policy",
    "xuanling-store",
    "xuanling-executor",
    "xuanling-gateway",
    "xuanling-runtime",
    "xuanling-orchestrator",
    "xuanling-source-action",
    "xuanling-source-edit",
    "xuanling-source-query",
    "xuanling-source-workspace",
];

fn normal_dep_tree(crate_name: &str) -> String {
    // `cargo tree -e normal` lists only normal (non-dev, non-build) edges.
    let output = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string()))
        .args(["tree", "-p", crate_name, "-e", "normal"])
        .output()
        .unwrap_or_else(|e| panic!("failed to run cargo tree -p {crate_name}: {e}"));
    if !output.status.success() {
        panic!(
            "cargo tree -p {crate_name} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn assert_no_forbidden(crate_name: &str, tree: &str) {
    let violations: Vec<&&str> = FORBIDDEN
        .iter()
        .filter(|forbidden| tree.contains(&format!(" {forbidden} ")))
        .collect();
    // Match lines like `└── xuanling-core v0.1.0`; the surrounding-space check
    // avoids false positives from a forbidden name appearing inside another.
    let line_violations: Vec<String> = tree
        .lines()
        .filter(|line| FORBIDDEN.iter().any(|f| line.contains(&format!("{f} v"))))
        .map(str::to_owned)
        .collect();
    assert!(
        violations.is_empty() && line_violations.is_empty(),
        "{} pulls in forbidden legacy crates:\n{}\nFull tree:\n{tree}",
        crate_name,
        line_violations.join("\n")
    );
}

#[test]
fn toolkit_dependency_graph_excludes_legacy_control_plane() {
    let tree = normal_dep_tree("xuanling-toolkit");
    assert_no_forbidden("xuanling-toolkit", &tree);
}

#[test]
fn mcp_dependency_graph_excludes_legacy_control_plane() {
    let tree = normal_dep_tree("xuanling-mcp");
    assert_no_forbidden("xuanling-mcp", &tree);
}
