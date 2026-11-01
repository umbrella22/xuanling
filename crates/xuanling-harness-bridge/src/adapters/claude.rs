//! Claude Code adapter.
//!
//! Verified invocation shape: `claude -p --output-format json
//! --permission-prompts none --permission-mode <mode>` with the task on stdin.
//! `is_error` is authoritative: a real failure sample reported
//! `"subtype":"success"` together with `"is_error":true` and exit 1.
//!
//! `bypassPermissions` is rejected at configuration time. The bridge neither
//! approves nor proxies permission prompts; with `--permission-prompts none`
//! anything that would prompt is denied by the CLI itself.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

use crate::adapters::{
    Adapter, AdapterCapabilities, CommandPlan, ensure_supported, require_absolute_file,
};
use crate::collector::{
    ByteBudget, Collected, Collector, Limits, RunOutcome, TailBuffer, append_diagnostic,
    bound_diagnostic, classify_failure_with_hint,
};
use crate::config::ClaudeConfig;
use crate::error::BridgeError;
use crate::redact::Redactor;
use crate::task::FrozenTask;

const MINIMUM_VERSION: (u64, u64, u64) = (2, 1, 0);

const PERMISSION_MODES: &[&str] = &["acceptEdits", "auto", "manual", "dontAsk", "plan"];

#[derive(Debug)]
pub struct ClaudeAdapter {
    program: PathBuf,
    version: String,
    compatible: bool,
    permission_mode: String,
    allowed_tools: Vec<String>,
    model: Option<String>,
}

impl ClaudeAdapter {
    pub fn new(config: &ClaudeConfig) -> Result<Self, BridgeError> {
        require_absolute_file(&config.program, "claude program")?;
        let compatible = ensure_supported(&config.version, MINIMUM_VERSION)?;
        if !PERMISSION_MODES.contains(&config.permission_mode.as_str()) {
            return Err(BridgeError::config(format!(
                "claude permission_mode must be one of {PERMISSION_MODES:?} (bypassPermissions is refused)"
            )));
        }
        Ok(Self {
            program: config.program.clone(),
            version: config.version.clone(),
            compatible,
            permission_mode: config.permission_mode.clone(),
            allowed_tools: config.allowed_tools.clone(),
            model: config.model.clone(),
        })
    }
}

impl Adapter for ClaudeAdapter {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn version(&self) -> &str {
        &self.version
    }

    fn minimum_version(&self) -> &'static str {
        "2.1.0"
    }

    fn compatible(&self) -> bool {
        self.compatible
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            non_interactive: true,
            needs_input: true,
        }
    }

    fn plan(&self, task: &FrozenTask) -> Result<CommandPlan, BridgeError> {
        let mut args = vec![
            "-p".to_string(),
            "--output-format".to_string(),
            "json".to_string(),
            "--permission-prompts".to_string(),
            "none".to_string(),
            "--permission-mode".to_string(),
            self.permission_mode.clone(),
        ];
        if !self.allowed_tools.is_empty() {
            args.push("--allowedTools".to_string());
            args.push(self.allowed_tools.join(","));
        }
        if let Some(model) = &self.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        Ok(CommandPlan {
            program: self.program.clone(),
            args,
            stdin: task.prompt.as_bytes().to_vec(),
            cwd: task.workspace_root.clone(),
            env: BTreeMap::new(),
        })
    }

    fn collector(&self, limits: Limits) -> Box<dyn Collector> {
        Box::new(ClaudeCollector::new(limits))
    }
}

pub struct ClaudeCollector {
    limits: Limits,
    stdout: ByteBudget,
    stderr: TailBuffer,
}

impl ClaudeCollector {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            stdout: ByteBudget::new(limits.max_protocol_bytes),
            stderr: TailBuffer::new(limits.max_diagnostic_bytes),
        }
    }
}

impl Collector for ClaudeCollector {
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

