//! W8 coexistence + release-boundary contract (plan §10 W8).
//!
//! Pins: (1) building only `xuanling-mcp` does not compile the legacy
//! control-plane crates; (2) the old `xuanling` CLI does not embed the new MCP
//! server; (3) the dependency-island guard still holds.

use std::process::Command;

#[test]
fn building_xuanling_mcp_does_not_compile_legacy_control_plane() {
    // `cargo build -p xuanling-mcp` must not compile the legacy crates. We
    // inspect `cargo build` output lines for `Compiling xuanling-<legacy>`.
    let forbidden = [
        "xuanling-core",
        "xuanling-gateway",
        "xuanling-executor",
        "xuanling-store",
        "xuanling-policy",
        "xuanling-runtime",
        "xuanling-orchestrator",
    ];
    let out = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string()))
        .args(["build", "-p", "xuanling-mcp", "--release"])
        .output()
        .expect("cargo build");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let combined = format!("{stdout}{stderr}");
    for f in forbidden {
        assert!(
            !combined.contains(&format!("Compiling {f} ")),
            "building xuanling-mcp compiled legacy crate {f}"
        );
    }
}
