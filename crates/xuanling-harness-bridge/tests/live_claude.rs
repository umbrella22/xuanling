//! Live Claude Code target.
//!
//! Opt in with `HARNESS_BRIDGE_LIVE_CLAUDE=1`. The success test runs the real
//! `claude -p --output-format json` CLI through the production supervisor and
//! requires the native final answer `OK`; the classification test points the
//! same adapter at a model that does not exist and requires a typed `failed`
//! result.
//!
//! Unset gate: one `not_run:` line is written to fd 2 and the test returns.

mod live_common;

use xuanling_harness_bridge::config::{AdapterConfigs, ClaudeConfig, RuntimeConfig};

const GATE: &str = "HARNESS_BRIDGE_LIVE_CLAUDE";
const PROGRAM_ENV: &str = "HARNESS_BRIDGE_LIVE_CLAUDE";
const VERSION_ENV: &str = "HARNESS_BRIDGE_LIVE_CLAUDE_VERSION";
const DEFAULT_PROGRAM: &str = "/Users/ikaros/.vscode/extensions/anthropic.claude-code-2.1.311-darwin-arm64/resources/native-binary/claude";
const DEFAULT_VERSION: &str = "2.1.311";
const INVALID_MODEL: &str = "definitely-not-a-real-model-xyz";

fn claude_config(program: std::path::PathBuf, model: Option<String>) -> (AdapterConfigs, String) {
    let version = live_common::cli_version(VERSION_ENV, DEFAULT_VERSION);
    let adapters = AdapterConfigs {
        claude: Some(ClaudeConfig {
            program,
            version: version.clone(),
            permission_mode: "manual".to_string(),
            allowed_tools: Vec::new(),
            model,
        }),
        ..AdapterConfigs::default()
    };
    (adapters, version)
}

fn live_program() -> Option<std::path::PathBuf> {
    live_common::cli_path(PROGRAM_ENV, DEFAULT_PROGRAM)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_live_success_returns_native_final_answer() {
    if !live_common::live_gate(GATE) {
        live_common::not_run(&format!(
            "{GATE} is not set; claude live success was not executed"
        ));
        return;
    }
    let Some(program) = live_program() else {
        live_common::not_run(&format!(
            "claude CLI not found; set {PROGRAM_ENV} to the absolute claude executable"
        ));
        return;
    };

    let temp = tempfile::tempdir().expect("tempdir");
    let (adapters, _version) = claude_config(program, None);
    let raw = live_common::base_config(
        temp.path(),
        &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
        &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
        adapters,
    );
    let config = RuntimeConfig::from_config(raw).expect("live claude config");

    let result = live_common::run_job(config, "claude").await;
    live_common::record_observed("claude", "success", &result);
    live_common::assert_completed_ok(&result, "claude");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_live_invalid_model_is_typed_failure() {
    if !live_common::live_gate(GATE) {
        live_common::not_run(&format!(
            "{GATE} is not set; claude invalid-model classification was not executed"
        ));
        return;
    }
    let Some(program) = live_program() else {
        live_common::not_run(&format!(
            "claude CLI not found; set {PROGRAM_ENV} to the absolute claude executable"
        ));
        return;
    };

    let temp = tempfile::tempdir().expect("tempdir");
    let (adapters, _version) = claude_config(program, Some(INVALID_MODEL.to_string()));
    let raw = live_common::base_config(
        temp.path(),
        &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
        &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
        adapters,
    );
    let config = RuntimeConfig::from_config(raw).expect("live claude invalid-model config");

    let result = live_common::run_job(config, "claude").await;
    live_common::record_observed("claude", "invalid_model", &result);
    live_common::assert_failed_typed(&result, "claude");
}
