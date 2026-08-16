//! MCP protocol contract test suite (plan §9, §10 W0).
//!
//! Drives the `xuanling-mcp` binary over stdio as a subprocess to assert the
//! stdio discipline (stdout carries only MCP framing) and the
//! initialize/tools-list handshake.

#[path = "protocol/agent_acceptance.rs"]
mod agent_acceptance;
#[path = "protocol/cli_maintenance.rs"]
mod cli_maintenance;
#[path = "protocol/compat_lenient.rs"]
mod compat_lenient;
#[path = "protocol/contract_hardening.rs"]
mod contract_hardening;
#[path = "protocol/framing.rs"]
mod framing;
#[path = "protocol/handshake.rs"]
mod handshake;
#[path = "protocol/schema_snapshot.rs"]
mod schema_snapshot;
#[path = "protocol/tool_call.rs"]
mod tool_call;
