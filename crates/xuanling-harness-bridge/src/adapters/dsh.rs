//! DeepSeek Harness headless adapter.
//!
//! Verified invocation: `dsh --profile headless --json -` with the task on
//! stdin. The JSON projection writes `session`, `status`, `text`/`thinking`,
//! `tool_call`/`tool_result`, `final`, and run-level `error` events.
//! Execution is blocked until native session suppression is verified. The
//! collector below continues to decode historical and synthetic fixtures.
//!
//! According to the installed headless runner, a failed turn still ends with a
//! `final` event (often empty) and exit code 1; the `turn_end` reason is the
//! authoritative signal. Success therefore requires exit 0, a `completed`
//! turn_end reason, a non-empty final text and no run-level error event.

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
use crate::config::DshConfig;
use crate::error::{BridgeError, ErrorCode};
use crate::redact::Redactor;
use crate::task::FrozenTask;

const MINIMUM_VERSION: (u64, u64, u64) = (0, 2, 0);
const NON_INTERACTIVE_PROFILE: &str = "headless";

struct TurnEnd {
    kind: String,
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug)]
pub struct DshAdapter {
    program: PathBuf,
    version: String,
    compatible: bool,
}

impl DshAdapter {
    pub fn new(config: &DshConfig) -> Result<Self, BridgeError> {
        require_absolute_file(&config.program, "dsh program")?;
        let compatible = ensure_supported(&config.version, MINIMUM_VERSION)?;
        if config.profile != NON_INTERACTIVE_PROFILE {
            return Err(BridgeError::config(format!(
                "dsh profile must be {NON_INTERACTIVE_PROFILE} for non-interactive execution"
            )));
        }
        Ok(Self {
            program: config.program.clone(),
            version: config.version.clone(),
            compatible,
        })
    }
}

impl Adapter for DshAdapter {
    fn id(&self) -> &'static str {
        "dsh"
    }

    fn version(&self) -> &str {
        &self.version
    }

    fn minimum_version(&self) -> &'static str {
        "0.2.0"
    }

    fn compatible(&self) -> bool {
        self.compatible
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            native_session_persistence_disabled: false,
            non_interactive: true,
            needs_input: true,
        }
    }

    fn plan(&self, task: &FrozenTask) -> Result<CommandPlan, BridgeError> {
        super::require_no_native_sessions(self)?;
        Ok(CommandPlan {
            program: self.program.clone(),
            args: vec![
                "--profile".to_string(),
                NON_INTERACTIVE_PROFILE.to_string(),
                "--json".to_string(),
                "-".to_string(),
            ],
            stdin: task.prompt.as_bytes().to_vec(),
            cwd: task.workspace_root.clone(),
            env: BTreeMap::new(),
        })
    }

    fn collector(&self, limits: Limits) -> Box<dyn Collector> {
        Box::new(DshCollector::new(limits))
    }
}

pub struct DshCollector {
    limits: Limits,
    framer: LineFramer,
    turn_end: Option<TurnEnd>,
    final_text: Option<String>,
    error_event: Option<String>,
    invalid_events: usize,
    stderr: TailBuffer,
}

impl DshCollector {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            framer: LineFramer::new(limits.max_protocol_line_bytes),
            turn_end: None,
            final_text: None,
            error_event: None,
            invalid_events: 0,
            stderr: TailBuffer::new(limits.max_diagnostic_bytes),
        }
    }
}

impl Collector for DshCollector {
    fn on_stdout(&mut self, chunk: &[u8]) {
        let Self {
            framer,
            turn_end,
            final_text,
            error_event,
            invalid_events,
            ..
        } = self;
        framer.push(chunk, |line| {
            handle_event(line, turn_end, final_text, error_event, invalid_events)
        });
    }

    fn on_stderr(&mut self, chunk: &[u8]) {
        self.stderr.push(chunk);
    }

