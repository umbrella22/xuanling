//! Bounded protocol collection.
//!
//! Adapters receive worker bytes incrementally. Process events are consumed for
//! protocol state only; the bridge keeps a bounded final answer and a bounded
//! failure diagnostic, never the raw stdout/stderr stream.

use crate::error::ErrorCode;
use crate::redact::Redactor;

/// Byte budgets applied while a worker runs.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_final_bytes: usize,
    pub max_diagnostic_bytes: usize,
    pub max_protocol_line_bytes: usize,
    pub max_protocol_bytes: usize,
}

/// The native terminal classification before bridge settlement.
#[derive(Clone, Debug)]
pub enum RunOutcome {
    Completed,
    Failed { code: ErrorCode, message: String },
    NeedsInput { message: String },
}

/// Everything an adapter extracts from one run.
#[derive(Clone, Debug)]
pub struct Collected {
    pub outcome: RunOutcome,
    pub final_text: Option<String>,
    pub output_complete: bool,
    pub diagnostic: Option<String>,
    pub protocol_incomplete: bool,
    pub redacted: bool,
}

impl Collected {
    pub fn failed(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            outcome: RunOutcome::Failed {
                code,
                message: message.into(),
            },
            final_text: None,
            output_complete: false,
            diagnostic: None,
            protocol_incomplete: false,
            redacted: false,
        }
    }

    pub fn stream_incomplete(message: impl Into<String>) -> Self {
        Self::failed(ErrorCode::StreamIncomplete, message)
    }

    pub fn with_diagnostic(mut self, diagnostic: Option<String>) -> Self {
        self.diagnostic = diagnostic;
        self
    }

    pub fn with_redaction(mut self, redacted: bool) -> Self {
        self.redacted |= redacted;
        self
    }
}

/// Incremental adapter parser.
pub trait Collector: Send {
    fn on_stdout(&mut self, chunk: &[u8]);
    fn on_stderr(&mut self, chunk: &[u8]);
    fn finish(self: Box<Self>, exit_code: Option<i32>) -> Collected {
        self.finish_redacted(exit_code, &Redactor::from_env_names(&[]))
    }
    fn finish_redacted(self: Box<Self>, exit_code: Option<i32>, redactor: &Redactor) -> Collected;
}

/// Newline-delimited JSON framing with a per-line cap.
///
/// A line that exceeds the cap is discarded and marks the protocol incomplete;
/// subsequent lines are still parsed, so a huge tool event cannot stop the
/// bridge from recognizing the native terminal event.
pub struct LineFramer {
    buffer: Vec<u8>,
    limit: usize,
    discarding: bool,
    pub overflow: bool,
}

impl LineFramer {
    pub fn new(limit: usize) -> Self {
        Self {
            buffer: Vec::new(),
            limit,
            discarding: false,
            overflow: false,
        }
    }

    pub fn push<F: FnMut(&[u8])>(&mut self, chunk: &[u8], mut on_line: F) {
        for &byte in chunk {
            if byte == b'\n' {
                self.complete_line(&mut on_line);
            } else {
                self.push_byte(byte);
            }
        }
    }

    /// Parse a trailing line that was not newline-terminated.
    pub fn finish<F: FnMut(&[u8])>(&mut self, mut on_line: F) {
        if !self.discarding && !self.buffer.is_empty() {
            on_line(trim_cr(&self.buffer));
        }
        if self.discarding {
            self.overflow = true;
        }
        self.buffer.clear();
        self.discarding = false;
    }

    fn complete_line(&mut self, on_line: &mut impl FnMut(&[u8])) {
        if self.discarding {
            self.discarding = false;
        } else if !self.buffer.is_empty() {
            on_line(trim_cr(&self.buffer));
        }
        self.buffer.clear();
    }

    fn push_byte(&mut self, byte: u8) {
        if self.discarding {
            return;
        }
        if self.buffer.len() >= self.limit {
            self.overflow = true;
            self.discarding = true;
            self.buffer.clear();
            return;
        }
        self.buffer.push(byte);
    }
}

