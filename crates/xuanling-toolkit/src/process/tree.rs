//! Cross-platform descendant containment for spawned tool processes.
//!
//! Unix uses an isolated process group. Windows assigns the direct child to a
//! Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, which makes
//! descendant containment recursive at the OS boundary.

use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::process::{Child, Command};

/// Configure a command before spawn so its descendants can be contained.
pub(crate) fn configure(command: &mut Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
        // The child must not execute before it belongs to the Job Object; an
        // unsuspended child can create a descendant in the spawn/assign gap.
        command.creation_flags(CREATE_SUSPENDED);
    }
}

/// An OS-owned process tree. Clones refer to the same containment object.
#[derive(Clone, Debug)]
pub(crate) struct ProcessTree {
    key: u64,
    id: i64,
    #[cfg(unix)]
    process_group: libc::pid_t,
    #[cfg(windows)]
    job: std::sync::Arc<JobHandle>,
}

impl ProcessTree {
    /// Attach a freshly spawned direct child to a descendant-containment unit.
    pub(crate) fn attach(child: &Child) -> io::Result<Self> {
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("spawned process id unavailable"))?;

        #[cfg(unix)]
        {
            let process_group = libc::pid_t::try_from(pid)
                .map_err(|_| io::Error::other("spawned process id exceeds pid_t"))?;
            Ok(Self {
                key: next_key(),
                id: i64::from(process_group),
                process_group,
            })
        }

        #[cfg(windows)]
        {
            let raw_process = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("spawned process handle unavailable"))?;
            let job = JobHandle::create_assign_and_resume(raw_process.cast(), pid)?;
            Ok(Self {
                key: next_key(),
                id: i64::from(pid),
                job: std::sync::Arc::new(job),
            })
        }

        #[cfg(not(any(unix, windows)))]
        {
            Ok(Self {
                key: next_key(),
                id: i64::from(pid),
            })
        }
    }

    pub(crate) fn key(&self) -> u64 {
        self.key
    }

    pub(crate) fn id(&self) -> i64 {
        self.id
    }

    /// Terminate the complete contained tree. Already-exited trees are success.
    pub(crate) fn terminate(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            // SAFETY: `configure` created an isolated process group whose PGID
            // is the direct child's PID. A negative PID targets only that group.
            let rc = unsafe { libc::kill(-self.process_group, libc::SIGKILL) };
            if rc == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(error)
            }
        }

        #[cfg(windows)]
        {
            self.job.terminate()
        }

        #[cfg(not(any(unix, windows)))]
        {
            Ok(())
        }
    }
}

/// Owning cleanup responsibility for one [`ProcessTree`].
///
/// `ProcessTree` itself stays cloneable so registries and close operations can
/// refer to the same OS containment unit. Exactly one invocation-local guard
/// owns the fallback cleanup responsibility and is disarmed only after the
/// child and all of its I/O workers have settled.
#[derive(Debug)]
pub(crate) struct ProcessTreeGuard {
    process_tree: Option<ProcessTree>,
}

impl ProcessTreeGuard {
    pub(crate) fn new(process_tree: ProcessTree) -> Self {
        Self {
            process_tree: Some(process_tree),
        }
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        self.process_tree
            .as_ref()
            .map_or(Ok(()), ProcessTree::terminate)
    }

    pub(crate) fn disarm(&mut self) {
        self.process_tree = None;
    }
}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        if let Some(process_tree) = &self.process_tree {
            let _ = process_tree.terminate();
        }
    }
}

/// A Tokio worker that cannot silently detach when its owner future is
/// dropped. `JoinHandle` normally detaches on drop; process I/O workers must be
/// aborted instead so pipe handles, artifact staging files, and quota leases do
/// not outlive the tool invocation.
#[derive(Debug)]
pub(crate) struct AbortOnDrop<T> {
    handle: tokio::task::JoinHandle<T>,
}

