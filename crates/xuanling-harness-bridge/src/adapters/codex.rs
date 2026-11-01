//! Codex CLI adapter.
//!
//! Verified invocation (codex-cli 0.165.0-alpha.1.2):
//! `codex exec --json -s read-only --skip-git-repo-check -` with the task on
//! stdin. Success requires a `turn.completed` event, an `agent_message` item
//! and exit 0. `turn.failed` is a native failure even when a partial answer was
//! printed.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

use crate::adapters::{
    Adapter, AdapterCapabilities, CommandPlan, ensure_supported, require_absolute_file,
};
use crate::collector::{
    Collected, Collector, Limits, LineFramer, RunOutcome, TailBuffer, append_diagnostic,
    bound_diagnostic, classify_failure_with_hint,
};
use crate::config::CodexConfig;
use crate::error::BridgeError;
use crate::redact::Redactor;
use crate::task::FrozenTask;

const MINIMUM_VERSION: (u64, u64, u64) = (0, 160, 0);

#[derive(Debug)]
pub struct CodexAdapter {
    program: PathBuf,
    version: String,
    compatible: bool,
    sandbox: String,
    skip_git_repo_check: bool,
    model: Option<String>,
}

impl CodexAdapter {
    pub fn new(config: &CodexConfig) -> Result<Self, BridgeError> {
        require_absolute_file(&config.program, "codex program")?;
        let compatible = ensure_supported(&config.version, MINIMUM_VERSION)?;
        match config.sandbox.as_str() {
            "read-only" | "workspace-write" | "danger-full-access" => {}
            other => {
                return Err(BridgeError::config(format!(
                    "codex sandbox must be read-only, workspace-write or danger-full-access: {other}"
                )));
            }
        }
        Ok(Self {
            program: config.program.clone(),
            version: config.version.clone(),
            compatible,
            sandbox: config.sandbox.clone(),
            skip_git_repo_check: config.skip_git_repo_check,
            model: config.model.clone(),
        })
    }
}

impl Adapter for CodexAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn version(&self) -> &str {
        &self.version
    }

    fn minimum_version(&self) -> &'static str {
        "0.160.0"
    }

    fn compatible(&self) -> bool {
        self.compatible
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            non_interactive: true,
            needs_input: false,
        }
    }

    fn plan(&self, task: &FrozenTask) -> Result<CommandPlan, BridgeError> {
        let mut args = vec![
            "exec".to_string(),
            "--json".to_string(),
            "-s".to_string(),
            self.sandbox.clone(),
        ];
        if self.skip_git_repo_check {
            args.push("--skip-git-repo-check".to_string());
        }
        if let Some(model) = &self.model {
            args.push("-m".to_string());
            args.push(model.clone());
        }
        args.push("-".to_string());
        Ok(CommandPlan {
            program: self.program.clone(),
            args,
            stdin: task.prompt.as_bytes().to_vec(),
            cwd: task.workspace_root.clone(),
            env: BTreeMap::new(),
        })
    }

    fn collector(&self, limits: Limits) -> Box<dyn Collector> {
        Box::new(CodexCollector::new(limits))
    }
}

pub struct CodexCollector {
    limits: Limits,
    framer: LineFramer,
    turn_completed: bool,
    failure: Option<String>,
    final_text: Option<String>,
    invalid_events: usize,
    stderr: TailBuffer,
}

impl CodexCollector {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            framer: LineFramer::new(limits.max_protocol_line_bytes),
            turn_completed: false,
            failure: None,
            final_text: None,
            invalid_events: 0,
            stderr: TailBuffer::new(limits.max_diagnostic_bytes),
        }
    }
}

impl Collector for CodexCollector {
    fn on_stdout(&mut self, chunk: &[u8]) {
        let Self {
            framer,
            turn_completed,
            failure,
            final_text,
            invalid_events,
            ..
        } = self;
        framer.push(chunk, |line| {
            handle_event(line, turn_completed, failure, final_text, invalid_events)
        });
    }

    fn on_stderr(&mut self, chunk: &[u8]) {
        self.stderr.push(chunk);
    }

