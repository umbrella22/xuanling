//! Live DeepSeek Harness (DSH) target.
//!
//! Opt in with `HARNESS_BRIDGE_LIVE_DSH=1`. The success test runs the real
//! `dsh --profile headless --json` CLI through the production supervisor and
//! requires the native `turn_end`/`final` answer `OK`.
//!
//! `DshConfig` exposes no model override, so there is no safe invalid-model
//! classification test here: a bad provider key would only exercise the
//! credential path, not an invalid-model path.
//!
//! Unset gate: one `not_run:` line is written to fd 2 and the test returns.

mod live_common;

use xuanling_harness_bridge::config::{AdapterConfigs, DshConfig, RuntimeConfig};

const GATE: &str = "HARNESS_BRIDGE_LIVE_DSH";
const PROGRAM_ENV: &str = "HARNESS_BRIDGE_LIVE_DSH";
const VERSION_ENV: &str = "HARNESS_BRIDGE_LIVE_DSH_VERSION";
const DEFAULT_PROGRAM: &str =
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const DEFAULT_VERSION: &str = "0.2.1";
/// Name only. The value is never read or printed by the test.
const PROVIDER_KEY: &str = "DEEPSEEK_API_KEY";

fn live_program() -> Option<std::path::PathBuf> {
    live_common::cli_path(PROGRAM_ENV, DEFAULT_PROGRAM)
}

/// Forward the provider key only when the launching environment actually has
/// it. Presence is checked without reading the value.
fn env_allowlist() -> Vec<&'static str> {
    if std::env::var_os(PROVIDER_KEY).is_some() {
        vec![PROVIDER_KEY]
    } else {
        Vec::new()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dsh_live_success_returns_native_final_answer() {
    if !live_common::live_gate(GATE) {
        live_common::not_run(&format!(
            "{GATE} is not set; dsh live success was not executed"
        ));
        return;
    }
    let Some(program) = live_program() else {
        live_common::not_run(&format!(
            "dsh CLI not found; set {PROGRAM_ENV} to the absolute dsh executable"
        ));
        return;
    };

    let temp = tempfile::tempdir().expect("tempdir");
    let version = live_common::cli_version(VERSION_ENV, DEFAULT_VERSION);
    let adapters = AdapterConfigs {
        dsh: Some(DshConfig {
            program,
            version,
            profile: "headless".to_string(),
        }),
        ..AdapterConfigs::default()
    };
    let allowlist = env_allowlist();
    let raw = live_common::base_config(temp.path(), &allowlist, &[PROVIDER_KEY], adapters);
    let config = RuntimeConfig::from_config(raw).expect("live dsh config");

    let result = live_common::run_job(config, "dsh").await;
    live_common::record_observed("dsh", "success", &result);
    live_common::assert_completed_ok(&result, "dsh");
}