        if truncated {
            return Collected::stream_incomplete(
                "claude result object exceeds the protocol budget",
            )
            .with_diagnostic(diagnostic)
            .with_redaction(redacted);
        }
        let value: Value = match serde_json::from_str(text.trim()) {
            Ok(value) => value,
            Err(_) => {
                let mut collected =
                    Collected::stream_incomplete("claude output is not a single JSON result");
                if exit != 0 {
                    let message = diagnostic
                        .clone()
                        .unwrap_or_else(|| format!("worker exited with code {exit}"));
                    let code = classify_failure_with_hint(&message, stderr_hint);
                    collected.outcome = RunOutcome::Failed { code, message };
                }
                return collected
                    .with_diagnostic(diagnostic)
                    .with_redaction(redacted);
            }
        };

        let is_error = value
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let subtype = value.get("subtype").and_then(Value::as_str);
        let result = value
            .get("result")
            .and_then(Value::as_str)
            .map(str::to_string);
        let terminal_reason = value
            .get("terminal_reason")
            .and_then(Value::as_str)
            .unwrap_or("");
        let denials = value
            .get("permission_denials")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);

        if value.get("type").and_then(Value::as_str) != Some("result") {
            if exit != 0 {
                let message = diagnostic
                    .clone()
                    .unwrap_or_else(|| format!("worker exited with code {exit}"));
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
            return Collected::stream_incomplete("claude output is not a result object")
                .with_diagnostic(diagnostic)
                .with_redaction(redacted);
        }

        if is_error || exit != 0 || subtype != Some("success") {
            let mut message = result
                .clone()
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| {
                    format!(
                        "claude reported subtype={} terminal_reason={terminal_reason}",
                        subtype.unwrap_or("unknown")
                    )
                });
            append_diagnostic(&mut message, diagnostic.as_deref(), " | ");
            if denials > 0 && result.as_deref().is_none_or(str::is_empty) {
                return Collected {
                    outcome: RunOutcome::NeedsInput {
                        message: format!("claude denied {denials} permission prompt(s)"),
                    },
                    final_text: None,
                    output_complete: false,
                    diagnostic,
                    protocol_incomplete: false,
                    redacted,
                };
            }
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

        match result {
            Some(text) if !text.trim().is_empty() => Collected {
                outcome: RunOutcome::Completed,
                final_text: Some(text),
                output_complete: true,
                diagnostic,
                protocol_incomplete: false,
                redacted,
            },
            _ => Collected::stream_incomplete("claude success result has no final text")
                .with_diagnostic(diagnostic)
                .with_redaction(redacted),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn collect(stdout: &str, exit: i32) -> Collected {
        let mut collector = ClaudeCollector::new(Limits {
            max_final_bytes: 1 << 20,
            max_diagnostic_bytes: 4096,
            max_protocol_line_bytes: 1 << 20,
            max_protocol_bytes: 1 << 20,
        });
        collector.on_stdout(stdout.as_bytes());
        Box::new(collector).finish(Some(exit))
    }

    #[test]
    fn subtype_success_with_is_error_is_failed() {
        let fixture = r#"{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","api_error_status":403,"result":"Insufficient account balance"}"#;
        let collected = collect(fixture, 1);
        assert!(matches!(
            collected.outcome,
            RunOutcome::Failed {
                code: ErrorCode::AuthRequired,
                ..
            }
        ));
    }

    #[test]
    fn successful_result_is_returned() {
        let fixture = r#"{"type":"result","subtype":"success","is_error":false,"result":"OK"}"#;
        let collected = collect(fixture, 0);
        assert!(matches!(collected.outcome, RunOutcome::Completed));
        assert_eq!(collected.final_text.as_deref(), Some("OK"));
    }

    #[test]
    fn malformed_output_is_stream_incomplete() {
        let collected = collect("not json", 0);
        assert!(matches!(
            collected.outcome,
            RunOutcome::Failed {
                code: ErrorCode::StreamIncomplete,
                ..
            }
        ));
    }

    #[test]
    fn rejects_bypass_permissions() {
        let temp = tempfile::tempdir().expect("temp dir");
        let program = temp.path().join("claude");
        std::fs::write(&program, b"#!/bin/sh\n").expect("write program");
        let config = ClaudeConfig {
            program,
            version: "2.1.311".to_string(),
            permission_mode: "bypassPermissions".to_string(),
            allowed_tools: Vec::new(),
            model: None,
        };
        let error = ClaudeAdapter::new(&config).expect_err("bypass must be rejected");
        assert_eq!(error.code, ErrorCode::ConfigInvalid);
    }
}
