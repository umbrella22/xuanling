//! `system_info` tool (plan §7.1).
//!
//! Returns deterministic runtime facts an external agent needs to choose
//! platform-correct behavior: OS family/name, CPU architecture, process cwd,
//! path separator, newline style, and executable suffixes (PATHEXT on
//! Windows). It deliberately does NOT return the full environment block or any
//! secret — only the minimal facts above.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::ToolError;

/// Request for `system_info` — empty object (no caller inputs).
#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SystemInfoRequest {}

/// `system_info` result. Fields are the same shape across Windows/macOS/Linux;
/// only the values differ.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SystemInfoResult {
    /// OS family for control-flow: `windows` | `unix` (macOS/Linux/BSD).
    pub family: String,
    /// Specific OS: `windows` | `macos` | `linux` | `freebsd` …
    pub os: String,
    /// CPU architecture: `x86_64` | `aarch64` | …
    pub arch: String,
    /// Process current working directory (display form). `null` if the cwd
    /// cannot be determined.
    pub cwd: Option<String>,
    /// Native path separator: `\` on Windows, `/` elsewhere.
    pub path_separator: String,
    /// Native line separator: `\r\n` on Windows, `\n` elsewhere.
    pub newline: String,
    /// Executable suffixes considered when resolving a bare program name.
    /// On Windows this mirrors PATHEXT (e.g. `.COM;.EXE;.BAT;…`); elsewhere an
    /// empty list (no implicit suffixes).
    pub executable_suffixes: Vec<String>,
    /// Pointer/bit width when determinable: `32` | `64`.
    pub pointer_width: u32,
}

/// Compute `system_info` from the current process's runtime facts.
///
/// This operation is infallible at the domain level: even if the cwd cannot be
/// read, the rest of the facts are returned with `cwd = null`. It does not
/// touch the network or read secrets.
pub fn system_info() -> SystemInfoResult {
    let family = if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unix"
    };
    let os = detect_os();
    let arch = detect_arch();
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let path_separator = std::path::MAIN_SEPARATOR.to_string();
    let newline = if cfg!(target_os = "windows") {
        "\r\n".to_string()
    } else {
        "\n".to_string()
    };
    let executable_suffixes = executable_suffixes();
    let pointer_width = usize::BITS;

    SystemInfoResult {
        family: family.to_string(),
        os: os.to_string(),
        arch: arch.to_string(),
        cwd,
        path_separator,
        newline,
        executable_suffixes,
        pointer_width,
    }
}

/// Entry point for the MCP handler. Takes a
/// [`crate::invocation::InvocationContext`] for uniformity with other tools;
/// `system_info` does not currently use it but keeps the signature consistent
/// so cancellation is plumbable later.
pub fn info(_ctx: &crate::invocation::InvocationContext) -> Result<SystemInfoResult, ToolError> {
    Ok(system_info())
}

fn detect_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "freebsd") {
        "freebsd"
    } else if cfg!(target_os = "openbsd") {
        "openbsd"
    } else if cfg!(target_os = "netbsd") {
        "netbsd"
    } else {
        "unknown"
    }
}

fn detect_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else if cfg!(target_arch = "arm") {
        "arm"
    } else if cfg!(target_arch = "riscv64") {
        "riscv64"
    } else if cfg!(target_arch = "powerpc64") {
        "powerpc64"
    } else {
        "unknown"
    }
}

/// Executable suffixes. On Windows the canonical PATHEXT set is returned as a
/// sorted, normalized list (without the `;`-joined form). On non-Windows there
/// are no implicit executable suffixes, so the list is empty.
fn executable_suffixes() -> Vec<String> {
    if cfg!(target_os = "windows") {
        // Canonical Windows PATHEXT (case-insensitive on the FS, but we report
        // uppercase as the conventional form). No version probe; this is a
        // static fact.
        [
            ".COM", ".EXE", ".BAT", ".CMD", ".VBS", ".VBE", ".JS", ".JSE", ".WSF", ".WSH", ".MSC",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    } else {
        Vec::new()
    }
}
