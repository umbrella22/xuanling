//! Native worker adapters.
//!
//! Each adapter owns a fixed argv, a bounded protocol collector and a declared
//! non-interactive capability. Adapter configuration is trusted input: the
//! bridge never falls back to `PATH` guessing, never injects a budget or a task
//! deadline, and never proxies an approval prompt.

pub mod claude;
pub mod codex;
pub mod dsh;
pub mod zcode;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::collector::{Collector, Limits};
use crate::config::AdapterConfigs;
use crate::error::{BridgeError, ErrorCode};
use crate::task::FrozenTask;

/// Declared capabilities shown by `harness_health`.
#[derive(Clone, Copy, Debug)]
pub struct AdapterCapabilities {
    /// The fixed invocation disables native session/transcript persistence.
    /// Unverified invocations must be rejected before task acceptance/spawn.
    pub native_session_persistence_disabled: bool,
    /// The supported invocation is a one-shot non-interactive CLI mode.
    pub non_interactive: bool,
    /// The adapter can recognize an explicit native request for approval/input.
    /// `false` means the bridge does not claim `NEEDS_INPUT` detection for it.
    pub needs_input: bool,
}

pub(crate) fn require_no_native_sessions(adapter: &dyn Adapter) -> Result<(), BridgeError> {
    if adapter.capabilities().native_session_persistence_disabled {
        Ok(())
    } else {
        Err(BridgeError::new(
            ErrorCode::NativeSessionPersistenceUnsupported,
            format!(
                "adapter {} has no verified invocation that disables native session persistence",
                adapter.id()
            ),
        ))
    }
}

/// Fully resolved spawn plan for one accepted task.
#[derive(Debug)]
pub struct CommandPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub stdin: Vec<u8>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

pub trait Adapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn version(&self) -> &str;
    fn minimum_version(&self) -> &'static str;
    fn compatible(&self) -> bool;
    fn capabilities(&self) -> AdapterCapabilities;
    fn plan(&self, task: &FrozenTask) -> Result<CommandPlan, BridgeError>;
    fn collector(&self, limits: Limits) -> Box<dyn Collector>;
}

/// Build the configured adapter registry. An absent adapter is simply not
/// available; an invalid configured adapter fails startup.
pub fn build(
    configs: &AdapterConfigs,
) -> Result<BTreeMap<&'static str, Arc<dyn Adapter>>, BridgeError> {
    let mut adapters: BTreeMap<&'static str, Arc<dyn Adapter>> = BTreeMap::new();
    if let Some(config) = &configs.codex {
        let adapter = codex::CodexAdapter::new(config)?;
        adapters.insert(adapter.id(), Arc::new(adapter));
    }
    if let Some(config) = &configs.claude {
        let adapter = claude::ClaudeAdapter::new(config)?;
        adapters.insert(adapter.id(), Arc::new(adapter));
    }
    if let Some(config) = &configs.dsh {
        let adapter = dsh::DshAdapter::new(config)?;
        adapters.insert(adapter.id(), Arc::new(adapter));
    }
    if let Some(config) = &configs.zcode {
        let adapter = zcode::ZcodeAdapter::new(config)?;
        adapters.insert(adapter.id(), Arc::new(adapter));
    }
    Ok(adapters)
}

/// Version prefix used for a coarse compatibility check. The configured
/// version is trusted input, so this rejects obviously foreign CLIs rather than
/// proving a live handshake.
pub(crate) fn version_at_least(version: &str, minimum: (u64, u64, u64)) -> bool {
    parse_version(version).is_some_and(|parsed| parsed >= minimum)
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let start = text.find(|ch: char| ch.is_ascii_digit())?;
    let mut parts = [0_u64; 3];
    let mut index = 0;
    for segment in text[start..].split('.') {
        if index == 3 {
            break;
        }
        let digits: String = segment
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .collect();
        if digits.is_empty() {
            break;
        }
        parts[index] = digits.parse().ok()?;
        index += 1;
        if segment.len() > digits.len() {
            break;
        }
    }
    (index > 0).then_some((parts[0], parts[1], parts[2]))
}

pub(crate) fn require_absolute_file(path: &Path, role: &str) -> Result<(), BridgeError> {
    if !path.is_absolute() {
        return Err(BridgeError::config(format!("{role} path must be absolute")));
    }
    let metadata = std::fs::metadata(path)
        .map_err(|error| BridgeError::config(format!("{role} path: {error}")))?;
    if !metadata.is_file() {
        return Err(BridgeError::config(format!(
            "{role} path is not a regular file"
        )));
    }
    Ok(())
}

pub(crate) fn require_version(version: &str) -> Result<(), BridgeError> {
    if version.trim().is_empty() {
        return Err(BridgeError::config("adapter version must not be empty"));
    }
    Ok(())
}

pub(crate) fn ensure_supported(
    version: &str,
    minimum: (u64, u64, u64),
) -> Result<bool, BridgeError> {
    require_version(version)?;
    Ok(version_at_least(version, minimum))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions_with_suffixes() {
        assert_eq!(
            parse_version("codex-cli 0.165.0-alpha.1.2"),
            Some((0, 165, 0))
        );
        assert_eq!(parse_version("2.1.311-darwin-arm64"), Some((2, 1, 311)));
        assert_eq!(parse_version("0.2.1-rc.3"), Some((0, 2, 1)));
        assert_eq!(parse_version("0.17.0"), Some((0, 17, 0)));
        assert_eq!(parse_version("no digits"), None);
    }

    #[test]
    fn compatibility_is_a_minimum_check() {
        assert!(version_at_least("0.165.0", (0, 160, 0)));
        assert!(!version_at_least("0.150.0", (0, 160, 0)));
    }
}
