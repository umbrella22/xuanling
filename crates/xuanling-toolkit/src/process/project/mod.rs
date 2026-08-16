//! Project/toolchain tools (plan §7.4).
//!
//! `project_detect` reads ecosystem markers (no build script execution).
//! `project_command` resolves `project_path + action` into a deterministic
//! `program + args + cwd` WITHOUT executing. `project_run` calls the resolver
//! then enters `process_run`. Ambiguous selections return `conflict`.

pub mod detect;
pub mod resolve;

pub use detect::{ProjectDetectRequest, ProjectDetectResult, ProjectEcosystem, project_detect};
pub use resolve::{
    ProjectAction, ProjectCommandRequest, ProjectCommandResult, ProjectRunRequest,
    ProjectRunResult, project_command, project_run,
};
