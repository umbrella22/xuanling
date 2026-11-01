//! Live ZCode target.
//!
//! Opt in with `HARNESS_BRIDGE_LIVE_ZCODE=1`. The success test runs the real
//! `node <zcode.cjs> --json --mode plan` CLI through the production supervisor
//! and requires the native `result.response` answer `OK`; the classification
//! test points the same adapter at a model that does not exist and requires a
//! typed `failed` result. `mode` is always explicit and never `yolo`.
//!
//! The runner is resolved from `HARNESS_BRIDGE_LIVE_ZCODE_NODE` (or the legacy
//! `HARNESS_BRIDGE_LIVE_NODE`), then `/usr/local/bin/node`, then
//! `/opt/homebrew/bin/node`; every candidate must be an absolute file.
//!
//! Unset gate: one `not_run:` line is written to fd 2 and the test returns.

mod live_common;

use std::path::PathBuf;

use xuanling_harness_bridge::config::{AdapterConfigs, RuntimeConfig, ZcodeConfig};

const GATE: &str = "HARNESS_BRIDGE_LIVE_ZCODE";
const SCRIPT_ENV: &str = "HARNESS_BRIDGE_LIVE_ZCODE_SCRIPT";
const VERSION_ENV: &str = "HARNESS_BRIDGE_LIVE_ZCODE_VERSION";
const DEFAULT_SCRIPT: &str = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const DEFAULT_VERSION: &str = "0.17.0";
const NODE_ENV: &str = "HARNESS_BRIDGE_LIVE_ZCODE_NODE";
const NODE_ENV_LEGACY: &str = "HARNESS_BRIDGE_LIVE_NODE";

/// The CLI resolves its packaged provider metadata through these two variables.
/// The bridge clears the child environment, so both must be forwarded.
const PROVIDER_ENV: &[&str] = &[
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ZCODE_API_KEY",
];

fn zcode_node() -> Result<PathBuf, String> {
    for var in [NODE_ENV, NODE_ENV_LEGACY] {
        if let Some(value) = std::env::var_os(var) {
            let path = PathBuf::from(value);
            if path.is_absolute() && path.is_file() {
                return Ok(path);
            }
            return Err(format!(
                "{var} is not an absolute node executable; point it at the node binary"
            ));
        }
    }
    for candidate in ["/usr/local/bin/node", "/opt/homebrew/bin/node"] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(format!(
        "no absolute node executable found; set {NODE_ENV} to the node binary"
    ))
}

fn zcode_config(runner: PathBuf, script: PathBuf) -> AdapterConfigs {
    AdapterConfigs {
        zcode: Some(ZcodeConfig {
            runner,
            script,
            version: live_common::cli_version(VERSION_ENV, DEFAULT_VERSION),
            mode: "plan".to_string(),
        }),
        ..AdapterConfigs::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zcode_live_success_returns_native_final_answer() {
    if !live_common::live_gate(GATE) {
        live_common::not_run(&format!(
            "{GATE} is not set; zcode live success was not executed"
        ));
        return;
    }
    let runner = match zcode_node() {
        Ok(runner) => runner,
        Err(reason) => {
            live_common::not_run(&reason);
            return;
        }
    };
    let Some(script) = live_common::cli_path(SCRIPT_ENV, DEFAULT_SCRIPT) else {
        live_common::not_run(&format!(
            "zcode script not found; set {SCRIPT_ENV} to the absolute zcode.cjs path"
        ));
        return;
    };

    let temp = tempfile::tempdir().expect("tempdir");
    let raw = live_common::base_config(
        temp.path(),
        PROVIDER_ENV,
        PROVIDER_ENV,
        zcode_config(runner, script),
    );
    let config = RuntimeConfig::from_config(raw).expect("live zcode config");

    let result = live_common::run_job(config, "zcode").await;
    live_common::record_observed("zcode", "success", &result);
    live_common::assert_completed_ok(&result, "zcode");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zcode_live_missing_provider_config_is_typed_failure() {
    if !live_common::live_gate(GATE) {
        live_common::not_run(&format!(
            "{GATE} is not set; zcode missing-provider-config classification was not executed"
        ));
        return;
    }
    let runner = match zcode_node() {
        Ok(runner) => runner,
        Err(reason) => {
            live_common::not_run(&reason);
            return;
        }
    };
    let Some(script) = live_common::cli_path(SCRIPT_ENV, DEFAULT_SCRIPT) else {
        live_common::not_run(&format!(
            "zcode script not found; set {SCRIPT_ENV} to the absolute zcode.cjs path"
        ));
        return;
    };

    let temp = tempfile::tempdir().expect("tempdir");
    // Deliberately do not forward the provider-config variables: the CLI then
    // cannot resolve its provider metadata and must fail with a typed
    // ADAPTER_UNAVAILABLE (never completed).
    let raw = live_common::base_config(temp.path(), &[], &[], zcode_config(runner, script));
    let config = RuntimeConfig::from_config(raw).expect("live zcode provider-config config");

    let result = live_common::run_job(config, "zcode").await;
    live_common::record_observed("zcode", "missing_provider_config", &result);
    live_common::assert_failed_typed(&result, "zcode");
}
