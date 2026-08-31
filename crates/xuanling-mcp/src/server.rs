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
use std::path::PathBuf;
use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, Implementation, ListToolsResult,
    PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerInfo,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;
use xuanling_memory::{MemoryStore, ToolError, ToolErrorCode};
use xuanling_toolkit::FilesystemScope;
use xuanling_toolkit::path::PathContext;

use crate::handlers;
use crate::profile::ToolProfileSelection;

/// Short routing guidance delivered during MCP initialization. The complete
/// workflow remains in the distributed Skills; this summary covers the
/// decisions a host should surface before a Skill is loaded.
const SERVER_INSTRUCTIONS: &str = "Routine reads and small edits prefer host-native tools. Use XuanLing for cross-OS structured results, bounded output and pagination, hashes/CAS, and atomic strict patches. Project-local must-see memory belongs only in host L1; cross-project memory searches L2 first and creates a pending candidate only when absent. Review a memory proposal only after explicit user approval.";

/// A small fixed page keeps one `tools/list` response bounded while standard
/// MCP clients remain free to drain the opaque cursor chain.
const TOOL_CATALOG_PAGE_SIZE: usize = 8;

/// Cursor prefix bytes taken from the catalog digest. Ninety-six bits keeps
/// the token compact without treating it as an authorization boundary.
const TOOL_CURSOR_DIGEST_BYTES: usize = 12;

/// Memory tools are the only operations allowed to cross the lazy-open
/// boundary. Keeping this list explicit prevents an unknown or unrelated tool
/// from opening the user's database as a side effect of dispatch.
/// A process-local, shared lazy memory capability. The `OnceCell` caches both
/// a successful store and a typed open failure, so concurrent first calls do
/// not race migrations or repeatedly retry a known-bad database.
pub(crate) struct LazyMemory {
    path: Option<PathBuf>,
    busy_timeout_ms: u32,
    cell: OnceCell<Result<MemoryStore, ToolError>>,
}

#[derive(Clone)]
pub(crate) enum MemoryHandle {
    None,
    Ready(MemoryStore),
    Lazy(Arc<LazyMemory>),
}

impl MemoryHandle {
    fn none() -> Self {
        Self::None
    }

    fn ready(memory: Option<MemoryStore>) -> Self {
        memory.map_or(Self::None, Self::Ready)
    }

    fn lazy(path: Option<PathBuf>, busy_timeout_ms: u32) -> Self {
        Self::Lazy(Arc::new(LazyMemory {
            path,
            busy_timeout_ms,
            cell: OnceCell::const_new(),
        }))
    }

    pub(crate) fn eager(&self) -> Option<&MemoryStore> {
        match self {
            Self::Ready(memory) => Some(memory),
            Self::None | Self::Lazy(_) => None,
        }
    }

    #[allow(clippy::result_large_err)]
    pub(crate) async fn resolve(&self) -> Result<Option<MemoryStore>, ToolError> {
        match self {
            Self::None => Ok(None),
            Self::Ready(memory) => Ok(Some(memory.clone())),
            Self::Lazy(lazy) => {
                let path = lazy.path.clone().or_else(xuanling_memory::default_db_path);
                let busy_timeout_ms = lazy.busy_timeout_ms;
                let result = lazy
                    .cell
                    .get_or_init(|| async move {
                        let Some(path) = path else {
                            return Err(ToolError::new(
                                ToolErrorCode::Unsupported,
                                "memory.open",
                                "cannot resolve the default memory DB path (HOME/USERPROFILE); pass an explicit --memory-db",
                            ));
                        };
                        MemoryStore::open(&path, busy_timeout_ms).await
                    })
                    .await;
                result.clone().map(Some)
            }
        }
    }
}

struct CatalogState {
    tools: Arc<[rmcp::model::Tool]>,
    digest_hex: String,
    cursor_digest_hex: String,
}

