//! Task validation and byte freezing.
//!
//! Acceptance reads a `task_file` once, under the selected workspace root, and
//! keeps the frozen bytes for the whole job. A later change to the source file
//! therefore cannot change what the accepted job runs.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::config::{RuntimeConfig, hex};
use crate::error::{BridgeError, ErrorCode};

/// Raw submit input after MCP decoding.
#[derive(Clone, Debug)]
pub struct SubmitInput {
    pub instance_id: String,
    pub request_id: String,
    pub adapter: String,
    pub workspace_id: String,
    pub prompt: Option<String>,
    pub task_file: Option<String>,
    pub save_result: bool,
    pub deadline_at: Option<String>,
}

/// The single task input selected by a submit request.
enum TaskSource<'a> {
    Prompt(&'a str),
    File(&'a str),
}

impl SubmitInput {
    fn source(&self) -> Result<TaskSource<'_>, BridgeError> {
        match (&self.prompt, &self.task_file) {
            (Some(prompt), None) => Ok(TaskSource::Prompt(prompt)),
            (None, Some(path)) => Ok(TaskSource::File(path)),
            (Some(_), Some(_)) => Err(BridgeError::invalid_request(
                "provide exactly one of prompt or task_file",
            )),
            (None, None) => Err(BridgeError::invalid_request(
                "one of prompt or task_file is required",
            )),
        }
    }
}

/// One accepted task bound to its frozen bytes.
#[derive(Clone, Debug)]
pub struct FrozenTask {
    pub adapter: String,
    pub workspace_id: String,
    pub workspace_root: PathBuf,
    pub prompt: String,
    pub input_sha256: String,
    pub task_file: Option<String>,
    pub save_result: bool,
    pub deadline_at: Option<OffsetDateTime>,
    pub payload_fingerprint: String,
}

impl FrozenTask {
    /// Deadline as a wall-clock instant, resolved when the job starts.
    pub fn deadline_time(&self) -> Option<SystemTime> {
        self.deadline_at.map(SystemTime::from)
    }
}

/// A request fingerprint computed without reading the task file. It is used for
/// instance-local deduplication: the same `request_id` and payload reuse the
/// frozen job, while any changed execution parameter conflicts.
pub fn payload_fingerprint(config: &RuntimeConfig, input: &SubmitInput) -> String {
    #[derive(Serialize)]
    struct Payload<'a> {
        adapter: &'a str,
        workspace_id: &'a str,
        prompt: Option<&'a str>,
        task_file: Option<&'a str>,
        save_result: bool,
        deadline_at: Option<String>,
        config_revision: &'a str,
    }

    let payload = Payload {
        adapter: &input.adapter,
        workspace_id: &input.workspace_id,
        prompt: input.prompt.as_deref(),
        task_file: input.task_file.as_deref(),
        save_result: input.save_result,
        deadline_at: input.deadline_at.clone(),
        config_revision: &config.revision,
    };
    let bytes = serde_json::to_vec(&payload).expect("fingerprint payload serializes");
    hex(&Sha256::digest(&bytes))
}

/// Validate a submit request and freeze its input bytes.
pub fn freeze(config: &RuntimeConfig, input: SubmitInput) -> Result<FrozenTask, BridgeError> {
    let workspace_root = config
        .workspace(&input.workspace_id)
        .ok_or_else(|| {
            BridgeError::invalid_request(format!("unknown workspace_id: {}", input.workspace_id))
        })?
        .to_path_buf();

    let source = input.source()?;

    let deadline_at = match &input.deadline_at {
        Some(text) => {
            let parsed = OffsetDateTime::parse(text, &Rfc3339).map_err(|error| {
                BridgeError::invalid_request(format!("deadline_at is not RFC3339: {error}"))
            })?;
            if parsed <= OffsetDateTime::now_utc() {
                return Err(BridgeError::invalid_request(
                    "deadline_at must be in the future",
                ));
            }
            Some(parsed)
        }
        None => None,
    };

    if input.save_result && config.results_dir.is_none() {
        return Err(BridgeError::config(
            "save_result requires a configured results_dir",
        ));
    }

    let (prompt, task_file) = match source {
        TaskSource::Prompt(prompt) => {
            if prompt.len() > config.max_prompt_bytes {
                return Err(BridgeError::invalid_request(format!(
                    "prompt exceeds max_prompt_bytes ({})",
                    config.max_prompt_bytes
                )));
            }
            (prompt.to_string(), None)
        }
        TaskSource::File(path) => {
            let bytes = read_task_file(&workspace_root, path, config.max_prompt_bytes)?;
            let prompt = String::from_utf8(bytes).map_err(|_| {
                BridgeError::new(ErrorCode::TaskReadFailed, "task_file is not valid UTF-8")
            })?;
            (prompt, Some(path.to_string()))
        }
    };

    let payload_fingerprint = payload_fingerprint(config, &input);
    let input_sha256 = hex(&Sha256::digest(prompt.as_bytes()));

    Ok(FrozenTask {
        adapter: input.adapter,
        workspace_id: input.workspace_id,
        workspace_root,
        prompt,
        input_sha256,
        task_file,
        save_result: input.save_result,
        deadline_at,
        payload_fingerprint,
    })
}

