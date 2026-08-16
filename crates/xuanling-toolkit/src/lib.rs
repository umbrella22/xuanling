//! XuanLing toolkit — protocol-neutral typed tools for the cross-platform MCP server.
//!
//! This crate is a strict dependency island (see
//! `docs/plan/cross-platform-toolkit-memory-mcp-development-plan.md` §3): it
//! MUST NOT depend on the legacy XuanLing control-plane crates
//! (`xuanling-core`, `xuanling-policy`, `xuanling-store`, `xuanling-executor`,
//! `xuanling-gateway`, `xuanling-runtime`, `xuanling-orchestrator`,
//! `xuanling-source-*`). The toolkit exposes stable typed requests/results and
//! cross-platform filesystem/process/project operations without imposing a
//! workspace root, sandbox, policy, default timeout or hidden output cap.
//! Memory lives in the sibling `xuanling-memory` crate (memory v2 plan W2).

// `ToolError` is the canonical, structured failure type returned across the
// crate. It carries multiple `String` fields plus a `serde_json::Value`, so it
// is larger than clippy's `result_large_err` threshold. Boxing it on every
// call site would add allocation overhead for no real benefit; the error path
// is not hot, and the structured fields are the point. Allow crate-wide.
#![allow(clippy::result_large_err)]

pub mod capability;
pub mod error;
pub mod fs;
pub mod invocation;
pub mod path;
pub mod process;
pub mod system;

pub use capability::{FilesystemScope, PathAccess, WorkspaceScope};
pub use error::{ToolError, ToolErrorCode};
pub use invocation::{Cancellation, InvocationContext, NoCancellation};
pub use path::PathContext;
