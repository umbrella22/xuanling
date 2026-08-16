//! XuanLing MCP stdio server (plan §9).
//!
//! Local-first Model Context Protocol server that exposes the cross-platform
//! typed tools implemented in [`xuanling_toolkit`]. The server is a thin
//! adapter: it maps MCP `tools/call` onto toolkit operations and renders the
//! typed results as structured MCP content. It owns no task/evidence/policy
//! semantics and pulls in none of the legacy control-plane crates (plan §3,
//! dependency guard in `tests/protocol/dependency.rs`).
//!
//! W0 ships only the identity/handshake and an empty tool catalog so the
//! initialize/tools-list harness can be wired up; the system/path/fs/process/
//! project/memory tools are added by W1-W6.

pub mod compat;
pub mod handlers;
pub mod profile;
pub mod server;

pub use profile::{ToolProfile, ToolProfileSelection};
pub use server::XuanlingServer;
