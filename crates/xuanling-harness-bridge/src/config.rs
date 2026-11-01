//! Trusted bridge configuration and its resolved runtime form.
//!
//! The configuration file names worker executables, workspace roots and the
//! environment variables the bridge may forward. It never contains secret
//! values, and the bridge never opens a harness credential file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::adapters::{self, Adapter};
use crate::error::BridgeError;
use crate::redact::Redactor;
use crate::report::ReportDirectory;

/// Environment variables forwarded to every worker unless the host config
/// names more. Credentials are deliberately absent: forwarding a provider key
/// requires an explicit `env_allowlist` entry.
const BASE_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
    "COMSPEC",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
];

const MAX_CONFIG_BYTES: u64 = 1 << 20;

fn default_max_active_jobs() -> usize {
    1
}

fn default_max_retained_jobs() -> usize {
    512
}

fn default_max_final_bytes() -> usize {
    1 << 20
}

fn default_max_diagnostic_bytes() -> usize {
    8 << 10
}

fn default_max_protocol_line_bytes() -> usize {
    // Larger than `max_final_bytes` so a final answer near the result budget is
    // parsed and reported as RESULT_TOO_LARGE instead of being mistaken for a
    // broken protocol stream.
    4 << 20
}

fn default_max_protocol_bytes() -> usize {
    8 << 20
}

fn default_max_prompt_bytes() -> usize {
    1 << 20
}

fn default_true() -> bool {
    true
}

fn default_codex_sandbox() -> String {
    "read-only".to_string()
}

fn default_claude_permission_mode() -> String {
    "manual".to_string()
}

fn default_dsh_profile() -> String {
    "headless".to_string()
}

/// Configuration file shape (`harness-bridge --config <path>`).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeConfig {
    #[serde(default = "default_max_active_jobs")]
    pub max_active_jobs: usize,
    #[serde(default = "default_max_retained_jobs")]
    pub max_retained_jobs: usize,
    #[serde(default = "default_max_final_bytes")]
    pub max_final_bytes: usize,
    #[serde(default = "default_max_diagnostic_bytes")]
    pub max_diagnostic_bytes: usize,
    #[serde(default = "default_max_protocol_line_bytes")]
    pub max_protocol_line_bytes: usize,
    #[serde(default = "default_max_protocol_bytes")]
    pub max_protocol_bytes: usize,
    #[serde(default = "default_max_prompt_bytes")]
    pub max_prompt_bytes: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub results_dir: Option<PathBuf>,
    /// Ordered workspace id to root directory. `task_file` inputs resolve under
    /// the selected root and may not escape it.
    #[serde(default)]
    pub workspaces: BTreeMap<String, PathBuf>,
    /// Additional environment variable *names* forwarded to workers.
    #[serde(default)]
    pub env_allowlist: Vec<String>,
    /// Environment variable names whose values are redacted from worker text.
    #[serde(default)]
    pub secret_env: Vec<String>,
    #[serde(default)]
    pub adapters: AdapterConfigs,
}

