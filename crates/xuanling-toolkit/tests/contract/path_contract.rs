//! Path resolution contract (plan §4.1, §10 W0/W1).
//!
//! The toolkit's `PathContext` is a resolution context, NOT a sandbox/trust
//! root. Absolute paths outside `base_dir` and parent-traversal (`..`) must be
//! resolved, never rejected as "escape". This guard prevents the legacy
//! workspace-root containment semantics from leaking back in.

use std::path::{Path, PathBuf};

use xuanling_toolkit::PathContext;

#[test]
fn absolute_path_outside_server_base_is_not_rejected_as_escape() {
    let ctx = PathContext::new(PathBuf::from("/srv/app"));
    // An absolute path that is clearly outside base_dir must still resolve.
    let outside = Path::new("/etc/hosts");
    let resolved = ctx.resolve(outside, None);
    assert_eq!(
        resolved, outside,
        "absolute paths must pass through unchanged"
    );
}

#[test]
fn parent_components_may_resolve_above_base_dir() {
    // ../.. above base must not error or be clamped — PathContext has no
    // containment. This is a W1 red test; W0's PathContext already lacks
    // containment, so it passes and pins the invariant early.
    let ctx = PathContext::new(PathBuf::from("/srv/app/sub"));
    let resolved = ctx.resolve(Path::new("../../elsewhere"), None);
    // Standard OS join semantics: /srv/app/sub/../../elsewhere
    assert_eq!(resolved, PathBuf::from("/srv/app/sub/../../elsewhere"));
}

#[test]
fn per_request_base_dir_overrides_context_base() {
    let ctx = PathContext::new(PathBuf::from("/srv/app"));
    let resolved = ctx.resolve(Path::new("config.toml"), Some(Path::new("/opt/conf")));
    assert_eq!(resolved, PathBuf::from("/opt/conf/config.toml"));
}
