//! Typed bridge failures.
//!
//! Domain failures are returned to the controller as structured tool errors; a
//! protocol failure (unknown tool, malformed arguments) is an MCP `-32602`.

use serde::Serialize;

/// Stable machine-readable failure codes (plan §10).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidRequest,
    UnknownTool,
    InstanceChanged,
    RequestConflict,
    Busy,
    MemoryCapacity,
    PathOutsideRoot,
    TaskReadFailed,
    AdapterUnavailable,
    IncompatibleCli,
    AuthRequired,
    RateLimit,
    WorkerFailed,
    NeedsInput,
    StreamIncomplete,
    SpawnFailed,
    CleanupUnconfirmed,
    JobNotFound,
    JobContextLost,
    ResultTooLarge,
    ReportWriteFailed,
    SensitivePayload,
    ConfigInvalid,
    DeadlineExceeded,
    Interrupted,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "INVALID_REQUEST",
            Self::UnknownTool => "UNKNOWN_TOOL",
            Self::InstanceChanged => "INSTANCE_CHANGED",
            Self::RequestConflict => "REQUEST_CONFLICT",
            Self::Busy => "BUSY",
            Self::MemoryCapacity => "MEMORY_CAPACITY",
            Self::PathOutsideRoot => "PATH_OUTSIDE_ROOT",
            Self::TaskReadFailed => "TASK_READ_FAILED",
            Self::AdapterUnavailable => "ADAPTER_UNAVAILABLE",
            Self::IncompatibleCli => "INCOMPATIBLE_CLI",
            Self::AuthRequired => "AUTH_REQUIRED",
            Self::RateLimit => "RATE_LIMIT",
            Self::WorkerFailed => "WORKER_FAILED",
            Self::NeedsInput => "NEEDS_INPUT",
            Self::StreamIncomplete => "STREAM_INCOMPLETE",
            Self::SpawnFailed => "SPAWN_FAILED",
            Self::CleanupUnconfirmed => "CLEANUP_UNCONFIRMED",
            Self::JobNotFound => "JOB_NOT_FOUND",
            Self::JobContextLost => "JOB_CONTEXT_LOST",
            Self::ResultTooLarge => "RESULT_TOO_LARGE",
            Self::ReportWriteFailed => "REPORT_WRITE_FAILED",
            Self::SensitivePayload => "SENSITIVE_PAYLOAD",
            Self::ConfigInvalid => "CONFIG_INVALID",
            Self::DeadlineExceeded => "DEADLINE_EXCEEDED",
            Self::Interrupted => "INTERRUPTED",
        }
    }
}

/// A typed failure with a safe, caller-visible message.
#[derive(Clone, Debug, Serialize)]
pub struct BridgeError {
    pub code: ErrorCode,
    pub message: String,
}

impl BridgeError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidRequest, message)
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ConfigInvalid, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::WorkerFailed, message)
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for BridgeError {}
