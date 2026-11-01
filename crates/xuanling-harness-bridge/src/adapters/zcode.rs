//! ZCode CLI adapter.
//!
//! Verified invocation: `node <zcode.cjs> --prompt <task> --json --mode <mode>
//! --cwd <workspace>`. `--prompt` defaults to `yolo`, so a mode is always
//! explicit and `yolo` is rejected at configuration time.
//!
//! `--json` prints one result object:
//! `{type:"result", sessionId, traceId, turnId?, response, usage?, eventCount,
//! projection:{status, turnCount, totalTokenCount, contextUsed, contextWindow}}`
//! on exit 0. Native failures write the diagnostic to stderr and exit non-zero
//! without a result object.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

use crate::adapters::{
    Adapter, AdapterCapabilities, CommandPlan, ensure_supported, require_absolute_file,
};
use crate::collector::{
    ByteBudget, Collected, Collector, Limits, RunOutcome, TailBuffer, bound_diagnostic,
    classify_failure_with_hint,
};
use crate::config::ZcodeConfig;
use crate::error::{BridgeError, ErrorCode};
use crate::redact::Redactor;
use crate::task::FrozenTask;

const MINIMUM_VERSION: (u64, u64, u64) = (0, 17, 0);
const MODES: &[&str] = &["build", "edit", "plan", "guarded"];
/// ZCode receives the task in argv. Keep well below the smallest supported
/// platform limit (Linux MAX_ARG_STRLEN is 128 KiB for one argument).
const MAX_ARGV_PROMPT_BYTES: usize = 120 * 1024;

#[derive(Debug)]
pub struct ZcodeAdapter {
    runner: PathBuf,
    script: PathBuf,
    version: String,
    compatible: bool,
    mode: String,
}

impl ZcodeAdapter {
    pub fn new(config: &ZcodeConfig) -> Result<Self, BridgeError> {
        require_absolute_file(&config.runner, "zcode runner")?;
        require_absolute_file(&config.script, "zcode script")?;
        let compatible = ensure_supported(&config.version, MINIMUM_VERSION)?;
        if !MODES.contains(&config.mode.as_str()) {
            return Err(BridgeError::config(format!(
                "zcode mode must be one of {MODES:?}; yolo bypasses approvals and is refused"
            )));
        }
        Ok(Self {
            runner: config.runner.clone(),
            script: config.script.clone(),
            version: config.version.clone(),
            compatible,
            mode: config.mode.clone(),
        })
    }
}

impl Adapter for ZcodeAdapter {
    fn id(&self) -> &'static str {
        "zcode"
    }

    fn version(&self) -> &str {
        &self.version
    }

    fn minimum_version(&self) -> &'static str {
        "0.17.0"
    }

    fn compatible(&self) -> bool {
        self.compatible
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            non_interactive: true,
            // The headless result object has no verified approval/input signal.
            needs_input: false,
        }
    }

    fn plan(&self, task: &FrozenTask) -> Result<CommandPlan, BridgeError> {
        if task.prompt.len() > MAX_ARGV_PROMPT_BYTES {
            return Err(BridgeError::invalid_request(format!(
                "zcode passes the task on the command line; prompt exceeds the                  {MAX_ARGV_PROMPT_BYTES}-byte argv-safe limit"
            )));
        }
        let args = vec![
            self.script.to_string_lossy().into_owned(),
            "--prompt".to_string(),
            task.prompt.clone(),
            "--json".to_string(),
            "--mode".to_string(),
            self.mode.clone(),
            "--cwd".to_string(),
            task.workspace_root.to_string_lossy().into_owned(),
        ];
        Ok(CommandPlan {
            program: self.runner.clone(),
            args,
            stdin: Vec::new(),
            cwd: task.workspace_root.clone(),
            env: BTreeMap::new(),
        })
    }

    fn collector(&self, limits: Limits) -> Box<dyn Collector> {
        Box::new(ZcodeCollector::new(limits))
    }
}

pub struct ZcodeCollector {
    limits: Limits,
    stdout: ByteBudget,
    stderr: TailBuffer,
}

impl ZcodeCollector {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            stdout: ByteBudget::new(limits.max_protocol_bytes),
            stderr: TailBuffer::new(limits.max_diagnostic_bytes),
        }
    }
}

impl Collector for ZcodeCollector {
    fn on_stdout(&mut self, chunk: &[u8]) {
        self.stdout.push(chunk);
    }

