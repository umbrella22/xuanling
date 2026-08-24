//! Process and project/toolchain typed tools (plan §7.3, §7.4).
//!
//! `process_run` uses `tokio::process::Command` with argv only — no shell, no
//! server-side timeout. MCP cancellation terminates the complete descendant
//! process tree, and one-shot calls clean up residual descendants before return.
//! `process_which` resolves a bare program name against PATH/PATHEXT with
//! Windows env-key case folding. Project tools detect ecosystem markers and
//! produce deterministic program+args (no shell string).

pub mod artifact;
pub mod project;
pub mod run;
pub mod session;
mod tree;
pub mod which;

pub use artifact::{
    ArtifactCleanupRequest, ArtifactCleanupResult, ArtifactReadRequest, ArtifactReadResult,
    ArtifactRef, ArtifactWriter, cleanup as artifact_cleanup, read as artifact_read,
};
pub use project::{
    ProjectAction, ProjectCommandRequest, ProjectCommandResult, ProjectDetectRequest,
    ProjectDetectResult, ProjectEcosystem, ProjectRunRequest, ProjectRunResult, project_command,
    project_detect, project_run,
};
pub use run::{
    PipelineStage, PipelineStageResult, ProcessPipelineRequest, ProcessPipelineResult,
    ProcessRunRequest, ProcessRunResult, parse_pipeline_shlex, process_pipeline, process_run,
};
pub use session::{
    SessionCloseRequest, SessionCloseResult, SessionExecRequest, SessionExecResult,
    SessionOpenRequest, SessionOpenResult, session_close, session_exec, session_open,
};
pub use which::{ProcessWhichRequest, ProcessWhichResult, WhichCandidate, process_which};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// How a child stream (stdout/stderr) is captured (plan §7.3).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Default, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum ProcessStreamMode {
    /// Capture fully and return inline. Default for stdio MCP so server
    /// stdout (the MCP framing channel) is never polluted by child output.
    #[default]
    Inline,
    /// Write to a caller-specified file path (no auto temp file).
    File { path: String },
    /// Inherit the server's stream. Forbidden for stdout in stdio MCP mode.
    Inherit,
    /// Discard the stream.
    Null,
}
