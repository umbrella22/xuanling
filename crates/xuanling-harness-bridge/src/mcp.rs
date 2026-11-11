//! MCP controller surface: four tools, ordinary tool responses only.
//!
//! `harness_health`, `harness_submit`, `harness_wait` and `harness_cancel` are
//! the entire public surface. Waiting is a tool call; ending a wait window or
//! cancelling that RPC never stops the worker. The bridge does not emit progress
//! events, notifications or a background wake-up claim.

use std::sync::Arc;

use rmcp::ErrorData as McpError;
use rmcp::RoleServer;
use rmcp::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    JsonObject, ListToolsResult, PaginatedRequestParams, ProtocolVersion, ServerCapabilities,
    ServerConfig, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::adapters::Adapter;
use crate::error::BridgeError;
use crate::jobs::{FinalResult, Registry, WaitOutcome};
use crate::supervisor;
use crate::task::SubmitInput;

/// Version of the tool/result contract carried by responses.
const CONTRACT_VERSION: u32 = 1;

/// Adapter slots reported by `harness_health`, configured or not.
const HEALTH_ADAPTERS: [&str; 4] = ["claude", "codex", "dsh", "zcode"];

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HealthRequest {}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SubmitRequest {
    /// Current bridge instance id from `harness_health`. A stale id is
    /// rejected with `INSTANCE_CHANGED`.
    pub instance_id: String,
    /// Caller-chosen request identity, scoped to this bridge instance.
    pub request_id: String,
    /// Configured adapter id: `codex`, `claude`, `dsh` or `zcode`.
    pub adapter: String,
    /// Configured workspace id.
    pub workspace_id: String,
    /// Task text. Mutually exclusive with `task_file`.
    #[serde(default)]
    pub prompt: Option<String>,
    /// Task file resolved under the workspace root. Mutually exclusive with
    /// `prompt`.
    #[serde(default)]
    pub task_file: Option<String>,
    /// Publish one final Markdown result after the terminal state.
    #[serde(default)]
    pub save_result: bool,
    /// Explicit RFC3339 task deadline. There is no default task deadline.
    #[serde(default)]
    pub deadline_at: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WaitRequest {
    pub job_id: String,
    /// Wait window for this single tool call. Omit to wait until the worker
    /// reaches a terminal state. This is not a task timeout.
    #[serde(default)]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CancelRequest {
    pub job_id: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct SubmitResponse {
    pub job_id: String,
    pub instance_id: String,
    pub status: String,
    pub accepted: bool,
    pub reused: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct WaitResponse {
    /// `pending` or `final`.
    pub state: String,
    pub job_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// How long *this* wait call blocked before returning `pending`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<FinalResult>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct CancelResponse {
    pub job_id: String,
    pub cancelled: bool,
    pub result: FinalResult,
}

impl From<SubmitRequest> for SubmitInput {
    fn from(request: SubmitRequest) -> Self {
        Self {
            instance_id: request.instance_id,
            request_id: request.request_id,
            adapter: request.adapter,
            workspace_id: request.workspace_id,
            prompt: request.prompt,
            task_file: request.task_file,
            save_result: request.save_result,
            deadline_at: request.deadline_at,
        }
    }
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct AdapterHealth {
    pub native_session_persistence_disabled: bool,
    pub id: String,
    pub configured: bool,
    pub compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Minimum CLI version this build accepts (`None` when not configured).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum_version: Option<String>,
    pub non_interactive: bool,
    pub needs_input: bool,
}

impl AdapterHealth {
    /// Describe one adapter slot; `None` means that slot is not configured.
    fn describe(id: &str, adapter: Option<&dyn Adapter>) -> Self {
        match adapter {
            Some(adapter) => {
                let capabilities = adapter.capabilities();
                Self {
                    id: id.to_string(),
                    configured: true,
                    compatible: adapter.compatible(),
                    version: Some(adapter.version().to_string()),
                    minimum_version: Some(adapter.minimum_version().to_string()),
                    non_interactive: capabilities.non_interactive,
                    needs_input: capabilities.needs_input,
                    native_session_persistence_disabled: capabilities
                        .native_session_persistence_disabled,
                }
            }
            None => Self {
                id: id.to_string(),
                configured: false,
                compatible: false,
                version: None,
                minimum_version: None,
                non_interactive: false,
                needs_input: false,
                native_session_persistence_disabled: false,
            },
        }
    }
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct HealthLimits {
    pub max_active_jobs: usize,
    pub max_retained_jobs: usize,
    pub max_final_bytes: usize,
    pub max_protocol_bytes: usize,
    /// Always null: the bridge has no default task deadline.
    pub default_deadline_at: Option<String>,
    /// Always null: the bridge injects no consumption budget.
    pub consumption_budget: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct HealthCapabilities {
    pub persistent_state: bool,
    pub cross_instance_dedupe: bool,
    pub restart_recovery: bool,
    pub wait_cancel_keeps_job: bool,
    pub optional_markdown_result: bool,
    pub process_logs_exposed: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct HealthResponse {
    pub instance_id: String,
    pub bridge_version: String,
    pub contract_version: u32,
    pub adapters: Vec<AdapterHealth>,
    pub limits: HealthLimits,
    pub capabilities: HealthCapabilities,
}

#[derive(Clone)]
pub struct BridgeServer {
    registry: Arc<Registry>,
}

impl BridgeServer {
    pub fn new(registry: Arc<Registry>) -> Self {
        Self { registry }
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.registry
    }

    fn health(&self) -> HealthResponse {
        let config = &self.registry.config;
        let adapters = HEALTH_ADAPTERS
            .into_iter()
            .map(|id| AdapterHealth::describe(id, config.adapter(id).as_deref()))
            .collect();
        HealthResponse {
            instance_id: config.instance_id.clone(),
            bridge_version: config.bridge_version.to_string(),
            contract_version: CONTRACT_VERSION,
            adapters,
            limits: HealthLimits {
                max_active_jobs: config.max_active_jobs,
                max_retained_jobs: config.max_retained_jobs,
                max_final_bytes: config.max_final_bytes,
                max_protocol_bytes: config.max_protocol_bytes,
                default_deadline_at: None,
                consumption_budget: None,
            },
            capabilities: HealthCapabilities {
                persistent_state: false,
                cross_instance_dedupe: false,
                restart_recovery: false,
                wait_cancel_keeps_job: true,
                optional_markdown_result: true,
                process_logs_exposed: false,
            },
        }
    }

    async fn submit(&self, arguments: &Value) -> Result<CallToolResult, McpError> {
        let request: SubmitRequest = decode(arguments)?;
        match self.registry.submit(request.into()) {
            Ok(outcome) => {
                let job = outcome.job;
                if !outcome.reused {
                    let adapter =
                        self.registry
                            .config
                            .adapter(&job.task.adapter)
                            .ok_or_else(|| {
                                McpError::internal_error("accepted adapter disappeared", None)
                            })?;
                    let redactor = self.registry.config.redactor.clone();
                    let registry = self.registry.clone();
                    tokio::spawn(supervisor::run(registry, job.clone(), adapter, redactor));
                }
                structured(&SubmitResponse {
                    job_id: job.id.clone(),
                    instance_id: job.instance_id.clone(),
                    status: job.phase_label().to_string(),
                    accepted: true,
                    reused: outcome.reused,
                })
            }
            Err(error) => domain_error(error),
        }
    }

    async fn wait(&self, arguments: &Value) -> Result<CallToolResult, McpError> {
        let request: WaitRequest = decode(arguments)?;
        match self.registry.wait(&request.job_id, request.wait_ms).await {
            Ok(WaitOutcome::Pending { status, elapsed_ms }) => structured(&WaitResponse {
                state: "pending".to_string(),
                job_id: request.job_id,
                status: Some(status.to_string()),
                elapsed_ms: Some(elapsed_ms),
                result: None,
            }),
            Ok(WaitOutcome::Final(result)) => structured(&WaitResponse {
                state: "final".to_string(),
                job_id: result.job_id.clone(),
                status: Some(result.status.as_str().to_string()),
                elapsed_ms: None,
                result: Some(result),
            }),
            Err(error) => domain_error(error),
        }
    }

    async fn cancel(&self, arguments: &Value) -> Result<CallToolResult, McpError> {
        let request: CancelRequest = decode(arguments)?;
        match self.registry.cancel(&request.job_id).await {
            Ok(result) => structured(&CancelResponse {
                job_id: request.job_id,
                cancelled: result.status == crate::jobs::TerminalStatus::Cancelled,
                result,
            }),
            Err(error) => domain_error(error),
        }
    }
}

impl ServerHandler for BridgeServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "harness-bridge",
                self.registry.config.bridge_version,
            ))
            .with_instructions(
                "Result-only worker bridge. harness_submit starts one configured native worker; \
                 harness_wait returns its final answer or a minimal pending status. Wait-window \
                 cancellation and job cancellation are separate. There is no process log, no \
                 persistent job database and no automatic continuation.",
            )
            .with_protocol_version(ProtocolVersion::V_2025_11_25)
    }

    fn supported_protocol_versions(&self) -> std::borrow::Cow<'static, [ProtocolVersion]> {
        std::borrow::Cow::Owned(vec![
            ProtocolVersion::V_2025_06_18,
            ProtocolVersion::V_2025_11_25,
        ])
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListToolsResult, McpError>> + Send {
        std::future::ready(Ok(ListToolsResult {
            tools: vec![
                tool::<HealthRequest, HealthResponse>(
                    "harness_health",
                    "Return this instance_id, configured adapter versions, declared capabilities and limits. Read-only: no credential probe and no worker spawn.",
                    read_only(),
                ),
                tool::<SubmitRequest, SubmitResponse>(
                    "harness_submit",
                    "Freeze one task and accept it for a configured worker adapter. Returns job_id, accepted and whether an identical request_id payload was reused. Runs no process log and writes no task file.",
                    mutating(),
                ),
                tool::<WaitRequest, WaitResponse>(
                    "harness_wait",
                    "Wait for a job's terminal result or for this call's wait window. A pending response is minimal. Ending or cancelling this call does not stop the worker.",
                    read_only(),
                ),
                tool::<CancelRequest, CancelResponse>(
                    "harness_cancel",
                    "Explicitly cancel a job and return its terminal result plus process cleanup evidence. Repeated calls are idempotent.",
                    mutating_idempotent(),
                ),
            ],
            next_cursor: None,
            ..Default::default()
        }))
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<CallToolResponse, McpError>> + Send {
        let name = request.name.into_owned();
        let arguments = request
            .arguments
            .map(Value::Object)
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
        let server = self.clone();
        Box::pin(async move {
            let result = match name.as_str() {
                "harness_health" => {
                    let _: HealthRequest = decode(&arguments)?;
                    structured(&server.health())
                }
                "harness_submit" => server.submit(&arguments).await,
                "harness_wait" => server.wait(&arguments).await,
                "harness_cancel" => server.cancel(&arguments).await,
                other => Err(McpError::invalid_params(
                    format!("unknown tool: {other}"),
                    None,
                )),
            };
            result.map(CallToolResponse::from)
        })
    }
}

fn tool<I, R>(name: &'static str, description: &'static str, annotations: ToolAnnotations) -> Tool
where
    I: JsonSchema + 'static,
    R: JsonSchema + 'static,
{
    Tool::new(name, description, Arc::new(JsonObject::new()))
        .with_input_schema::<I>()
        .with_output_schema::<R>()
        .with_annotations(annotations)
}

fn read_only() -> ToolAnnotations {
    ToolAnnotations::new()
        .read_only(true)
        .destructive(false)
        .idempotent(true)
        .open_world(false)
}

fn mutating() -> ToolAnnotations {
    ToolAnnotations::new()
        .read_only(false)
        .destructive(true)
        .idempotent(false)
        .open_world(true)
}

fn mutating_idempotent() -> ToolAnnotations {
    ToolAnnotations::new()
        .read_only(false)
        .destructive(true)
        .idempotent(true)
        .open_world(false)
}

fn decode<T: serde::de::DeserializeOwned>(arguments: &Value) -> Result<T, McpError> {
    serde_json::from_value(arguments.clone()).map_err(|error| {
        McpError::invalid_params(format!("invalid request arguments: {error}"), None)
    })
}

fn structured<T: Serialize>(value: &T) -> Result<CallToolResult, McpError> {
    let json = serde_json::to_value(value)
        .map_err(|error| McpError::internal_error(format!("serialize result: {error}"), None))?;
    Ok(CallToolResult::structured(json))
}

fn domain_error(error: BridgeError) -> Result<CallToolResult, McpError> {
    let payload = serde_json::to_value(&error).unwrap_or(Value::Null);
    let mut result = CallToolResult::structured_error(payload.clone());
    result.content = vec![
        ContentBlock::text(error.to_string()),
        ContentBlock::text(payload.to_string()),
    ];
    Ok(result)
}