    fn finish_redacted(self: Box<Self>, exit_code: Option<i32>, redactor: &Redactor) -> Collected {
        let Self {
            mut framer,
            mut turn_end,
            mut final_text,
            mut error_event,
            mut invalid_events,
            stderr,
            limits,
        } = *self;
        framer.finish(|line| {
            handle_event(
                line,
                &mut turn_end,
                &mut final_text,
                &mut error_event,
                &mut invalid_events,
            );
        });
        let protocol_incomplete = framer.overflow || invalid_events > 0;
        let stderr_hint = stderr.failure_hint();
        let (diagnostic, mut redacted) = stderr.redacted_text(redactor);
        let exit = exit_code.unwrap_or(-1);

        if let Some(mut text) = error_event {
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

        let Some(turn_end) = turn_end else {
            if exit != 0 {
                let message = diagnostic
                    .clone()
                    .unwrap_or_else(|| format!("worker exited with code {exit}"));
                let code = classify_failure_with_hint(&message, stderr_hint);
                let (message, changed) = bound_diagnostic(&message, &limits, redactor);
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
            return Collected::stream_incomplete("native turn_end event missing")
                .with_diagnostic(diagnostic)
                .with_redaction(redacted);
        };

        match turn_end.kind.as_str() {
            "completed" => {
                if exit != 0 {
                    let mut message = format!("worker exited with code {exit}");
                    append_diagnostic(&mut message, diagnostic.as_deref(), " ");
                    let code = classify_failure_with_hint(&message, stderr_hint);
                    return Collected {
                        outcome: RunOutcome::Failed { code, message },
                        final_text,
                        output_complete: false,
                        diagnostic,
                        protocol_incomplete,
                        redacted,
                    };
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
                    _ => Collected::stream_incomplete("native final event is empty")
                        .with_diagnostic(diagnostic)
                        .with_redaction(redacted),
                }
            }
            "blocked" => Collected {
                outcome: RunOutcome::NeedsInput {
                    message: "worker turn was blocked awaiting input or approval".to_string(),
                },
                final_text,
                output_complete: false,
                diagnostic,
                protocol_incomplete,
                redacted,
            },
            kind => {
                let native = match (&turn_end.code, &turn_end.message) {
                    (Some(code), Some(message)) => format!("{code}: {message}"),
                    (Some(code), None) => code.clone(),
                    (None, Some(message)) => message.clone(),
                    (None, None) => format!("native turn ended with reason {kind}"),
                };
                let mut text = native;
                append_diagnostic(&mut text, diagnostic.as_deref(), " | ");
                let code = if kind == "error" {
                    classify_failure_with_hint(&text, stderr_hint)
                } else {
                    ErrorCode::WorkerFailed
                };
                let (message, changed) = bound_diagnostic(&text, &limits, redactor);
                redacted |= changed;
                Collected {
                    outcome: RunOutcome::Failed { code, message },
                    final_text,
                    output_complete: false,
                    diagnostic,
                    protocol_incomplete,
                    redacted,
                }
            }
        }
    }
}

fn handle_event(
    line: &[u8],
    turn_end: &mut Option<TurnEnd>,
    final_text: &mut Option<String>,
    error_event: &mut Option<String>,
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
        Some("session") => {}
        Some("status") => {
            if value.get("phase").and_then(Value::as_str) != Some("turn_end") {
                return;
            }
            let Some(reason) = value.get("reason") else {
                return;
            };
            let kind = reason
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let error = reason.get("error");
            *turn_end = Some(TurnEnd {
                kind,
                code: error
                    .and_then(|error| error.get("code"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                message: error
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
        Some("final") => {
            if let Some(text) = value.get("text").and_then(Value::as_str) {
                *final_text = Some(text.to_string());
            }
        }
        Some("error") => {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("dsh reported an error")
                .to_string();
            *error_event = Some(message);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(stdout: &str, exit: i32) -> Collected {
        let mut collector = DshCollector::new(Limits {
            max_final_bytes: 1 << 20,
            max_diagnostic_bytes: 4096,
            max_protocol_line_bytes: 1 << 20,
            max_protocol_bytes: 1 << 20,
        });
        collector.on_stdout(stdout.as_bytes());
        Box::new(collector).finish(Some(exit))
    }

    #[test]
    fn completed_turn_returns_final_text() {
        let fixture = concat!(
            r#"{"type":"session","sessionId":"s","cwd":"/tmp"}"#,
            "\n",
            r#"{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}"#,
            "\n",
            r#"{"type":"final","text":"OK"}"#,
            "\n"
        );
        let collected = collect(fixture, 0);
        assert!(matches!(collected.outcome, RunOutcome::Completed));
        assert_eq!(collected.final_text.as_deref(), Some("OK"));
    }

    #[test]
    fn error_reason_with_exit_zero_is_not_success() {
        let fixture = concat!(
            r#"{"type":"session","sessionId":"s"}"#,
            "\n",
            r#"{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"code":"MISSING_CREDENTIAL","message":"no API key"}}}"#,
            "\n",
            r#"{"type":"final","text":""}"#,
            "\n"
        );
        let collected = collect(fixture, 0);
        assert!(matches!(
            collected.outcome,
            RunOutcome::Failed {
                code: ErrorCode::AuthRequired,
                ..
            }
        ));
    }

    #[test]
    fn blocked_turn_needs_input() {
        let fixture = concat!(
            r#"{"type":"session","sessionId":"s"}"#,
            "\n",
            r#"{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"blocked"}}"#,
            "\n",
            r#"{"type":"final","text":""}"#,
            "\n"
        );
        let collected = collect(fixture, 0);
        assert!(matches!(collected.outcome, RunOutcome::NeedsInput { .. }));
    }

    #[test]
    fn empty_final_on_completed_turn_is_incomplete() {
        let fixture = concat!(
            r#"{"type":"session","sessionId":"s"}"#,
            "\n",
            r#"{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}"#,
            "\n",
            r#"{"type":"final","text":""}"#,
            "\n"
        );
        let collected = collect(fixture, 0);
        assert!(matches!(
            collected.outcome,
            RunOutcome::Failed {
                code: ErrorCode::StreamIncomplete,
                ..
            }
        ));
    }

    #[test]
    fn rejects_non_headless_profile() {
        let temp = tempfile::tempdir().expect("temp dir");
        let program = temp.path().join("dsh");
        std::fs::write(&program, b"#!/bin/sh\n").expect("write program");
        let config = DshConfig {
            program,
            version: "0.2.1".to_string(),
            profile: "web".to_string(),
        };
        let error = DshAdapter::new(&config).expect_err("web profile must be rejected");
        assert_eq!(error.code, ErrorCode::ConfigInvalid);
    }
}