    fn on_stderr(&mut self, chunk: &[u8]) {
        self.stderr.push(chunk);
    }

    fn finish_redacted(self: Box<Self>, exit_code: Option<i32>, redactor: &Redactor) -> Collected {
        let limits = self.limits;
        let truncated = self.stdout.truncated;
        let stderr_hint = self.stderr.failure_hint();
        let (diagnostic, mut redacted) = self.stderr.redacted_text(redactor);
        let exit = exit_code.unwrap_or(-1);
        let text = self.stdout.text();
        let trimmed = text.trim();

        if truncated {
            return Collected::stream_incomplete("zcode result exceeds the protocol budget")
                .with_diagnostic(diagnostic)
                .with_redaction(redacted);
        }

        if trimmed.is_empty() {
            if exit != 0 {
                let full = diagnostic
                    .clone()
                    .unwrap_or_else(|| format!("worker exited with code {exit}"));
                let mut message = compact_native_error(&full);
                let code = classify_failure_with_hint(&message, stderr_hint);
                if code == ErrorCode::AdapterUnavailable {
                    message.push_str(
                        " | hint: export ZCODE_BUILTIN_PROVIDER_CONFIG_FILE and \
                         ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, then add both names to env_allowlist",
                    );
                }
                let (message, changed) = bound_diagnostic(&message, &limits, redactor);
                redacted |= changed;
                return Collected {
                    outcome: RunOutcome::Failed { code, message },
                    final_text: None,
                    output_complete: false,
                    diagnostic,
                    protocol_incomplete: false,
                    redacted,
                };
            }
            return Collected::stream_incomplete("zcode produced no result object")
                .with_diagnostic(diagnostic)
                .with_redaction(redacted);
        }

        let Some(value) = parse_result(trimmed) else {
            return Collected::stream_incomplete("zcode output is not a JSON result object")
                .with_diagnostic(diagnostic)
                .with_redaction(redacted);
        };

        // The installed CLI emits a single object with `response` and no
        // `type` field in the ordinary headless path; some versions/branches
        // include `"type":"result"`. Accept both, but never a different
        // explicit type.
        let is_result = value.get("type").and_then(Value::as_str) == Some("result")
            || (value.get("type").is_none()
                && value.get("response").and_then(Value::as_str).is_some());
        if !is_result {
            let message = value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("zcode reported an unrecognized object")
                .to_string();
            let code = classify_failure_with_hint(&message, stderr_hint);
            let (message, changed) = bound_diagnostic(&message, &limits, redactor);
            redacted |= changed;
            return Collected {
                outcome: RunOutcome::Failed { code, message },
                final_text: None,
                output_complete: false,
                diagnostic,
                protocol_incomplete: false,
                redacted,
            };
        }

        let response = value
            .get("response")
            .and_then(Value::as_str)
            .map(str::to_string);

        if value.pointer("/projection/status").and_then(Value::as_str) == Some("error") {
            return Collected {
                outcome: RunOutcome::Failed {
                    code: ErrorCode::WorkerFailed,
                    message: "zcode projection reports an error status".to_string(),
                },
                final_text: response,
                output_complete: false,
                diagnostic,
                protocol_incomplete: false,
                redacted,
            };
        }

        if exit != 0 {
            let message = format!("worker produced a result object but exited with code {exit}");
            let code = classify_failure_with_hint(&message, stderr_hint);
            return Collected {
                outcome: RunOutcome::Failed { code, message },
                final_text: response,
                output_complete: false,
                diagnostic,
                protocol_incomplete: false,
                redacted,
            };
        }

        match response {
            Some(text) if !text.trim().is_empty() => Collected {
                outcome: RunOutcome::Completed,
                final_text: Some(text),
                output_complete: true,
                diagnostic,
                protocol_incomplete: false,
                redacted,
            },
            _ => Collected::stream_incomplete("zcode result has no response text")
                .with_diagnostic(diagnostic)
                .with_redaction(redacted),
        }
    }
}

/// Parse the result object. Some shells prepend a log line, so fall back to the
/// last non-empty line before declaring the protocol unrecognized.
fn parse_result(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return Some(value);
    }
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .and_then(|line| serde_json::from_str::<Value>(line.trim()).ok())
}

