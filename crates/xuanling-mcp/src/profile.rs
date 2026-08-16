use std::collections::BTreeSet;

use clap::ValueEnum;

/// A discovery and dispatch group for the MCP tool catalog.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, ValueEnum)]
pub enum ToolProfile {
    /// Every tool. This is the backward-compatible default.
    All,
    /// Runtime and portable path inspection.
    Core,
    /// Filesystem read, preview, and mutation tools.
    Fs,
    /// Direct process and project detection/execution tools.
    Process,
    /// Persistent memory tools.
    Memory,
    /// Artifact, ChangeSet, pipeline, and session lifecycle tools.
    Advanced,
}

impl ToolProfile {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Core => "core",
            Self::Fs => "fs",
            Self::Process => "process",
            Self::Memory => "memory",
            Self::Advanced => "advanced",
        }
    }
}

/// Canonicalized profile selection shared by discovery metadata and dispatch.
#[derive(Clone, Debug)]
pub struct ToolProfileSelection {
    selected: BTreeSet<ToolProfile>,
}

impl Default for ToolProfileSelection {
    fn default() -> Self {
        Self::new(Vec::new())
    }
}

impl ToolProfileSelection {
    pub fn new(profiles: Vec<ToolProfile>) -> Self {
        if profiles.is_empty() || profiles.contains(&ToolProfile::All) {
            return Self {
                selected: BTreeSet::from([ToolProfile::All]),
            };
        }
        Self {
            selected: profiles.into_iter().collect(),
        }
    }

    pub fn names(&self) -> Vec<&'static str> {
        self.selected
            .iter()
            .copied()
            .map(ToolProfile::as_str)
            .collect()
    }

    pub fn allows_tool(&self, name: &str) -> bool {
        self.selected.contains(&ToolProfile::All)
            || profile_for_tool(name).is_some_and(|profile| self.selected.contains(&profile))
    }
}

fn profile_for_tool(name: &str) -> Option<ToolProfile> {
    match name {
        "system_info" | "path_resolve" | "path_relative" => Some(ToolProfile::Core),
        "artifact_read"
        | "artifact_cleanup_preview"
        | "artifact_cleanup"
        | "change_rollback"
        | "change_commit"
        | "process_pipeline"
        | "session_open"
        | "session_exec"
        | "session_close" => Some(ToolProfile::Advanced),
        value if value.starts_with("fs_") => Some(ToolProfile::Fs),
        value if value.starts_with("memory_") => Some(ToolProfile::Memory),
        value if value.starts_with("process_") || value.starts_with("project_") => {
            Some(ToolProfile::Process)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{ToolProfile, ToolProfileSelection};

    #[test]
    fn all_is_the_default_and_dominates_other_values() {
        assert_eq!(ToolProfileSelection::default().names(), vec!["all"]);
        assert_eq!(
            ToolProfileSelection::new(vec![ToolProfile::Fs, ToolProfile::All]).names(),
            vec!["all"]
        );
    }

    #[test]
    fn categories_cover_representative_tools() {
        let selection = ToolProfileSelection::new(vec![ToolProfile::Core, ToolProfile::Advanced]);
        assert!(selection.allows_tool("system_info"));
        assert!(selection.allows_tool("process_pipeline"));
        assert!(!selection.allows_tool("process_run"));
        assert!(!selection.allows_tool("fs_read_text"));
    }
}
