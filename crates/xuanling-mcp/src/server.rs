//! MCP server handler (plan §9.3).
//!
//! Implements [`rmcp::ServerHandler`] so the local stdio server answers
//! `initialize`, `tools/list` and `tools/call`. The toolkit operations are
//! dispatched via [`crate::handlers`]; each wave registers more tools.
//!
//! stdio discipline (plan §9.2): this server writes ONLY MCP framing to
//! stdout. All tracing/diagnostics go to stderr and never include memory
//! content, file content, stdin/stdout captures or the full environment.

use std::borrow::Cow;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, Implementation, ListToolsResult,
    PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerInfo,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use xuanling_memory::MemoryStore;
use xuanling_toolkit::FilesystemScope;
use xuanling_toolkit::path::PathContext;

use crate::handlers;
use crate::profile::ToolProfileSelection;

/// The XuanLing MCP server state. Holds an optional memory store (opened in
/// main from the CLI-supplied `--memory-db`), plus the CLI-supplied path
/// resolution context (`--base-dir`) and default memory namespace
/// (`--default-namespace`) that are threaded into every tool invocation.
/// Tools that don't need memory work with or without it; memory tools return
/// `unsupported` if absent.
#[derive(Clone, Default)]
pub struct XuanlingServer {
    memory: Option<MemoryStore>,
    path_context: PathContext,
    filesystem_scope: FilesystemScope,
    default_namespace: Option<String>,
    tool_profiles: ToolProfileSelection,
    /// ZCode compat shim (C-16): coerce stringified object parameters.
    /// Default OFF — the strict schema contract is the default surface.
    compat_lenient_object_params: bool,
}

impl XuanlingServer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_memory(memory: MemoryStore) -> Self {
        Self {
            memory: Some(memory),
            ..Self::default()
        }
    }

    /// Build the server with memory plus CLI-supplied path resolution context
    /// and default namespace (plan §9.1 flags).
    pub fn with_config(
        memory: Option<MemoryStore>,
        path_context: PathContext,
        default_namespace: Option<String>,
    ) -> Self {
        Self {
            memory,
            path_context,
            filesystem_scope: FilesystemScope::Unrestricted,
            default_namespace,
            tool_profiles: ToolProfileSelection::default(),
            ..Self::default()
        }
    }

    pub fn with_capabilities(
        memory: Option<MemoryStore>,
        path_context: PathContext,
        filesystem_scope: FilesystemScope,
        default_namespace: Option<String>,
    ) -> Self {
        Self::with_capabilities_and_profiles(
            memory,
            path_context,
            filesystem_scope,
            default_namespace,
            ToolProfileSelection::default(),
        )
    }

    pub fn with_capabilities_and_profiles(
        memory: Option<MemoryStore>,
        path_context: PathContext,
        filesystem_scope: FilesystemScope,
        default_namespace: Option<String>,
        tool_profiles: ToolProfileSelection,
    ) -> Self {
        Self {
            memory,
            path_context,
            filesystem_scope,
            default_namespace,
            tool_profiles,
            ..Self::default()
        }
    }

    /// Enable the ZCode compatibility shim (C-16): top-level parameters whose
    /// schema resolves to an object accept a JSON-encoded string. Default is
    /// strict; only a deployment facing the known-buggy host turns this on.
    pub fn with_compat_lenient_object_params(mut self, enabled: bool) -> Self {
        self.compat_lenient_object_params = enabled;
        self
    }

    pub fn memory(&self) -> Option<&MemoryStore> {
        self.memory.as_ref()
    }
}

