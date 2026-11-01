//! Process-tree cleanup confirmation.
//!
//! Sending a termination signal and observing that the descendants are gone are
//! two different facts. The bridge reports `cleanup.confirmed` only after the
//! OS containment unit reports no live process.

use std::time::{Duration, Instant};

use xuanling_toolkit::process::containment::ProcessTree;

pub const CLEANUP_POLL: Duration = Duration::from_millis(20);
pub const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
/// Upper bound for draining worker pipes after the direct child exits.
pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Terminate the tree and poll until no contained process remains.
pub async fn terminate_and_confirm(tree: &ProcessTree) -> bool {
    let _ = tree.terminate();
    confirm(tree).await
}

/// Poll an already-terminated tree.
pub async fn confirm(tree: &ProcessTree) -> bool {
    let deadline = Instant::now() + CLEANUP_TIMEOUT;
    loop {
        if matches!(tree.is_alive(), Ok(false)) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(CLEANUP_POLL).await;
    }
}
