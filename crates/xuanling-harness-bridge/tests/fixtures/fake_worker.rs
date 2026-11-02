//! Deterministic worker used by integration tests.
//!
//! It is a real child process with real pipes so tests exercise spawn, framing,
//! cancellation, descendant cleanup and report publication through the same
//! supervisor path as a native adapter. It speaks a tiny NDJSON test protocol:
//! `{"type":"final","text":"..."}` is the only terminal event.

use std::io::Write;
use std::time::Duration;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("exec") {
        codex_failure();
    }
    let mut args = std::env::args().skip(1);
    let mut scenario = "success".to_string();
    let mut text = "OK".to_string();
    let mut stderr = String::new();
    let mut sleep_ms: u64 = 0;
    let mut pid_file: Option<String> = None;
    let mut size: usize = 0;

    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--scenario" => scenario = args.next().unwrap_or_default(),
            "--text" => text = args.next().unwrap_or_default(),
            "--stderr" => stderr = args.next().unwrap_or_default(),
            "--sleep-ms" => {
                sleep_ms = args
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0)
            }
            "--pid-file" => pid_file = args.next(),
            "--size" => {
                size = args
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0)
            }
            _ => {}
        }
    }

    if !stderr.is_empty() {
        eprintln!("{stderr}");
    }

    match scenario.as_str() {
        "success" => {
            if sleep_ms > 0 {
                std::thread::sleep(Duration::from_millis(sleep_ms));
            }
            emit_final(&text);
        }
        "noisy-success" => {
            emit(
                "{\"type\":\"tool_call\",\"name\":\"secret-tool\",\"input\":\"PROCESS-ONLY-MARKER\"}",
            );
            emit("{\"type\":\"thinking\",\"text\":\"PROCESS-ONLY-MARKER\"}");
            emit_final(&text);
        }
        "no-terminal" => {
            emit("{\"type\":\"noise\",\"text\":\"process output\"}");
        }
        "failure" => {
            emit("{\"type\":\"noise\",\"text\":\"partial\"}");
            eprintln!("native failure detail");
            std::process::exit(3);
        }
        "huge" => {
            let text = "x".repeat(size);
            emit_final(&text);
        }
        "silent" => {
            std::thread::sleep(Duration::from_millis(sleep_ms.max(1)));
            emit_final(&text);
        }
        "success-at" => {
            let target =
                time::OffsetDateTime::parse(&text, &time::format_description::well_known::Rfc3339)
                    .expect("absolute completion time");
            if let Ok(remaining) =
                std::time::SystemTime::from(target).duration_since(std::time::SystemTime::now())
            {
                std::thread::sleep(remaining);
            }
            emit_final("finished within explicit deadline");
        }
        "spawn-child" => {
            let executable = std::env::current_exe().expect("current executable");
            // The descendant is deliberately left running: integration tests
            // verify that the bridge's containment unit terminates it.
            #[allow(clippy::zombie_processes)]
            let child = std::process::Command::new(executable)
                .args(["--scenario", "silent", "--sleep-ms", "120000"])
                .spawn()
                .expect("spawn descendant");
            if let Some(path) = pid_file {
                let _ = std::fs::write(path, child.id().to_string());
            }
            emit_final(&text);
        }
        // Long-running worker owning a long-running descendant. The pid file
        // lets a test prove that cancelling the job kills the descendant; the
        // bounded sleep keeps a failed kill from hanging the test run.
        "spawn-child-silent" => {
            let executable = std::env::current_exe().expect("current executable");
            #[allow(clippy::zombie_processes)]
            let child = std::process::Command::new(executable)
                .args(["--scenario", "silent", "--sleep-ms", "120000"])
                .spawn()
                .expect("spawn descendant");
            if let Some(path) = pid_file {
                let _ = std::fs::write(path, child.id().to_string());
            }
            std::thread::sleep(Duration::from_millis(60_000));
            emit_final(&text);
        }
        other => {
            eprintln!("unknown scenario: {other}");
            std::process::exit(2);
        }
    }
}

/// Exercise the production Codex adapter through MCP with synthetic messages.
fn codex_failure() -> ! {
    let request: serde_json::Value =
        serde_json::from_reader(std::io::stdin()).expect("synthetic Codex request");
    if matches!(request["scenario"].as_str(), Some("success" | "silent")) {
        if !std::env::args().any(|arg| arg == "--ephemeral") {
            eprintln!("synthetic Codex refuses native session persistence");
            std::process::exit(2);
        }
        if let Some(path) = request["pid_file"].as_str() {
            std::fs::write(path, std::process::id().to_string()).expect("synthetic pid");
        }
        if request["scenario"] == "silent" {
            std::thread::sleep(Duration::from_secs(60));
        }
        emit(
            r#"{"type":"item.completed","item":{"type":"reasoning","text":"PROCESS-ONLY-MARKER"}}"#,
        );
        let text = request["text"].as_str().unwrap_or("OK");
        emit(&serde_json::json!({"type":"item.completed","item":{"type":"agent_message","text":text}}).to_string());
        emit(r#"{"type":"turn.completed"}"#);
        std::process::exit(0);
    }
    if let Some(stderr) = request.get("stderr").and_then(serde_json::Value::as_str) {
        eprint!("{stderr}");
        std::io::stderr().flush().expect("flush synthetic stderr");
    }
    if let Some(message) = request.get("message").and_then(serde_json::Value::as_str) {
        emit(&serde_json::json!({"type":"turn.failed", "error":{"message":message}}).to_string());
    }
    std::process::exit(1);
}

fn emit(line: &str) {
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

fn emit_final(text: &str) {
    let line = serde_json::json!({"type": "final", "text": text});
    emit(&line.to_string());
}