impl ServerHandler for XuanlingServer {
    fn get_info(&self) -> ServerInfo {
        // `ServerInfo` (= `InitializeResult`) is `#[non_exhaustive]`; use the
        // crate-provided constructor + builder instead of a struct literal.
        let mut info = ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("xuanling-mcp", env!("CARGO_PKG_VERSION")))
            // Pin the fallback protocol revision to rmcp's latest *legacy*
            // revision. `supported_protocol_versions` (below) excludes the
            // 2026-07-28 modern era, so negotiation can never agree to it; keep
            // this explicit in case rmcp later bumps `LATEST` into a revision
            // this server does not implement.
            .with_protocol_version(ProtocolVersion::V_2025_11_25);
        // Publish the ADR 0027 contract version in `_meta` so hosts can detect
        // the output/artifact/cursor contract the server implements (§10).
        let mut meta = serde_json::Map::new();
        meta.insert(
            "xuanling.contract_version".to_string(),
            serde_json::json!("2"),
        );
        // Memory v2 (plan §5/C-08): candidate/review tools, breaking change
        // from the v1 direct-mutation surface. Kept alongside the generic
        // contract_version so non-memory hosts need not care.
        meta.insert(
            "xuanling.memory_contract_version".to_string(),
            serde_json::json!("2"),
        );
        meta.insert(
            "xuanling.tool_count".to_string(),
            serde_json::json!(
                crate::handlers::catalog()
                    .into_iter()
                    .filter(|tool| self.tool_profiles.allows_tool(tool.name.as_ref()))
                    .count() as u64
            ),
        );
        meta.insert(
            "xuanling.tool_profiles".to_string(),
            serde_json::json!(self.tool_profiles.names()),
        );
        meta.insert(
            "xuanling.filesystem_scope".to_string(),
            serde_json::json!(if self.filesystem_scope.is_contained() {
                "workspace"
            } else {
                "unrestricted"
            }),
        );
        meta.insert(
            "xuanling.workspace_root_count".to_string(),
            serde_json::json!(self.filesystem_scope.write_root_count()),
        );
        meta.insert(
            "xuanling.read_root_count".to_string(),
            serde_json::json!(self.filesystem_scope.read_root_count()),
        );
        // Compat transparency (C-16): hosts can detect the lenient shim.
        meta.insert(
            "xuanling.compat.lenient_object_params".to_string(),
            serde_json::json!(self.compat_lenient_object_params),
        );
        info.meta = Some(rmcp::model::MetaObject(meta));
        info
    }

    /// Only legacy protocol revisions. rmcp's default advertises every known
    /// version, which makes modern-era clients (e.g. ZCode) negotiate
    /// `2026-07-28` and then validate `tools/list` against the strict modern
    /// wire schema — `resultType` plus the `ttlMs`/`cacheScope` result fields
    /// this server does not emit — failing the whole connection and leaving
    /// zero tools registered. Regression test: `tests/protocol/handshake.rs`.
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Owned(vec![
            ProtocolVersion::V_2024_11_05,
            ProtocolVersion::V_2025_03_26,
            ProtocolVersion::V_2025_06_18,
            ProtocolVersion::V_2025_11_25,
        ])
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListToolsResult, McpError>> + Send {
        let tools = handlers::catalog()
            .into_iter()
            .filter(|tool| self.tool_profiles.allows_tool(tool.name.as_ref()))
            .collect();
        std::future::ready(Ok(ListToolsResult {
            tools,
            ..Default::default()
        }))
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<CallToolResponse, McpError>> + Send {
        let name = request.name.into_owned();
        let arguments = request
            .arguments
            .map(serde_json::Value::Object)
            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
        let memory = self.memory.clone();
        let path_context = self.path_context.clone();
        let filesystem_scope = self.filesystem_scope.clone();
        let default_namespace = self.default_namespace.clone();
        let tool_profiles = self.tool_profiles.clone();
        let compat_lenient_object_params = self.compat_lenient_object_params;
        Box::pin(async move {
            if !tool_profiles.allows_tool(&name) {
                return Err(McpError::invalid_params(
                    format!("unknown tool: {name}"),
                    None,
                ));
            }
            let arguments = if compat_lenient_object_params {
                let mut map = match arguments {
                    serde_json::Value::Object(map) => map,
                    _ => serde_json::Map::new(),
                };
                crate::compat::coerce_stringified_objects(&name, &mut map);
                serde_json::Value::Object(map)
            } else {
                arguments
            };
            let result = handlers::dispatch(
                &name,
                &arguments,
                &context,
                memory.as_ref(),
                &path_context,
                &filesystem_scope,
                default_namespace.as_deref(),
            )
            .await;
            result.map(CallToolResponse::from)
        })
    }
}
