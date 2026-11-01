//! `xuanling-harness-bridge`: a result-only MCP bridge that runs one native
//! worker harness and returns its final answer.
//!
//! The bridge keeps no database, no event file and no periodic progress write.
//! Deduplication, the active-job limit and the final-result cache are scoped to
//! one process instance. See `docs/plans/harness-bridge-development-plan.md`.

pub mod adapters;
pub mod cleanup;
pub mod collector;
pub mod config;
pub mod error;
pub mod jobs;
pub mod mcp;
pub mod redact;
pub mod report;
pub mod supervisor;
pub mod task;