fn read_task_file(
    workspace_root: &Path,
    task_file: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, BridgeError> {
    let requested = Path::new(task_file);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        workspace_root.join(requested)
    };
    let canonical = std::fs::canonicalize(&joined).map_err(|error| {
        BridgeError::new(
            ErrorCode::TaskReadFailed,
            format!("task_file cannot be resolved: {error}"),
        )
    })?;
    if !canonical.starts_with(workspace_root) {
        return Err(BridgeError::new(
            ErrorCode::PathOutsideRoot,
            "task_file escapes the workspace root",
        ));
    }
    #[cfg(windows)]
    let expected_identity = same_file::Handle::from_path(&canonical).map_err(|error| {
        BridgeError::new(
            ErrorCode::TaskReadFailed,
            format!("task_file identity: {error}"),
        )
    })?;
    let metadata = {
        #[cfg(windows)]
        {
            expected_identity.as_file().metadata()
        }
        #[cfg(not(windows))]
        {
            std::fs::metadata(&canonical)
        }
    }
    .map_err(|error| {
        BridgeError::new(
            ErrorCode::TaskReadFailed,
            format!("task_file metadata: {error}"),
        )
    })?;
    if !metadata.is_file() {
        return Err(BridgeError::new(
            ErrorCode::TaskReadFailed,
            "task_file is not a regular file",
        ));
    }
    if metadata.len() > max_bytes as u64 {
        return Err(BridgeError::new(
            ErrorCode::TaskReadFailed,
            "task_file exceeds max_prompt_bytes",
        ));
    }
    // Open first, then compare the opened file's identity with the metadata
    // that was validated above. A path swap between the check and the read
    // therefore fails instead of freezing bytes from another file.
    let file = open_task_file(&canonical).map_err(|error| {
        BridgeError::new(
            ErrorCode::TaskReadFailed,
            format!("task_file open: {error}"),
        )
    })?;
    let opened = file.metadata().map_err(|error| {
        BridgeError::new(
            ErrorCode::TaskReadFailed,
            format!("task_file metadata: {error}"),
        )
    })?;
    #[cfg(windows)]
    let identity_matches = same_file::Handle::from_file(file.try_clone().map_err(|error| {
        BridgeError::new(
            ErrorCode::TaskReadFailed,
            format!("task_file clone: {error}"),
        )
    })?)
    .map_err(|error| {
        BridgeError::new(
            ErrorCode::TaskReadFailed,
            format!("opened task_file identity: {error}"),
        )
    })? == expected_identity;
    #[cfg(not(windows))]
    let identity_matches = same_identity(&metadata, &opened);
    if !opened.is_file() || !identity_matches {
        return Err(BridgeError::new(
            ErrorCode::TaskReadFailed,
            "task_file changed while it was being opened",
        ));
    }

    // Bound the read itself; the file can grow after the metadata check.
    let mut bytes = Vec::new();
    file.take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            BridgeError::new(
                ErrorCode::TaskReadFailed,
                format!("task_file read: {error}"),
            )
        })?;
    if bytes.len() > max_bytes {
        return Err(BridgeError::new(
            ErrorCode::TaskReadFailed,
            "task_file exceeds max_prompt_bytes",
        ));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_task_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    // O_NOFOLLOW rejects a final-component symlink; O_NONBLOCK prevents a
    // replaced FIFO from blocking the open. The type check rejects it after.
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

#[cfg(not(unix))]
fn open_task_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}

#[cfg(unix)]
fn same_identity(before: &std::fs::Metadata, opened: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    before.dev() == opened.dev() && before.ino() == opened.ino()
}

#[cfg(not(any(unix, windows)))]
fn same_identity(before: &std::fs::Metadata, opened: &std::fs::Metadata) -> bool {
    before.len() == opened.len()
}

/// RFC3339 timestamp string used by results, reports and ledger receipts.
pub fn timestamp(now: OffsetDateTime) -> String {
    now.format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