    fn finish_redacted(self: Box<Self>, exit_code: Option<i32>, redactor: &Redactor) -> Collected {
        let Self {
            mut framer,
            mut turn_completed,
            mut failure,
            mut final_text,
            mut invalid_events,
            stderr,
            limits,
        } = *self;
        framer.finish(|line| {
            handle_event(
                line,
                &mut turn_completed,
                &mut failure,
                &mut final_text,
                &mut invalid_events,
            );
        });
        let protocol_incomplete = framer.overflow || invalid_events > 0;
        let stderr_hint = stderr.failure_hint();
        let (diagnostic, mut redacted) = stderr.redacted_text(redactor);
        let exit = exit_code.unwrap_or(-1);

        if let Some(mut text) = failure {
            append_diagnostic(&mut text, diagnostic.as_deref(), " | ");
            let code = classify_failure_with_hint(&text, stderr_hint);
            let (message, changed) = bound_diagnostic(&text, &limits, redactor);
            redacted |= changed;
            return Collected {
                outcome: RunOutcome::Failed { code, message },
                final_text,
                output_complete: false,
                diagnostic,
                protocol_incomplete,
                redacted,
            };
        }

        if exit != 0 {
            let mut text = format!("worker exited with code {exit}");
            append_diagnostic(&mut text, diagnostic.as_deref(), " ");
            let code = classify_failure_with_hint(&text, stderr_hint);
            return Collected {
                outcome: RunOutcome::Failed {
                    code,
                    message: text,
                },
                final_text,
                output_complete: false,
                diagnostic,
                protocol_incomplete,
                redacted,
            };
        }

        if !turn_completed {
            return Collected::stream_incomplete("native turn.completed event missing")
                .with_diagnostic(diagnostic)
                .with_redaction(redacted);
        }
        match final_text {
            Some(text) if !text.trim().is_empty() => Collected {
                outcome: RunOutcome::Completed,
                final_text: Some(text),
                output_complete: !protocol_incomplete,
                diagnostic,
                protocol_incomplete,
                redacted,
            },
            _ => Collected::stream_incomplete("native final agent message missing")
                .with_diagnostic(diagnostic)
                .with_redaction(redacted),
        }
    }
}

fn handle_event(
    line: &[u8],
    turn_completed: &mut bool,
    failure: &mut Option<String>,
    final_text: &mut Option<String>,
    invalid_events: &mut usize,
) {
    let value: Value = match serde_json::from_slice(line) {
        Ok(value) => value,
        Err(_) => {
            *invalid_events = invalid_events.saturating_add(1);
            return;
        }
    };
    match value.get("type").and_then(Value::as_str) {
        Some("turn.completed") => *turn_completed = true,
        Some("turn.failed") => {
            let message = value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("codex turn failed")
                .to_string();
            *failure = Some(message);
        }
        Some("error") => {
            // A stream-level error without `turn.failed` still prevents the
            // run from being reported as completed.
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("codex reported an error")
                .to_string();
            *failure = Some(message);
        }
        Some("item.completed") => {
            let item = value.get("item");
            let is_agent_message = item
                .and_then(|item| item.get("type"))
                .and_then(Value::as_str)
                == Some("agent_message");
            if is_agent_message
                && let Some(text) = item
                    .and_then(|item| item.get("text"))
                    .and_then(Value::as_str)
            {
                *final_text = Some(text.to_string());
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn run(stdout: &[u8], exit: i32) -> Collected {
        let mut collector = CodexCollector::new(Limits {
            max_final_bytes: 1 << 20,
            max_diagnostic_bytes: 4096,
            max_protocol_line_bytes: 1 << 20,
            max_protocol_bytes: 1 << 20,
        });
        collector.on_stdout(stdout);
        Box::new(collector).finish(Some(exit))
    }

    #[test]
    fn completed_turn_returns_agent_message() {
        let fixture = concat!(
            r#"{"type":"thread.started","thread_id":"t"}"#,
            "\n",
            r#"{"type":"turn.started"}"#,
            "\n",
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}"#,
            "\n",
            r#"{"type":"turn.completed"}"#,
            "\n"
        );
        let collected = run(fixture.as_bytes(), 0);
        assert!(matches!(collected.outcome, RunOutcome::Completed));
        assert_eq!(collected.final_text.as_deref(), Some("OK"));
        assert!(collected.output_complete);
    }

    #[test]
    fn turn_failed_is_never_completed() {
        let fixture = concat!(
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}"#,
            "\n",
            r#"{"type":"turn.failed","error":{"message":"model unsupported"}}"#,
            "\n"
        );
        let collected = run(fixture.as_bytes(), 0);
        assert!(matches!(
            collected.outcome,
            RunOutcome::Failed {
                code: ErrorCode::WorkerFailed,
                ..
            }
        ));
        assert!(!collected.output_complete);
    }

    #[test]
    fn missing_terminal_event_is_stream_incomplete() {
        let fixture = r#"{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}"#;
        let collected = run(fixture.as_bytes(), 0);
        assert!(matches!(
            collected.outcome,
            RunOutcome::Failed {
                code: ErrorCode::StreamIncomplete,
                ..
            }
        ));
    }

    #[test]
    fn rejects_unknown_sandbox() {
        let temp = tempfile::tempdir().expect("temp dir");
        let program = temp.path().join("codex");
        std::fs::write(&program, b"#!/bin/sh\n").expect("write program");
        let config = CodexConfig {
            program,
            version: "0.165.0".to_string(),
            sandbox: "unsafe".to_string(),
            skip_git_repo_check: true,
            model: None,
        };
        let error = CodexAdapter::new(&config).expect_err("unknown sandbox must be rejected");
        assert_eq!(error.code, ErrorCode::ConfigInvalid);
    }
}