impl<T> AbortOnDrop<T> {
    pub(crate) fn spawn<F>(future: F) -> Self
    where
        F: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        Self {
            handle: tokio::spawn(future),
        }
    }

    pub(crate) fn abort(&self) {
        self.handle.abort();
    }

    pub(crate) async fn join(mut self) -> Result<T, tokio::task::JoinError> {
        (&mut self.handle).await
    }
}

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

fn next_key() -> u64 {
    static NEXT_KEY: AtomicU64 = AtomicU64::new(1);
    NEXT_KEY.fetch_add(1, Ordering::Relaxed)
}

#[cfg(windows)]
#[derive(Debug)]
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl JobHandle {
    fn create_assign_and_resume(
        process: windows_sys::Win32::Foundation::HANDLE,
        process_id: u32,
    ) -> io::Result<Self> {
        use std::mem::size_of;
        use std::ptr::null;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };

        // SAFETY: null security/name requests a private unnamed job. The handle
        // is checked and owned by `JobHandle` from this point onward.
        let raw = unsafe { CreateJobObjectW(null(), null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(raw);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `info` has the exact structure and byte size requested by the
        // JobObjectExtendedLimitInformation information class.
        let configured = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: both handles are live kernel handles. Assignment is performed
        // immediately after spawn; descendants created afterwards inherit job
        // membership unless they use an explicitly allowed breakaway policy.
        let assigned = unsafe { AssignProcessToJobObject(job.0, process) };
        if assigned == 0 {
            return Err(io::Error::last_os_error());
        }
        resume_process_threads(process_id)?;
        Ok(job)
    }

    fn terminate(&self) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        // SAFETY: `self.0` remains owned and live for this call.
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
fn resume_process_threads(process_id: u32) -> io::Result<()> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: `OwnedHandle` is created only from a checked, live handle
            // and owns exactly one CloseHandle call.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    // SAFETY: the flags and process id are plain values. The returned snapshot
    // handle is checked against the API's sentinel and then RAII-owned.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let snapshot = OwnedHandle(snapshot);
    let mut entry = THREADENTRY32 {
        dwSize: u32::try_from(size_of::<THREADENTRY32>())
            .map_err(|_| io::Error::other("THREADENTRY32 size exceeds u32"))?,
        ..Default::default()
    };
    // SAFETY: `snapshot` is a live ToolHelp snapshot and `entry` points to a
    // correctly sized writable THREADENTRY32.
    if unsafe { Thread32First(snapshot.0, &mut entry) } == 0 {
        return Err(io::Error::last_os_error());
    }

    let mut resumed = 0_u32;
    loop {
        if entry.th32OwnerProcessID == process_id {
            // SAFETY: the thread id came from the live snapshot. The returned
            // handle is checked before it is wrapped and closed exactly once.
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            let thread = OwnedHandle(thread);
            // SAFETY: this handle grants THREAD_SUSPEND_RESUME and remains live
            // for the call. u32::MAX is the documented failure sentinel.
            if unsafe { ResumeThread(thread.0) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            resumed = resumed.saturating_add(1);
        }

        // SAFETY: the snapshot and writable entry remain live for iteration.
        if unsafe { Thread32Next(snapshot.0, &mut entry) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                break;
            }
            return Err(error);
        }
    }
    if resumed == 0 {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "spawned process has no resumable thread",
        ));
    }
    Ok(())
}

#[cfg(windows)]
// SAFETY: Windows kernel handles may be used from any thread. `JobHandle`
// contains only an owned HANDLE; shared access never mutates Rust memory.
unsafe impl Send for JobHandle {}
#[cfg(windows)]
// SAFETY: `TerminateJobObject` and `CloseHandle` accept process-wide HANDLE
// values. Arc serializes the sole Drop while concurrent terminate calls are
// supported by the OS API and do not alias Rust-managed data.
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        // SAFETY: this is the sole owner of the valid job handle.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
