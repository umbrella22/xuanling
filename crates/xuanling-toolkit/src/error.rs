//! Stable error contract for toolkit operations (plan §5).
//!
//! Free-text error messages cannot drive agent retry reliably. Each domain
//! failure carries a stable [`ToolErrorCode`] plus structured context fields
//! (`operation`, `path`, `program`, `raw_os_error`, `details`) so MCP clients
//! can branch on `code` rather than scraping message text.
//!
//! Mapping rule reminder:
//! - serde/schema decode failure      -> `invalid_input` (MCP invalid params).
//! - `process_run` nonzero exit code  -> a *successful* [`crate::process`]
//!   result with `success=false`, NOT a [`ToolError`]. Only spawn/wait/capture
//!   failures and cancellation become [`ToolError`].

use serde::{Deserialize, Serialize};

/// Stable, machine-readable domain failure code.
///
/// Serialized as `snake_case`; see [`ToolErrorCode::as_snake_case`] and the
/// `tool_error_code_round_trips_as_snake_case` contract test. Codes are
/// additive — never reuse or rename an existing variant, only append new ones.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolErrorCode {
    /// Required field missing, enum/range/schema violation, unknown field.
    InvalidInput,
    /// File/process/namespace target does not exist.
    NotFound,
    /// OS denied the operation (permission/ACL).
    PermissionDenied,
    /// A configured server capability excludes the requested target.
    OutsideCapability,
    /// `create` mode write hit an existing file; dedupe key already present in
    /// a mode that forbids overwrite.
    AlreadyExists,
    /// Expected a directory, found a file (or vice versa handled separately).
    NotDirectory,
    /// Expected a file, found a directory.
    IsDirectory,
    /// A `*_text`/`read_text` tool received non-UTF-8 bytes.
    InvalidUtf8,
    /// The request is well-formed but the runtime/platform cannot satisfy it
    /// (e.g. stdio MCP `stdout=inherit`, missing platform capability).
    Unsupported,
    /// Optimistic concurrency or expected-hash mismatch.
    Conflict,
    /// Observed cancellation before completion.
    Cancelled,
    /// Could not spawn the child process.
    SpawnFailed,
    /// SQLite busy/locked.
    ///
    /// Note: `process_run` nonzero exit is NOT an error code — it is a
    /// successful `ProcessResult` with `success=false`. Only spawn/wait/capture
    /// failures and cancellation become [`ToolError`].
    DatabaseBusy,
    /// Unclassified I/O failure.
    IoError,
    /// Unexpected internal failure (bug); clients should not retry blindly.
    Internal,
}

impl ToolErrorCode {
    /// Render the canonical `snake_case` wire form (matches `#[serde(rename_all)]`).
    pub fn as_snake_case(&self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::NotFound => "not_found",
            Self::PermissionDenied => "permission_denied",
            Self::OutsideCapability => "outside_capability",
            Self::AlreadyExists => "already_exists",
            Self::NotDirectory => "not_directory",
            Self::IsDirectory => "is_directory",
            Self::InvalidUtf8 => "invalid_utf8",
            Self::Unsupported => "unsupported",
            Self::Conflict => "conflict",
            Self::Cancelled => "cancelled",
            Self::SpawnFailed => "spawn_failed",
            Self::DatabaseBusy => "database_busy",
            Self::IoError => "io_error",
            Self::Internal => "internal",
        }
    }
}

/// Structured domain failure.
///
/// `message` and `details` may contain OS/ third-party text and MUST NOT be
/// treated as stable identifiers; branch on [`ToolErrorCode`] / `raw_os_error`
/// instead. Persisting a `ToolError` (audit, evidence) must respect the
/// secret/redaction boundary — third-party bodies and model output should be
/// redacted before storage.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ToolError {
    pub code: ToolErrorCode,
    pub message: String,
    /// Logical operation name, e.g. `fs.read_text`, `process.run`. Stable.
    pub operation: String,
    /// Path the operation targeted, when applicable (display form).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Program name for `process_*` failures, when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    /// Raw OS errno (`io::Error::raw_os_error`), when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_os_error: Option<i32>,
    /// Optional structured extension (expected hash, candidates, …).
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub details: serde_json::Value,
}

impl ToolError {
    /// Convenience constructor for the common `code + operation + message` case.
    pub fn new(
        code: ToolErrorCode,
        operation: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            operation: operation.into(),
            path: None,
            program: None,
            raw_os_error: None,
            details: serde_json::Value::Null,
        }
    }

    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn with_program(mut self, program: impl Into<String>) -> Self {
        self.program = Some(program.into());
        self
    }

    pub fn with_raw_os_error(mut self, err: Option<i32>) -> Self {
        self.raw_os_error = err;
        self
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = details;
        self
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: {} ({})",
            self.code.as_snake_case(),
            self.message,
            self.operation
        )?;
        if let Some(path) = &self.path {
            write!(f, " path={path}")?;
        }
        if let Some(program) = &self.program {
            write!(f, " program={program}")?;
        }
        if let Some(err) = self.raw_os_error {
            write!(f, " os_err={err}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ToolError {}
