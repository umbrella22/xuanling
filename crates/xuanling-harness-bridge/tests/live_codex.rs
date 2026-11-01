//! Live Codex target.
//!
//! Opt in with `HARNESS_BRIDGE_LIVE_CODEX=1`. The success test runs the real
//! `codex exec --json` CLI through the production supervisor and requires the
//! native final answer `OK`; the classification test points the same adapter at
//! a model that does not exist and requires a typed `failed` result.
//!
//! Unset gate: one `not_run:` line is written to fd 2 and the test returns.

mod live_common;

use xuanling_harness_bridge::config::{AdapterConfigs, CodexConfig, RuntimeConfig};

const GATE: &str = "HARNESS_BRIDGE_LIVE_CODEX";
const PROGRAM_ENV: &str = "HARNESS_BRIDGE_LIVE_CODEX";
const VERSION_ENV: &str = "HARNESS_BRIDGE_LIVE_CODEX_VERSION";
const DEFAULT_PROGRAM: &str = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const DEFAULT_VERSION: &str = "0.165.0";
const INVALID_MODEL: &str = "definitely-not-a-real-model-xyz";

fn codex_config(program: std::path::PathBuf, model: Option<String>) -> (AdapterConfigs, String) {
    let version = live_common::cli_version(VERSION_ENV, DEFAULT_VERSION);
    let adapters = AdapterConfigs {
        codex: Some(CodexConfig {
            program,
            version: version.clone(),
            sandbox: "read-only".to_string(),
            skip_git_repo_check: true,
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
async fn codex_live_success_returns_native_final_answer() {
    if !live_common::live_gate(GATE) {
        live_common::not_run(&format!(
            "{GATE} is not set; codex live success was not executed"
        ));
        return;
    }
    let Some(program) = live_program() else {
        live_common::not_run(&format!(
            "codex CLI not found; set {PROGRAM_ENV} to the absolute codex executable"
        ));
        return;
    };

    let temp = tempfile::tempdir().expect("tempdir");
    let (adapters, _version) = codex_config(program, None);
    let raw = live_common::base_config(
        temp.path(),
        &["OPENAI_API_KEY", "CODEX_API_KEY"],
        &["OPENAI_API_KEY", "CODEX_API_KEY"],
        adapters,
    );
    let config = RuntimeConfig::from_config(raw).expect("live codex config");

    let result = live_common::run_job(config, "codex").await;
    live_common::record_observed("codex", "success", &result);
    live_common::assert_completed_ok(&result, "codex");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn codex_live_invalid_model_is_typed_failure() {
    if !live_common::live_gate(GATE) {
        live_common::not_run(&format!(
            "{GATE} is not set; codex invalid-model classification was not executed"
        ));
        return;
    }
    let Some(program) = live_program() else {
        live_common::not_run(&format!(
            "codex CLI not found; set {PROGRAM_ENV} to the absolute codex executable"
        ));
        return;
    };

    let temp = tempfile::tempdir().expect("tempdir");
    let (adapters, _version) = codex_config(program, Some(INVALID_MODEL.to_string()));
    let raw = live_common::base_config(
        temp.path(),
        &["OPENAI_API_KEY", "CODEX_API_KEY"],
        &["OPENAI_API_KEY", "CODEX_API_KEY"],
        adapters,
    );
    let config = RuntimeConfig::from_config(raw).expect("live codex invalid-model config");

    let result = live_common::run_job(config, "codex").await;
    live_common::record_observed("codex", "invalid_model", &result);
    live_common::assert_failed_typed(&result, "codex");
}
