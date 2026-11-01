//! Shared integration-test harness.
//!
//! The test adapter drives the real supervision path (spawn, pipes, bounded
//! framing, cancellation, cleanup, report) with the compiled fake-worker binary.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use xuanling_harness_bridge::adapters::{Adapter, AdapterCapabilities, CommandPlan};
use xuanling_harness_bridge::collector::{
    Collected, Collector, Limits, LineFramer, RunOutcome, TailBuffer, classify_failure_with_hint,
};
use xuanling_harness_bridge::config::{BridgeConfig, RuntimeConfig};
use xuanling_harness_bridge::error::BridgeError;
use xuanling_harness_bridge::jobs::{FinalResult, Registry};
use xuanling_harness_bridge::redact::Redactor;
use xuanling_harness_bridge::supervisor;
use xuanling_harness_bridge::task::{FrozenTask, SubmitInput};

pub const TEST_ADAPTER: &str = "test";

pub fn fake_worker() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_harness-bridge-fake-worker"))
}

#[derive(Debug, Deserialize)]
pub struct Scenario {
    pub scenario: String,
    #[serde(default = "default_text")]
    pub text: String,
    #[serde(default)]
    pub stderr: String,
    #[serde(default)]
    pub sleep_ms: u64,
    #[serde(default)]
    pub size: usize,
    #[serde(default)]
    pub pid_file: Option<String>,
}

fn default_text() -> String {
    "OK".to_string()
}

impl Scenario {
    pub fn json(&self) -> String {
        serde_json::json!({
            "scenario": self.scenario,
            "text": self.text,
            "stderr": self.stderr,
            "sleep_ms": self.sleep_ms,
            "size": self.size,
            "pid_file": self.pid_file,
        })
        .to_string()
    }
}

pub struct TestAdapter {
    program: PathBuf,
}

impl TestAdapter {
    pub fn new() -> Self {
        Self {
            program: fake_worker(),
        }
    }

    /// Adapter whose program path does not exist, used to exercise spawn
    /// failure settlement and report publication.
    pub fn with_missing_program(temp: &Path) -> Self {
        Self {
            program: temp.join("missing-worker"),
        }
    }
}

impl Adapter for TestAdapter {
    fn id(&self) -> &'static str {
        TEST_ADAPTER
    }

    fn version(&self) -> &str {
        "test-1"
    }

    fn minimum_version(&self) -> &'static str {
        "0.0.0"
    }

    fn compatible(&self) -> bool {
        true
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            non_interactive: true,
            needs_input: false,
        }
    }

    fn plan(&self, task: &FrozenTask) -> Result<CommandPlan, BridgeError> {
        let scenario: Scenario = serde_json::from_str(&task.prompt).unwrap_or(Scenario {
            scenario: task.prompt.clone(),
            text: "OK".to_string(),
            stderr: String::new(),
            sleep_ms: 0,
            size: 0,
            pid_file: None,
        });
        let mut args = vec![
            "--scenario".to_string(),
            scenario.scenario,
            "--text".to_string(),
            scenario.text,
            "--sleep-ms".to_string(),
            scenario.sleep_ms.to_string(),
        ];
        if !scenario.stderr.is_empty() {
            args.push("--stderr".to_string());
            args.push(scenario.stderr);
        }
        if scenario.size > 0 {
            args.push("--size".to_string());
            args.push(scenario.size.to_string());
        }
        if let Some(pid_file) = scenario.pid_file {
            args.push("--pid-file".to_string());
            args.push(pid_file);
        }
        Ok(CommandPlan {
            program: self.program.clone(),
            args,
            stdin: Vec::new(),
            cwd: task.workspace_root.clone(),
            env: BTreeMap::new(),
        })
    }

    fn collector(&self, limits: Limits) -> Box<dyn Collector> {
        Box::new(TestCollector::new(limits))
    }
}

pub struct TestCollector {
    limits: Limits,
    framer: LineFramer,
    final_text: Option<String>,
    invalid_events: usize,
    stderr: TailBuffer,
}

impl TestCollector {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            framer: LineFramer::new(limits.max_protocol_line_bytes),
            final_text: None,
            invalid_events: 0,
            stderr: TailBuffer::new(limits.max_diagnostic_bytes),
        }
    }
}

