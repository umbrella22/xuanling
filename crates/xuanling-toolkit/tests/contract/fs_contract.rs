//! Filesystem contract red tests (plan §7.2, §10 W0/W2).
//!
//! These pin the "no hidden truncation / no hidden cap" invariants. In W0 the
//! `fs_read_text`/`fs_search` operations return `Unsupported` (behavior not yet
//! implemented), so these tests FAIL — the failure points at the missing
//! behavior, not at a fixture/build error. W2 makes them green by returning
//! the complete content / all matches.

use xuanling_toolkit::fs::{FsReadTextRequest, FsSearchRequest};
use xuanling_toolkit::{InvocationContext, PathContext, fs};

fn ctx() -> InvocationContext {
    InvocationContext::new(PathContext::new(std::path::PathBuf::from(".")))
}

#[test]
fn fs_read_text_without_range_returns_complete_file() {
    // Write a fixture larger than any plausible default cap.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("big.txt");
    let body = "line\n".repeat(10_000);
    std::fs::write(&path, &body).expect("write fixture");

    let req = FsReadTextRequest {
        path: path.to_string_lossy().into_owned(),
        base_dir: None,
        start_line: None,
        end_line: None,
        include_sha256: false,
        max_bytes: None,
        resume: None,
    };
    let result = fs::read_text(&ctx(), &req).expect("fs_read_text should succeed (W2)");

    // No range was requested, so the FULL content must come back — not a
    // silently truncated prefix.
    assert_eq!(
        result.content, body,
        "content must not be silently truncated"
    );
    assert_eq!(result.total_lines, 10_000);
}

#[test]
fn fs_search_without_limit_returns_all_matches() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("haystack.txt");
    // 500 matches; well above any plausible hidden cap.
    let body = "target\n".repeat(500);
    std::fs::write(&path, &body).expect("write fixture");

    let req = FsSearchRequest {
        path: path.to_string_lossy().into_owned(),
        pattern: "target".to_string(),
        literal: true,
        case_sensitive: true,
        limit: None,
        cursor: None,
        max_output_bytes: None,
    };
    let result = fs::search(&ctx(), &req).expect("fs_search should succeed (W2)");

    // No limit requested -> ALL 500 matches returned, no hidden cap.
    assert_eq!(
        result.matches.len(),
        500,
        "search must return every match when limit is absent"
    );
}
