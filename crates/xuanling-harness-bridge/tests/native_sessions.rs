//! Native session persistence is forbidden independently of final MD export.
use std::sync::Arc;

use xuanling_harness_bridge::config::{BridgeConfig, RuntimeConfig};
use xuanling_harness_bridge::jobs::Registry;
use xuanling_harness_bridge::task::{FrozenTask, SubmitInput};

fn runtime(root: &std::path::Path) -> RuntimeConfig {
    let program = std::env::current_exe().expect("test executable");
    let raw: BridgeConfig = serde_json::from_value(serde_json::json!({
        "workspaces": {"test": root},
        "adapters": {
            "codex": {"program": program, "version": "0.165.0"},
            "claude": {"program": program, "version": "2.1.311"},
            "dsh": {"program": program, "version": "0.2.1-rc.3"},
            "zcode": {"runner": program, "script": program, "version": "0.17.0", "mode": "plan"}
        }
    }))
    .expect("config");
    RuntimeConfig::from_config(raw).expect("runtime")
}

fn task(root: &std::path::Path, adapter: &str, save_result: bool) -> FrozenTask {
    FrozenTask {
        adapter: adapter.to_string(),
        workspace_id: "test".to_string(),
        workspace_root: root.to_path_buf(),
        prompt: "Return the final answer".to_string(),
        input_sha256: String::new(),
        task_file: None,
        save_result,
        deadline_at: None,
        payload_fingerprint: String::new(),
    }
}

#[test]
fn final_md_selection_cannot_enable_codex_or_claude_native_sessions() {
    let dir = tempfile::tempdir().expect("directory");
    let runtime = runtime(dir.path());
    for save_result in [false, true] {
        for (adapter, flag) in [
            ("codex", "--ephemeral"),
            ("claude", "--no-session-persistence"),
        ] {
            let plan = runtime
                .adapter(adapter)
                .expect("adapter")
                .plan(&task(dir.path(), adapter, save_result))
                .expect("plan");
            assert!(
                plan.args.iter().any(|arg| arg == flag),
                "{adapter} must disable native session persistence even with save_result={save_result}"
            );
        }
    }
}

#[test]
fn unverified_native_persistence_policy_rejects_before_job_acceptance() {
    let dir = tempfile::tempdir().expect("directory");
    let registry = Registry::new(Arc::new(runtime(dir.path())));
    for adapter in ["dsh", "zcode"] {
        let request = SubmitInput {
            instance_id: registry.instance_id().to_string(),
            request_id: format!("no-native-session-{adapter}"),
            adapter: adapter.to_string(),
            workspace_id: "test".to_string(),
            prompt: Some("Return the final answer".to_string()),
            task_file: None,
            save_result: false,
            deadline_at: None,
        };
        let error = registry
            .submit(request)
            .expect_err("unverified persistence policy must reject");
        assert_eq!(
            error.code.as_str(),
            "NATIVE_SESSION_PERSISTENCE_UNSUPPORTED"
        );
        assert_eq!(registry.retained_jobs(), 0, "rejection cannot retain a job");
        assert!(
            registry
                .config
                .adapter(adapter)
                .expect("adapter")
                .plan(&task(dir.path(), adapter, false))
                .is_err()
        );
    }
}
