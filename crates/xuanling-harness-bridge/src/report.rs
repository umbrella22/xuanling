//! Optional atomic Markdown result publication.
//!
//! `save_result=false` performs no task-related write. When enabled, the bridge
//! writes one temporary file after the terminal result exists, syncs it, and
//! publishes `job_id.md` without replacing an existing file. The body is worker
//! output data; the bridge never parses it as instructions.

use std::io::Write;
use std::path::PathBuf;

use cap_std::fs::{Dir, OpenOptions};
use same_file::Handle;
use uuid::Uuid;

use crate::error::{BridgeError, ErrorCode};
use crate::jobs::{Cleanup, ResultError, TerminalStatus};

/// A result root bound to the directory opened during configuration. All
/// publication operations are relative to this handle, never a re-resolved
/// ambient path. The path is retained only for identity checks and delivery.
pub struct ReportDirectory {
    path: PathBuf,
    directory: Dir,
    identity: Handle,
}

impl ReportDirectory {
    pub fn open(path: PathBuf) -> Result<Self, BridgeError> {
        let directory = Dir::open_ambient_dir(&path, cap_std::ambient_authority())
            .map_err(|error| report_error(format!("open results_dir: {error}")))?;
        let identity = Handle::from_file(
            directory
                .try_clone()
                .map_err(|error| report_error(format!("clone results_dir: {error}")))?
                .into_std_file(),
        )
        .map_err(|error| report_error(format!("identify results_dir: {error}")))?;
        let root = Self {
            path,
            directory,
            identity,
        };
        root.validate_identity()?;
        Ok(root)
    }

    fn validate_identity(&self) -> Result<(), BridgeError> {
        let canonical = std::fs::canonicalize(&self.path)
            .map_err(|error| report_error(format!("results_dir cannot be resolved: {error}")))?;
        if canonical != self.path {
            return Err(report_error("results_dir path was redirected"));
        }
        let current = Dir::open_ambient_dir(&self.path, cap_std::ambient_authority())
            .and_then(|directory| Handle::from_file(directory.into_std_file()))
            .map_err(|error| report_error(format!("identify current results_dir: {error}")))?;
        if current != self.identity {
            return Err(report_error("results_dir identity changed"));
        }
        Ok(())
    }
}

/// Data needed to render one final result file.
pub struct ReportInput<'a> {
    pub job_id: &'a str,
    pub harness: &'a str,
    pub adapter_version: &'a str,
    pub status: TerminalStatus,
    pub started_at: &'a str,
    pub finished_at: &'a str,
    pub exit_code: Option<i32>,
    pub output_complete: bool,
    pub redacted: bool,
    pub cleanup: &'a Cleanup,
    pub final_output: Option<&'a str>,
    pub error: Option<&'a ResultError>,
    pub delivery_error: Option<&'a ResultError>,
}

/// Publish one final Markdown file and return its path.
pub fn publish(root: &ReportDirectory, input: &ReportInput<'_>) -> Result<PathBuf, BridgeError> {
    validate_job_id(input.job_id)?;
    root.validate_identity()?;

    let final_name = format!("{}.md", input.job_id);
    let temp_name = format!(".{}.{}.tmp", input.job_id, Uuid::new_v4());

    let body = render(input);
    let write_result = (|| -> std::io::Result<()> {
        let mut file = root
            .directory
            .open_with(&temp_name, OpenOptions::new().write(true).create_new(true))?;
        file.write_all(body.as_bytes())?;
        file.flush()?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = root.directory.remove_file(&temp_name);
        return Err(report_error(format!("report write failed: {error}")));
    }

    if let Err(error) = root.validate_identity() {
        let _ = root.directory.remove_file(&temp_name);
        return Err(error);
    }

    // `hard_link` is an atomic, non-overwriting publish on the supported
    // filesystems. A pre-existing path (a user file or a concurrent report)
    // stays untouched and the job reports a write failure instead.
    if let Err(error) = root
        .directory
        .hard_link(&temp_name, &root.directory, &final_name)
    {
        let _ = root.directory.remove_file(&temp_name);
        return Err(report_error(format!("report publish failed: {error}")));
    }
    let _ = root.directory.remove_file(&temp_name);

    #[cfg(unix)]
    {
        // Directory sync is best effort: the file is already visible, and a
        // platform without directory fsync must not turn a published report
        // into a reported failure.
        if let Ok(directory) = root.directory.try_clone() {
            let _ = directory.into_std_file().sync_all();
        }
    }

    if let Err(error) = root.validate_identity() {
        let _ = root.directory.remove_file(&final_name);
        return Err(error);
    }
    Ok(root.path.join(final_name))
}

fn validate_job_id(job_id: &str) -> Result<(), BridgeError> {
    let valid = !job_id.is_empty()
        && job_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'));
    if valid {
        Ok(())
    } else {
        Err(report_error("job_id is not a safe file name"))
    }
}

fn report_error(message: impl Into<String>) -> BridgeError {
    BridgeError::new(ErrorCode::ReportWriteFailed, message)
}

/// Keep configured/derived metadata on one header line; the values are trusted,
/// but a newline must never be able to invent extra header fields.
fn single_line(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

fn render(input: &ReportInput<'_>) -> String {
    let exit_code = input
        .exit_code
        .map_or_else(|| "null".to_string(), |code| code.to_string());
    let job_id = single_line(input.job_id);
    let harness = single_line(input.harness);
    let adapter_version = single_line(input.adapter_version);
    let started_at = single_line(input.started_at);
    let finished_at = single_line(input.finished_at);
    let mut text = format!(
        "---
format_version: 1
job_id: {}
harness: {}
adapter_version: {}
status: {}
started_at: {}
finished_at: {}
exit_code: {}
output_complete: {}
redacted: {}
cleanup_confirmed: {}
report_is_data: true
---

## Worker final answer

",
        job_id,
        harness,
        adapter_version,
        input.status.as_str(),
        started_at,
        finished_at,
        exit_code,
        input.output_complete,
        input.redacted,
        input.cleanup.confirmed,
    );
    match input.final_output {
        Some(output) => {
            text.push_str(output);
            if !text.ends_with('\n') {
                text.push('\n');
            }
        }
        None => text.push_str("(no final answer was produced)\n"),
    }
    if let Some(error) = input.error {
        text.push_str(&format!(
            "\n## Failure diagnostic\n\n{}: {}\n",
            error.code, error.message
        ));
    }
    if let Some(delivery) = input.delivery_error {
        text.push_str(&format!(
            "\n## Delivery diagnostic\n\n{}: {}\n",
            delivery.code, delivery.message
        ));
    }
    text
}
