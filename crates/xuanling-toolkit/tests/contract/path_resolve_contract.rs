//! `path_resolve` / `path_relative` contract (plan §4.1, §7.1, §10 W1).
//!
//! Pins the resolution-context semantics: base_dir is a resolution context
//! only (not a sandbox/trust root), absolute paths pass through, parent
//! traversal is allowed, and relative results use `/`.

use std::path::PathBuf;

use xuanling_toolkit::path::{PathRelativeRequest, PathResolveRequest, relative, resolve};
use xuanling_toolkit::{InvocationContext, PathContext};

fn ctx() -> InvocationContext {
    InvocationContext::new(PathContext::new(PathBuf::from("/srv/app")))
}

#[test]
fn relative_path_uses_base_dir_only_as_resolution_context() {
    // A relative path resolves against the request's base_dir, not the server
    // startup directory. base_dir is purely a resolution context.
    let req = PathResolveRequest {
        path: "config.toml".to_string(),
        base_dir: Some("/opt/conf".to_string()),
        canonicalize: false,
    };
    let res = resolve(&ctx(), &req).expect("resolve");
    assert!(
        res.path.ends_with("config.toml"),
        "path missing the requested component: {}",
        res.path
    );
    // The absolute form must be anchored under the request base, not the ctx.
    let abs = res
        .absolute_path
        .as_deref()
        .expect("absolute_path populated for non-canonicalize");
    assert!(
        abs.contains("opt/conf") || abs.contains("opt\\conf"),
        "absolute_path should be anchored under request base_dir; got {abs}"
    );
}

#[test]
fn parent_components_may_resolve_above_base_dir() {
    // `..` above base must not be rejected. PathContext has no containment.
    let req = PathResolveRequest {
        path: "../../elsewhere".to_string(),
        base_dir: Some("/srv/app/sub".to_string()),
        canonicalize: false,
    };
    let res = resolve(&ctx(), &req).expect("resolve");
    // Lexical normalization collapses the `..`: /srv/app/sub/../../elsewhere
    // -> /srv/elsewhere.
    let abs = res
        .absolute_path
        .as_deref()
        .expect("absolute_path populated");
    assert!(
        abs.ends_with("elsewhere") && !abs.contains(".."),
        "parent traversal should normalize without `..` in the absolute form; got {abs}"
    );
}

#[test]
fn absolute_paths_are_not_rewritten_relative() {
    // An absolute path passes through unchanged (canonicalize=false).
    let abs_in = if cfg!(target_os = "windows") {
        "C:\\Windows\\System32"
    } else {
        "/etc/hosts"
    };
    let req = PathResolveRequest {
        path: abs_in.to_string(),
        base_dir: Some("/srv/app".to_string()),
        canonicalize: false,
    };
    let res = resolve(&ctx(), &req).expect("resolve");
    assert_eq!(res.path, abs_in, "absolute path must not be rewritten");
    assert_eq!(res.absolute_path.as_deref(), Some(abs_in));
}

#[test]
fn portable_relative_paths_use_forward_slash_in_results() {
    // path_relative result uses `/` as separator on all platforms.
    let req = PathRelativeRequest {
        path: "src/main.rs".to_string(),
        base_dir: ".".to_string(),
    };
    let res = relative(&ctx(), &req).expect("relative");
    assert!(
        !res.relative_path.contains('\\'),
        "relative result must use `/`, got: {}",
        res.relative_path
    );
    assert!(
        res.relative_path.ends_with("src/main.rs"),
        "unexpected relative path: {}",
        res.relative_path
    );
}

#[test]
fn unknown_request_fields_are_rejected() {
    // A misspelled field must be rejected, not silently ignored (plan §6). The
    // DTO sets `#[serde(deny_unknown_fields)]` so this holds directly.
    let bad = serde_json::json!({
        "path": "config.toml",
        "base_dir": "/opt/conf",
        "canonicalize": false,
        "misspelled_field": true
    });
    let req: Result<PathResolveRequest, _> = serde_json::from_value(bad);
    assert!(
        req.is_err(),
        "PathResolveRequest must reject unknown fields (deny_unknown_fields); got Ok"
    );
}

#[test]
fn windows_drive_and_unc_fixtures_round_trip_on_windows() {
    // Plan §11: drive absolute + UNC are a "real test" on Windows and a
    // "fixture only" off-Windows. On non-Windows we assert a POSIX absolute
    // path round-trips (the platform-relevant analog), and the Windows path
    // forms are skipped with a clear reason. On Windows we assert the drive
    // and UNC forms pass through unchanged.
    let ctx = InvocationContext::new(PathContext::new(PathBuf::from("C:\\")));

    if cfg!(target_os = "windows") {
        // Drive absolute round-trip.
        let req = PathResolveRequest {
            path: "C:\\Users\\test\\file.txt".to_string(),
            base_dir: None,
            canonicalize: false,
        };
        let res = resolve(&ctx, &req).expect("resolve drive path");
        assert_eq!(res.path, "C:\\Users\\test\\file.txt");

        // UNC path round-trip.
        let req = PathResolveRequest {
            path: "\\\\server\\share\\file.txt".to_string(),
            base_dir: None,
            canonicalize: false,
        };
        let res = resolve(&ctx, &req).expect("resolve UNC path");
        assert_eq!(res.path, "\\\\server\\share\\file.txt");
    } else {
        // POSIX absolute round-trip (the platform-relevant analog).
        let req = PathResolveRequest {
            path: "/etc/hosts".to_string(),
            base_dir: None,
            canonicalize: false,
        };
        let res = resolve(&ctx, &req).expect("resolve posix path");
        assert_eq!(res.path, "/etc/hosts");
        assert_eq!(res.absolute_path.as_deref(), Some("/etc/hosts"));
        // Windows drive/UNC path forms are not native on this platform; they
        // are covered by the fixture snapshot in W7. No skip needed — the POSIX
        // assertion is the real test here.
    }
}