impl Collector for TestCollector {
    fn on_stdout(&mut self, chunk: &[u8]) {
        let mut events = Vec::new();
        self.framer.push(chunk, |line| events.push(line.to_vec()));
        for line in events {
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) else {
                self.invalid_events += 1;
                continue;
            };
            if value.get("type").and_then(|value| value.as_str()) == Some("final")
                && let Some(text) = value.get("text").and_then(|value| value.as_str())
            {
                self.final_text = Some(text.to_string());
            }
        }
    }

    fn on_stderr(&mut self, chunk: &[u8]) {
        self.stderr.push(chunk);
    }

    fn finish_redacted(self: Box<Self>, exit_code: Option<i32>, redactor: &Redactor) -> Collected {
        let Self {
            limits,
            mut framer,
            mut final_text,
            invalid_events,
            stderr,
        } = *self;
        let mut trailing = Vec::new();
        framer.finish(|line| trailing.push(line.to_vec()));
        for line in trailing {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line)
                && value.get("type").and_then(|value| value.as_str()) == Some("final")
                && let Some(text) = value.get("text").and_then(|value| value.as_str())
            {
                final_text = Some(text.to_string());
            }
        }
        let overflow = framer.overflow;
        let stderr_hint = stderr.failure_hint();
        let (diagnostic, mut redacted) = stderr.redacted_text(redactor);
        let exit = exit_code.unwrap_or(-1);
        let protocol_incomplete = overflow || invalid_events > 0;

        if exit != 0 {
            let message = diagnostic
                .clone()
                .unwrap_or_else(|| format!("worker exited with code {exit}"));
            let code = classify_failure_with_hint(&message, stderr_hint);
            let (message, changed) =
                xuanling_harness_bridge::collector::bound_diagnostic(&message, &limits, redactor);
            redacted |= changed;
            return Collected {
                outcome: RunOutcome::Failed { code, message },
                final_text: final_text.take(),
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
            _ => Collected::stream_incomplete("test protocol final event missing")
                .with_diagnostic(diagnostic)
                .with_redaction(redacted),
        }
    }
}

pub fn limits() -> Limits {
    Limits {
        max_final_bytes: 64 << 10,
        max_diagnostic_bytes: 2048,
        max_protocol_line_bytes: 64 << 10,
        max_protocol_bytes: 1 << 20,
    }
}

/// Build an instance-local config with a controllable fake adapter.
pub fn config(temp: &Path, results_dir: Option<PathBuf>, max_active_jobs: usize) -> RuntimeConfig {
    let raw = BridgeConfig {
        max_active_jobs,
        max_retained_jobs: 64,
        max_final_bytes: 64 << 10,
        max_diagnostic_bytes: 2048,
        max_protocol_line_bytes: 64 << 10,
        max_protocol_bytes: 1 << 20,
        max_prompt_bytes: 64 << 10,
        results_dir,
        workspaces: BTreeMap::from([("test".to_string(), temp.to_path_buf())]),
        env_allowlist: Vec::new(),
        secret_env: Vec::new(),
        adapters: Default::default(),
    };
    let mut config = RuntimeConfig::from_config(raw).expect("test config");
    config
        .adapters
        .insert(TEST_ADAPTER, Arc::new(TestAdapter::new()));
    config
}

pub fn input(instance_id: &str, request_id: &str, prompt: &str, save_result: bool) -> SubmitInput {
    SubmitInput {
        instance_id: instance_id.to_string(),
        request_id: request_id.to_string(),
        adapter: TEST_ADAPTER.to_string(),
        workspace_id: "test".to_string(),
        prompt: Some(prompt.to_string()),
        task_file: None,
        save_result,
        deadline_at: None,
    }
}

/// Accept and run one job to its terminal state.
pub async fn run_one(registry: Arc<Registry>, input: SubmitInput) -> FinalResult {
    let outcome = registry.submit(input).expect("submit accepted");
    let job = outcome.job.clone();
    let adapter = registry.config.adapter(TEST_ADAPTER).expect("test adapter");
    let redactor = registry.config.redactor.clone();
    supervisor::run(registry.clone(), job.clone(), adapter, redactor).await;
    let outcome = registry.wait(&job.id, Some(0)).await.expect("job readable");
    final_result(outcome)
}

pub fn final_result(outcome: xuanling_harness_bridge::jobs::WaitOutcome) -> FinalResult {
    match outcome {
        xuanling_harness_bridge::jobs::WaitOutcome::Final(result) => result,
        xuanling_harness_bridge::jobs::WaitOutcome::Pending { status, .. } => {
            panic!("expected final result, got {status}")
        }
    }
}

pub fn deadline_in(seconds: i64) -> String {
    (OffsetDateTime::now_utc() + time::Duration::seconds(seconds))
        .format(&Rfc3339)
        .expect("rfc3339")
}