impl CatalogState {
    fn for_profiles(tool_profiles: &ToolProfileSelection) -> Arc<Self> {
        let tools: Arc<[_]> = handlers::shared_catalog()
            .iter()
            .filter(|tool| tool_profiles.allows_tool(tool.name.as_ref()))
            .cloned()
            .collect();
        let digest = catalog_digest(&tools);
        Arc::new(Self {
            tools,
            digest_hex: hex(&digest),
            cursor_digest_hex: hex(&digest[..TOOL_CURSOR_DIGEST_BYTES]),
        })
    }
}

#[cfg(test)]
fn uncached_filtered_catalog(tool_profiles: &ToolProfileSelection) -> Vec<rmcp::model::Tool> {
    handlers::shared_catalog()
        .iter()
        .filter(|tool| tool_profiles.allows_tool(tool.name.as_ref()))
        .cloned()
        .collect()
}

fn catalog_digest(tools: &[rmcp::model::Tool]) -> [u8; 32] {
    let encoded = serde_json::to_vec(tools).expect("MCP tool catalog must serialize");
    Sha256::digest(encoded).into()
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn encode_tool_cursor(cursor_digest_hex: &str, offset: usize) -> String {
    format!("{cursor_digest_hex}:{offset:x}")
}

fn decode_tool_cursor(
    cursor: &str,
    cursor_digest_hex: &str,
    catalog_len: usize,
) -> Result<usize, McpError> {
    let Some((digest_hex, offset_hex)) = cursor.split_once(':') else {
        return Err(invalid_tool_cursor("cursor has the wrong shape"));
    };
    if digest_hex != cursor_digest_hex {
        return Err(invalid_tool_cursor(
            "cursor belongs to a different tool catalog",
        ));
    }
    let offset = usize::from_str_radix(offset_hex, 16)
        .map_err(|_| invalid_tool_cursor("cursor offset is malformed"))?;
    if offset == 0 || offset >= catalog_len {
        return Err(invalid_tool_cursor("cursor offset is out of range"));
    }
    Ok(offset)
}

fn invalid_tool_cursor(reason: &str) -> McpError {
    McpError::invalid_params(
        format!("invalid tools/list cursor: {reason}"),
        Some(serde_json::json!({"reason": "invalid_cursor"})),
    )
}

/// The XuanLing MCP server state. Memory is either an explicitly supplied
/// eager store (used by embedding callers/tests), unavailable, or a shared
/// lazy capability configured by the CLI. The stdio entrypoint uses the lazy
/// form so initialize, discovery, and non-memory calls never open/migrate the
/// user's database. The remaining fields are threaded into every invocation.
#[derive(Clone)]
pub struct XuanlingServer {
    memory: MemoryHandle,
    path_context: PathContext,
    filesystem_scope: FilesystemScope,
    default_namespace: Option<String>,
    tool_profiles: ToolProfileSelection,
    catalog: Arc<CatalogState>,
    /// ZCode compat shim (C-16): coerce stringified object parameters.
    /// Default OFF — the strict schema contract is the default surface.
    compat_lenient_object_params: bool,
}

impl Default for XuanlingServer {
    fn default() -> Self {
        let tool_profiles = ToolProfileSelection::default();
        let catalog = CatalogState::for_profiles(&tool_profiles);
        Self {
            memory: MemoryHandle::none(),
            path_context: PathContext::default(),
            filesystem_scope: FilesystemScope::Unrestricted,
            default_namespace: None,
            tool_profiles,
            catalog,
            compat_lenient_object_params: false,
        }
    }
}

impl XuanlingServer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_memory(memory: MemoryStore) -> Self {
        Self {
            memory: MemoryHandle::Ready(memory),
            ..Self::default()
        }
    }

    /// Build a server whose memory database is opened on the first memory
    /// tool call. `memory_db=None` defers default-path resolution as well, so
    /// a missing HOME/USERPROFILE only affects memory calls, not startup.
    pub fn with_lazy_memory(
        memory_db: Option<PathBuf>,
        busy_timeout_ms: u32,
        path_context: PathContext,
        filesystem_scope: FilesystemScope,
        default_namespace: Option<String>,
        tool_profiles: ToolProfileSelection,
    ) -> Self {
        Self::with_memory_handle(
            MemoryHandle::lazy(memory_db, busy_timeout_ms),
            path_context,
            filesystem_scope,
            default_namespace,
            tool_profiles,
        )
    }

    /// Build the server with memory plus CLI-supplied path resolution context
    /// and default namespace (plan §9.1 flags).
    pub fn with_config(
        memory: Option<MemoryStore>,
        path_context: PathContext,
        default_namespace: Option<String>,
    ) -> Self {
        Self::with_capabilities_and_profiles(
            memory,
            path_context,
            FilesystemScope::Unrestricted,
            default_namespace,
            ToolProfileSelection::default(),
        )
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
        Self::with_memory_handle(
            MemoryHandle::ready(memory),
            path_context,
            filesystem_scope,
            default_namespace,
            tool_profiles,
        )
    }

    fn with_memory_handle(
        memory: MemoryHandle,
        path_context: PathContext,
        filesystem_scope: FilesystemScope,
        default_namespace: Option<String>,
        tool_profiles: ToolProfileSelection,
    ) -> Self {
        let catalog = CatalogState::for_profiles(&tool_profiles);
        Self {
            memory,
            path_context,
            filesystem_scope,
            default_namespace,
            tool_profiles,
            catalog,
            compat_lenient_object_params: false,
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
        self.memory.eager()
    }
}

impl ServerHandler for XuanlingServer {
    fn get_info(&self) -> ServerInfo {
        // `ServerInfo` (= `InitializeResult`) is `#[non_exhaustive]`; use the
        // crate-provided constructor + builder instead of a struct literal.
        let mut info = ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("xuanling-mcp", env!("CARGO_PKG_VERSION")))
            .with_instructions(SERVER_INSTRUCTIONS)
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
            serde_json::json!("3"),
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
            serde_json::json!(self.catalog.tools.len() as u64),
        );
        meta.insert(
            "xuanling.catalog_sha256".to_string(),
            serde_json::json!(self.catalog.digest_hex),
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
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListToolsResult, McpError>> + Send {
        let offset = request
            .as_ref()
            .and_then(|params| params.cursor.as_deref())
            .map_or(Ok(0), |cursor| {
                decode_tool_cursor(
                    cursor,
                    &self.catalog.cursor_digest_hex,
                    self.catalog.tools.len(),
                )
            });
        std::future::ready(offset.map(|offset| {
            let end = (offset + TOOL_CATALOG_PAGE_SIZE).min(self.catalog.tools.len());
            ListToolsResult {
                tools: self.catalog.tools[offset..end].to_vec(),
                next_cursor: (end < self.catalog.tools.len())
                    .then(|| encode_tool_cursor(&self.catalog.cursor_digest_hex, end)),
                ..Default::default()
            }
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
        let memory_handle = self.memory.clone();
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
                &memory_handle,
                &path_context,
                &filesystem_scope,
                default_namespace.as_deref(),
            )
            .await;
            result.map(CallToolResponse::from)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_catalog_is_materialized_once() {
        assert!(std::ptr::eq(
            handlers::shared_catalog(),
            handlers::shared_catalog()
        ));
    }

    #[test]
    fn server_clones_share_the_profiled_catalog() {
        let server = XuanlingServer::default();
        let cloned = server.clone();
        assert!(Arc::ptr_eq(&server.catalog, &cloned.catalog));
    }

    #[test]
    fn cached_catalog_preserves_definition_digest() {
        for profiles in [
            ToolProfileSelection::default(),
            ToolProfileSelection::new(vec![crate::ToolProfile::Core]),
            ToolProfileSelection::new(vec![crate::ToolProfile::Fs]),
            ToolProfileSelection::new(vec![crate::ToolProfile::Core, crate::ToolProfile::Process]),
        ] {
            let cached = CatalogState::for_profiles(&profiles);
            let uncached = uncached_filtered_catalog(&profiles);
            assert_eq!(
                serde_json::to_value(cached.tools.as_ref()).unwrap(),
                serde_json::to_value(&uncached).unwrap()
            );
            assert_eq!(cached.digest_hex, hex(&catalog_digest(&uncached)));
        }
    }
}