impl Default for BridgeConfig {
    /// Same defaults as an empty configuration object, used when no config
    /// file is supplied.
    fn default() -> Self {
        Self {
            max_active_jobs: default_max_active_jobs(),
            max_retained_jobs: default_max_retained_jobs(),
            max_final_bytes: default_max_final_bytes(),
            max_diagnostic_bytes: default_max_diagnostic_bytes(),
            max_protocol_line_bytes: default_max_protocol_line_bytes(),
            max_protocol_bytes: default_max_protocol_bytes(),
            max_prompt_bytes: default_max_prompt_bytes(),
            results_dir: None,
            workspaces: BTreeMap::new(),
            env_allowlist: Vec::new(),
            secret_env: Vec::new(),
            adapters: AdapterConfigs::default(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AdapterConfigs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<CodexConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<ClaudeConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsh: Option<DshConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zcode: Option<ZcodeConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CodexConfig {
    pub program: PathBuf,
    pub version: String,
    #[serde(default = "default_codex_sandbox")]
    pub sandbox: String,
    #[serde(default = "default_true")]
    pub skip_git_repo_check: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeConfig {
    pub program: PathBuf,
    pub version: String,
    #[serde(default = "default_claude_permission_mode")]
    pub permission_mode: String,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DshConfig {
    pub program: PathBuf,
    pub version: String,
    #[serde(default = "default_dsh_profile")]
    pub profile: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ZcodeConfig {
    /// Node runtime that executes `script`.
    pub runner: PathBuf,
    /// Absolute path to the ZCode `zcode.cjs` entry point.
    pub script: PathBuf,
    pub version: String,
    /// Explicit non-interactive permission mode. `yolo` is rejected because it
    /// bypasses approvals; the bridge does not proxy approvals. Model/provider
    /// selection stays in the ZCode CLI's own configuration.
    pub mode: String,
}

/// Resolved configuration bound to one bridge instance.
pub struct RuntimeConfig {
    pub bridge_version: &'static str,
    pub instance_id: String,
    pub max_active_jobs: usize,
    pub max_retained_jobs: usize,
    pub max_final_bytes: usize,
    pub max_diagnostic_bytes: usize,
    pub max_protocol_line_bytes: usize,
    pub max_protocol_bytes: usize,
    pub max_prompt_bytes: usize,
    pub results_dir: Option<ReportDirectory>,
    pub workspaces: BTreeMap<String, PathBuf>,
    pub adapters: BTreeMap<&'static str, Arc<dyn Adapter>>,
    pub redactor: Arc<Redactor>,
    pub revision: String,
    env_allowlist: Vec<String>,
    raw: BridgeConfig,
}

impl RuntimeConfig {
    /// Load and validate configuration. A missing path yields an adapter-less
    /// instance that still answers `harness_health`.
    pub fn load(path: Option<&Path>) -> Result<Self, BridgeError> {
        let raw = match path {
            Some(path) => read_config(path)?,
            None => BridgeConfig::default(),
        };
        Self::from_config(raw)
    }

    /// Validate an in-memory configuration (used by tests and `main`).
    pub fn from_config(raw: BridgeConfig) -> Result<Self, BridgeError> {
        validate_positive("max_active_jobs", raw.max_active_jobs)?;
        validate_positive("max_retained_jobs", raw.max_retained_jobs)?;
        validate_positive("max_final_bytes", raw.max_final_bytes)?;
        validate_positive("max_diagnostic_bytes", raw.max_diagnostic_bytes)?;
        validate_positive("max_protocol_line_bytes", raw.max_protocol_line_bytes)?;
        validate_positive("max_protocol_bytes", raw.max_protocol_bytes)?;
        validate_positive("max_prompt_bytes", raw.max_prompt_bytes)?;
        if raw.max_retained_jobs < raw.max_active_jobs {
            return Err(BridgeError::config(
                "max_retained_jobs must be at least max_active_jobs",
            ));
        }

        let mut workspaces = BTreeMap::new();
        for (id, root) in &raw.workspaces {
            if id.is_empty() {
                return Err(BridgeError::config("workspace id must not be empty"));
            }
            let canonical = canonical_directory(root, "workspace")?;
            workspaces.insert(id.clone(), canonical);
        }

        let results_dir = match &raw.results_dir {
            Some(path) => Some(
                ReportDirectory::open(canonical_directory(path, "results_dir")?)
                    .map_err(|error| BridgeError::config(error.message))?,
            ),
            None => None,
        };

        for name in raw.env_allowlist.iter().chain(raw.secret_env.iter()) {
            validate_env_name(name)?;
        }

        let adapters = adapters::build(&raw.adapters)?;
        let redactor = Arc::new(Redactor::from_env_names(&raw.secret_env));

        let mut hasher = Sha256::new();
        hasher.update(env!("CARGO_PKG_VERSION").as_bytes());
        hasher.update([0]);
        hasher.update(
            serde_json::to_vec(&raw)
                .map_err(|error| BridgeError::config(format!("serialize config: {error}")))?,
        );
        let revision = hex(&hasher.finalize());

        Ok(Self {
            bridge_version: env!("CARGO_PKG_VERSION"),
            instance_id: format!("inst-{}", Uuid::new_v4().simple()),
            max_active_jobs: raw.max_active_jobs,
            max_retained_jobs: raw.max_retained_jobs,
            max_final_bytes: raw.max_final_bytes,
            max_diagnostic_bytes: raw.max_diagnostic_bytes,
            max_protocol_line_bytes: raw.max_protocol_line_bytes,
            max_protocol_bytes: raw.max_protocol_bytes,
            max_prompt_bytes: raw.max_prompt_bytes,
            results_dir,
            workspaces,
            adapters,
            redactor,
            revision,
            env_allowlist: raw.env_allowlist.clone(),
            raw,
        })
    }

    pub fn adapter(&self, id: &str) -> Option<Arc<dyn Adapter>> {
        self.adapters.get(id).cloned()
    }

    pub fn workspace(&self, id: &str) -> Option<&Path> {
        self.workspaces.get(id).map(PathBuf::as_path)
    }

    /// Environment forwarded to a worker: the fixed baseline plus the
    /// configured name allowlist. Values are read at spawn time.
    pub fn child_env(&self) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        for name in BASE_ENV_ALLOWLIST
            .iter()
            .copied()
            .chain(self.env_allowlist.iter().map(String::as_str))
        {
            if let Some(value) = std::env::var_os(name)
                && let Some(value) = value.to_str()
            {
                env.insert(name.to_string(), value.to_string());
            }
        }
        env
    }

    /// The validated configuration file shape (health diagnostics only).
    pub fn raw(&self) -> &BridgeConfig {
        &self.raw
    }
}

fn read_config(path: &Path) -> Result<BridgeConfig, BridgeError> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| BridgeError::config(format!("read config metadata: {error}")))?;
    if !metadata.is_file() {
        return Err(BridgeError::config("config path is not a regular file"));
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(BridgeError::config("config file exceeds 1 MiB"));
    }
    let bytes = std::fs::read(path)
        .map_err(|error| BridgeError::config(format!("read config: {error}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| BridgeError::config(format!("parse config: {error}")))
}

fn validate_positive(name: &str, value: usize) -> Result<(), BridgeError> {
    if value == 0 {
        return Err(BridgeError::config(format!("{name} must be positive")));
    }
    Ok(())
}

fn canonical_directory(path: &Path, role: &str) -> Result<PathBuf, BridgeError> {
    if !path.is_absolute() {
        return Err(BridgeError::config(format!("{role} path must be absolute")));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| BridgeError::config(format!("{role} path: {error}")))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| BridgeError::config(format!("{role} path: {error}")))?;
    if !metadata.is_dir() {
        return Err(BridgeError::config(format!(
            "{role} path is not a directory"
        )));
    }
    Ok(canonical)
}

fn validate_env_name(name: &str) -> Result<(), BridgeError> {
    let valid = !name.is_empty()
        && name.chars().all(|ch| {
            ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '(' || ch == ')'
        });
    if valid {
        Ok(())
    } else {
        Err(BridgeError::config(format!(
            "invalid environment variable name: {name:?}"
        )))
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(text, "{byte:02x}");
    }
    text
}