fn trim_cr(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// Whole-stream buffer with a byte cap.
pub struct ByteBudget {
    buffer: Vec<u8>,
    limit: usize,
    pub truncated: bool,
}

impl ByteBudget {
    pub fn new(limit: usize) -> Self {
        Self {
            buffer: Vec::new(),
            limit,
            truncated: false,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if self.buffer.len() >= self.limit {
            self.truncated = true;
            return;
        }
        let room = self.limit - self.buffer.len();
        let take = room.min(chunk.len());
        self.buffer.extend_from_slice(&chunk[..take]);
        if take < chunk.len() {
            self.truncated = true;
        }
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.buffer).into_owned()
    }
}

/// Rolling tail of a stream, used only for bounded failure diagnostics.
pub struct TailBuffer {
    buffer: Vec<u8>,
    limit: usize,
    clipped_start: bool,
}

impl TailBuffer {
    pub fn new(limit: usize) -> Self {
        Self {
            buffer: Vec::new(),
            limit,
            clipped_start: false,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if chunk.len() >= self.limit {
            self.clipped_start |= !self.buffer.is_empty() || chunk.len() > self.limit;
            self.buffer.clear();
            self.buffer
                .extend_from_slice(&chunk[chunk.len() - self.limit..]);
            return;
        }
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() > self.limit {
            self.clipped_start = true;
            let excess = self.buffer.len() - self.limit;
            self.buffer.drain(..excess);
        }
    }

    pub fn redacted_text(&self, redactor: &Redactor) -> (Option<String>, bool) {
        let (text, redacted) = redactor.redact_tail(&self.buffer, self.clipped_start);
        let text = text.trim().to_string();
        ((!text.is_empty()).then_some(text), redacted)
    }

    /// Preserve only the typed failure hint before a clipped diagnostic loses
    /// ambiguous text during redaction. Raw bytes remain inside this buffer.
    pub fn failure_hint(&self) -> ErrorCode {
        classify_failure(&String::from_utf8_lossy(&self.buffer))
    }
}

/// Truncate at a UTF-8 boundary. Returns the text and whether it was cut.
pub fn truncate_text(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.to_string(), false);
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// Append a captured stderr tail to a native failure message.
pub fn append_diagnostic(message: &mut String, diagnostic: Option<&str>, separator: &str) {
    if let Some(diagnostic) = diagnostic {
        message.push_str(separator);
        message.push_str(diagnostic);
    }
}

/// Bound a failure diagnostic to the configured byte budget.
pub fn bound_diagnostic(text: &str, limits: &Limits, redactor: &Redactor) -> (String, bool) {
    let (text, redacted) = redactor.redact(text);
    (
        truncate_text(&text, limits.max_diagnostic_bytes).0,
        redacted,
    )
}

/// Apply the same classification precedence as the native text plus stderr,
/// without reintroducing a raw stderr fragment into the diagnostic message.
pub fn classify_failure_with_hint(message: &str, stderr_hint: ErrorCode) -> ErrorCode {
    let primary = classify_failure(message);
    match (primary, stderr_hint) {
        (ErrorCode::AdapterUnavailable, _) | (_, ErrorCode::AdapterUnavailable) => {
            ErrorCode::AdapterUnavailable
        }
        (ErrorCode::AuthRequired, _) | (_, ErrorCode::AuthRequired) => ErrorCode::AuthRequired,
        (ErrorCode::RateLimit, _) | (_, ErrorCode::RateLimit) => ErrorCode::RateLimit,
        (ErrorCode::NeedsInput, _) | (_, ErrorCode::NeedsInput) => ErrorCode::NeedsInput,
        _ => primary,
    }
}

/// Map native failure text to the bridge's stable failure taxonomy.
pub fn classify_failure(message: &str) -> ErrorCode {
    let lower = message.to_ascii_lowercase();
    const AUTH: &[&str] = &[
        "authentication",
        "authenticate",
        "unauthorized",
        "auth error",
        "auth failed",
        "missing_credential",
        "no api key",
        "api key",
        "credentials service",
        "insufficient account balance",
    ];
    const RATE: &[&str] = &["rate limit", "ratelimit", "too many requests", "429"];
    const INPUT: &[&str] = &[
        "needs_input",
        "needs input",
        "requires approval",
        "approval required",
        "permission required",
    ];
    if lower.contains("built-in provider config") {
        // The ZCode CLI cannot locate its provider metadata; this is a launch
        // environment defect, not an authentication or task failure.
        ErrorCode::AdapterUnavailable
    } else if AUTH.iter().any(|needle| lower.contains(needle)) {
        ErrorCode::AuthRequired
    } else if RATE.iter().any(|needle| lower.contains(needle)) {
        ErrorCode::RateLimit
    } else if INPUT.iter().any(|needle| lower.contains(needle)) {
        ErrorCode::NeedsInput
    } else {
        ErrorCode::WorkerFailed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_line_is_dropped_but_framing_continues() {
        let mut framer = LineFramer::new(4);
        let mut lines = Vec::new();
        framer.push(b"abcdefghij\nok\n", |line| {
            lines.push(String::from_utf8_lossy(line).into_owned())
        });
        assert!(framer.overflow);
        assert_eq!(lines, vec!["ok".to_string()]);
    }

    #[test]
    fn truncate_text_respects_utf8_boundaries() {
        let (text, cut) = truncate_text("aé", 2);
        assert_eq!(text, "a");
        assert!(cut);
    }

    #[test]
    fn classifies_captured_native_failures_without_header_false_positives() {
        assert_eq!(
            classify_failure("Failed to authenticate. API Error: 403 Insufficient account balance"),
            ErrorCode::AuthRequired
        );
        assert_eq!(
            classify_failure("MISSING_CREDENTIAL: llm-deepseek: no API key for provider route"),
            ErrorCode::AuthRequired
        );
        assert_eq!(
            classify_failure("ProviderBusinessError: Insufficient account balance"),
            ErrorCode::AuthRequired
        );
        assert_eq!(
            classify_failure(
                "The 'x' model is not supported when using Codex with a ChatGPT account."
            ),
            ErrorCode::WorkerFailed
        );
        // The ZCode provider-error dump retains HTTP response headers.
        assert_eq!(
            classify_failure(
                "access-control-allow-credentials: true\nstatus 429 too many requests"
            ),
            ErrorCode::RateLimit
        );
    }
}