/// Keep only the first and last non-empty diagnostic lines. The JS CLI can
/// print a large provider error object; the controller needs the native cause
/// and the final error line, not the whole dump.
fn compact_native_error(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    match (lines.first(), lines.last()) {
        (Some(first), Some(last)) if first != last => format!("{first} | {last}"),
        (Some(first), _) => (*first).to_string(),
        _ => "worker exited with an unrecognized native error".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn collect(stdout: &str, stderr: &str, exit: i32) -> Collected {
        let mut collector = ZcodeCollector::new(Limits {
            max_final_bytes: 1 << 20,
            max_diagnostic_bytes: 4096,
            max_protocol_line_bytes: 1 << 20,
            max_protocol_bytes: 1 << 20,
        });
        collector.on_stdout(stdout.as_bytes());
        collector.on_stderr(stderr.as_bytes());
        Box::new(collector).finish(Some(exit))
    }

    #[test]
    fn result_object_returns_response() {
        let fixture = r#"{"type":"result","sessionId":"sess_1","traceId":"t","response":"OK","eventCount":3,"projection":{"status":"idle","turnCount":1,"totalTokenCount":5,"contextUsed":1,"contextWindow":200000}}"#;
        let collected = collect(fixture, "", 0);
        assert!(matches!(collected.outcome, RunOutcome::Completed));
        assert_eq!(collected.final_text.as_deref(), Some("OK"));
    }

    #[test]
    fn empty_stdout_with_business_error_is_auth_failure() {
        let stderr =
            "ProviderBusinessError: Insufficient account balance\nError: Turn execution failed";
        let collected = collect("", stderr, 1);
        assert!(matches!(
            collected.outcome,
            RunOutcome::Failed {
                code: ErrorCode::AuthRequired,
                ..
            }
        ));
    }

    #[test]
    fn exit_zero_without_result_is_incomplete() {
        let collected = collect("", "", 0);
        assert!(matches!(
            collected.outcome,
            RunOutcome::Failed {
                code: ErrorCode::StreamIncomplete,
                ..
            }
        ));
    }

    #[test]
    fn rejects_yolo_and_accepts_a_known_mode() {
        let temp = tempfile::tempdir().expect("temp dir");
        let runner = temp.path().join("node");
        let script = temp.path().join("zcode.cjs");
        std::fs::write(&runner, b"#!/bin/sh\n").expect("write runner");
        std::fs::write(&script, b"// zcode\n").expect("write script");
        let base = ZcodeConfig {
            runner,
            script,
            version: "0.17.0".to_string(),
            mode: "yolo".to_string(),
        };
        let error = ZcodeAdapter::new(&base).expect_err("yolo must be rejected");
        assert_eq!(error.code, ErrorCode::ConfigInvalid);
        let valid = ZcodeConfig {
            mode: "plan".to_string(),
            ..base
        };
        assert!(ZcodeAdapter::new(&valid).is_ok());
    }

    #[test]
    fn rejects_prompts_above_the_argv_safe_limit() {
        let temp = tempfile::tempdir().expect("temp dir");
        let runner = temp.path().join("node");
        let script = temp.path().join("zcode.cjs");
        std::fs::write(&runner, b"#!/bin/sh\n").expect("write runner");
        std::fs::write(&script, b"// zcode\n").expect("write script");
        let adapter = ZcodeAdapter::new(&ZcodeConfig {
            runner,
            script,
            version: "0.17.0".to_string(),
            mode: "plan".to_string(),
        })
        .expect("adapter");
        let task = FrozenTask {
            adapter: "zcode".to_string(),
            workspace_id: "default".to_string(),
            workspace_root: temp.path().to_path_buf(),
            prompt: "x".repeat(MAX_ARGV_PROMPT_BYTES + 1),
            input_sha256: String::new(),
            task_file: None,
            save_result: false,
            deadline_at: None,
            payload_fingerprint: String::new(),
        };
        let error = adapter.plan(&task).expect_err("oversized argv prompt");
        assert_eq!(error.code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn result_without_type_field_is_accepted() {
        let fixture = r#"{"sessionId":"sess_1","traceId":"t","turnId":"turn_1","response":"OK","eventCount":3,"projection":{"status":"idle","turnCount":1,"totalTokenCount":5,"contextUsed":1,"contextWindow":200000}}"#;
        let collected = collect(fixture, "", 0);
        assert!(matches!(collected.outcome, RunOutcome::Completed));
        assert_eq!(collected.final_text.as_deref(), Some("OK"));
    }
}