pub fn wait_short() -> Duration {
    Duration::from_millis(50)
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio client used by the protocol and host-config tests.
//
// rmcp speaks newline-delimited JSON-RPC on the child's stdin/stdout. A reader
// thread forwards each line so a missing response fails the test instead of
// blocking forever, and the process is killed on drop if a test panics.
// ---------------------------------------------------------------------------

pub struct McpProcess {
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
    lines: std::sync::mpsc::Receiver<String>,
    next_id: u64,
    finished: bool,
}

impl McpProcess {
    /// Spawn the compiled bridge with `--config <path>`.
    pub fn start(config: &Path) -> Self {
        let program = PathBuf::from(env!("CARGO_BIN_EXE_harness-bridge"));
        let config = config.to_str().expect("config path is UTF-8").to_string();
        Self::start_command(&program, &["--config".to_string(), config])
    }

    /// Spawn the compiled bridge with an explicit argv (used to replay a host
    /// `mcpServers` entry exactly as written).
    pub fn start_command(program: &Path, args: &[String]) -> Self {
        Self::start_command_with_env(program, args, &[])
    }

    /// Set synthetic child-only environment values without mutating the test
    /// process environment (other integration tests can run concurrently).
    pub fn start_command_with_env(
        program: &Path,
        args: &[String],
        environment: &[(&str, &str)],
    ) -> Self {
        let mut child = std::process::Command::new(program)
            .args(args)
            .envs(environment.iter().copied())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn harness-bridge");
        let stdin = child.stdin.take().expect("bridge stdin is piped");
        let stdout = child.stdout.take().expect("bridge stdout is piped");
        let (sender, lines) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use std::io::BufRead as _;
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            child,
            stdin: Some(stdin),
            lines,
            next_id: 0,
            finished: false,
        }
    }

    /// Perform the MCP initialize handshake and send `notifications/initialized`.
    pub fn initialize(&mut self) -> serde_json::Value {
        let response = self.request(
            "initialize",
            Some(serde_json::json!({
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "harness-bridge-test", "version": "1"}
            })),
        );
        assert!(
            response.get("result").is_some(),
            "initialize failed: {response}"
        );
        self.notify("notifications/initialized");
        response
    }

    /// Send one request and return the JSON-RPC response with the matching id.
    pub fn request(
        &mut self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> serde_json::Value {
        self.next_id += 1;
        let id = self.next_id;
        let mut message = serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method});
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write(&message);
        loop {
            let line = match self.lines.recv_timeout(Duration::from_secs(15)) {
                Ok(line) => line,
                Err(error) => panic!("no response for {method}: {error}"),
            };
            let value: serde_json::Value = serde_json::from_str(&line)
                .unwrap_or_else(|error| panic!("non-JSON line on stdout: {line:?} ({error})"));
            if value.get("id").and_then(serde_json::Value::as_u64) == Some(id) {
                return value;
            }
        }
    }

    pub fn notify(&mut self, method: &str) {
        self.write(&serde_json::json!({"jsonrpc": "2.0", "method": method}));
    }

    fn write(&mut self, message: &serde_json::Value) {
        use std::io::Write as _;
        let stdin = self.stdin.as_mut().expect("bridge stdin is open");
        writeln!(stdin, "{message}").expect("write JSON-RPC line");
        stdin.flush().expect("flush JSON-RPC line");
    }

    /// Close stdin and wait for a clean exit, killing only if it does not exit.
    pub fn shutdown(&mut self) -> std::process::ExitStatus {
        self.stdin.take();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    self.finished = true;
                    return status;
                }
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => {
                    let _ = self.child.kill();
                    let status = self.child.wait().expect("reap harness-bridge");
                    self.finished = true;
                    return status;
                }
            }
        }
    }
}

impl Drop for McpProcess {
    fn drop(&mut self) {
        self.stdin.take();
        if !self.finished {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// Invoke one MCP tool and return the raw JSON-RPC response.
pub fn call_tool(
    process: &mut McpProcess,
    name: &str,
    arguments: serde_json::Value,
) -> serde_json::Value {
    process.request(
        "tools/call",
        Some(serde_json::json!({"name": name, "arguments": arguments})),
    )
}

/// The tool-level `structuredContent` payload.
pub fn tool_structured(response: &serde_json::Value) -> &serde_json::Value {
    response
        .get("result")
        .and_then(|result| result.get("structuredContent"))
        .unwrap_or_else(|| panic!("tool response has no structuredContent: {response}"))
}

/// The JSON-RPC error code of a protocol-level failure.
pub fn rpc_error_code(response: &serde_json::Value) -> i64 {
    response
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or_else(|| panic!("expected a JSON-RPC error: {response}"))
}
