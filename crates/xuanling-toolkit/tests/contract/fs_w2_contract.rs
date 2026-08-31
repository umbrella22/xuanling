//! W2 filesystem red/green tests (plan §10 W2).
//!
//! These pin the W2 filesystem semantics: no hidden truncation, no hidden
//! cap, strict range/limit semantics, distinct regex vs literal search, stable
//! newline detection, atomic writes with optimistic-concurrency guards,
//! explicit cross-device fallback, recursive-removal guard, absolute-target
//! writes outside base_dir, symlink loop safety, and cancellation.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Barrier;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use xuanling_toolkit::fs::{
    self, FsEditRequest, FsReadBytesRequest, FsReadTextRequest, FsRemoveRequest,
    FsReplaceTextRequest, FsSearchOptions, FsSearchRequest, FsWriteTextRequest, NewlineMode,
    WriteMode,
};
use xuanling_toolkit::invocation::{Cancellation, InvocationContext, ManualCancellation};
use xuanling_toolkit::{PathContext, ToolErrorCode};

fn ctx(base: &str) -> InvocationContext {
    InvocationContext::new(PathContext::new(PathBuf::from(base)))
}

fn strip_numbered_projection(display: &str) -> String {
    display
        .split_inclusive('\n')
        .map(|segment| {
            segment
                .split_once('\t')
                .unwrap_or_else(|| panic!("numbered segment lacks a tab prefix: {segment:?}"))
                .1
        })
        .collect()
}

#[test]
fn read_text_numbered_matches_cat_n_with_absolute_lines() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("numbered.txt");
    std::fs::write(&path, "alpha\n你好\nomega").unwrap();
    let request: FsReadTextRequest = serde_json::from_value(serde_json::json!({
        "path": path,
        "format": "numbered"
    }))
    .expect("v3 accepts the numbered format selector");

    let result = fs::read_text(&ctx("."), &request).expect("numbered read");
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(
        value["content"],
        serde_json::json!("     1\talpha\n     2\t你好\n     3\tomega")
    );
    assert_eq!(value["total_lines"], serde_json::json!(3));
}

#[test]
fn numbered_resume_offsets_stay_in_raw_source_byte_space() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("numbered-window.txt");
    let body = "alpha\n你好世界 and a long continuation\nomega\n";
    std::fs::write(&path, body).unwrap();
    let budget = 18_u64;
    let mut resume = serde_json::Value::Null;
    let mut reassembled = String::new();

    for guard in 0..100 {
        let mut request = serde_json::json!({
            "path": path,
            "format": "numbered",
            "max_bytes": budget
        });
        if !resume.is_null() {
            request["resume"] = resume.clone();
        }
        let request: FsReadTextRequest =
            serde_json::from_value(request).expect("v3 numbered bounded request must decode");
        let result = fs::read_text(&ctx("."), &request).expect("numbered bounded read");
        let value = serde_json::to_value(result).unwrap();
        let display = value["content"].as_str().expect("numbered content");
        assert!(
            display.len() as u64 <= budget,
            "rendered bytes must obey the model-visible budget: {display:?}"
        );
        let raw = strip_numbered_projection(display);
        assert_eq!(
            value["returned_source_bytes"],
            serde_json::json!(raw.len() as u64)
        );
        reassembled.push_str(&raw);

        if value["truncated"] == serde_json::json!(false) {
            assert_eq!(reassembled, body);
            return;
        }
        resume = value["next_resume"].clone();
        assert_eq!(
            resume["offset_bytes"],
            serde_json::json!(reassembled.len() as u64),
            "resume offset is raw source bytes, not rendered bytes"
        );
        assert!(guard < 99, "resume chain did not terminate");
    }
    unreachable!("loop returns after the terminal window")
}

#[test]
fn numbered_line_range_resume_uses_absolute_source_offsets_and_lines() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("numbered-range.txt");
    let body = "zero\nalpha\n你好世界\nomega\n";
    let selected = "alpha\n你好世界\n";
    std::fs::write(&path, body).unwrap();
    let range_start = "zero\n".len() as u64;
    let range_end = range_start + selected.len() as u64;
    let mut resume = serde_json::Value::Null;
    let mut reassembled = String::new();
    let mut displayed_lines = Vec::new();

    for guard in 0..100 {
        let mut request = serde_json::json!({
            "path": path,
            "start_line": 2,
            "end_line": 3,
            "format": "numbered",
            "max_bytes": 15
        });
        if !resume.is_null() {
            request["resume"] = resume.clone();
        }
        let request: FsReadTextRequest =
            serde_json::from_value(request).expect("numbered line-range request must decode");
        let value = serde_json::to_value(
            fs::read_text(&ctx("."), &request).expect("numbered line-range read"),
        )
        .unwrap();
        let display = value["content"].as_str().expect("numbered content");
        displayed_lines.push(display[..6].trim().parse::<u64>().unwrap());
        let raw = strip_numbered_projection(display);
        reassembled.push_str(&raw);

        assert_eq!(value["range_start_bytes"], serde_json::json!(range_start));
        assert_eq!(value["range_end_bytes"], serde_json::json!(range_end));
        assert_eq!(value["start_line"], serde_json::json!(2));
        assert_eq!(value["end_line"], serde_json::json!(3));

        if value["truncated"] == serde_json::json!(false) {
            assert_eq!(reassembled, selected);
            assert_eq!(displayed_lines.first(), Some(&2));
            assert!(displayed_lines.contains(&3));
            return;
        }
        resume = value["next_resume"].clone();
        assert_eq!(
            resume["offset_bytes"],
            serde_json::json!(range_start + reassembled.len() as u64),
            "line-range resume offset must stay absolute in the whole-file byte space"
        );
        assert_eq!(resume["line_range"]["start_line"], serde_json::json!(2));
        assert_eq!(resume["line_range"]["end_line"], serde_json::json!(3));
        assert!(guard < 99, "line-range resume chain did not terminate");
    }
    unreachable!("loop returns after the terminal window")
}

#[test]
fn conditional_text_read_returns_metadata_without_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("conditional.txt");
    let body = "first\nsecond\n";
    std::fs::write(&path, body).unwrap();
    let sha256 = fs::sha256_hex(body.as_bytes());
    let request: FsReadTextRequest = serde_json::from_value(serde_json::json!({
        "path": path,
        "known_sha256": sha256
    }))
    .expect("v3 accepts known_sha256 for text");

    let value = serde_json::to_value(fs::read_text(&ctx("."), &request).unwrap()).unwrap();
    assert_eq!(value["not_modified"], serde_json::json!(true));
    assert_eq!(value["sha256"], serde_json::json!(sha256));
    assert_eq!(value["total_lines"], serde_json::json!(2));
    assert!(
        value.get("content").is_none(),
        "an unchanged conditional read must not repeat content: {value}"
    );
}

#[test]
fn conditional_byte_read_returns_metadata_without_base64() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("conditional.bin");
    let body = b"\x00\x01\x02xuanling\xff";
    std::fs::write(&path, body).unwrap();
    let sha256 = fs::sha256_hex(body);
    let request: FsReadBytesRequest = serde_json::from_value(serde_json::json!({
        "path": path,
        "known_sha256": sha256
    }))
    .expect("v3 accepts known_sha256 for bytes");

    let value = serde_json::to_value(fs::read_bytes(&ctx("."), &request).unwrap()).unwrap();
    assert_eq!(value["not_modified"], serde_json::json!(true));
    assert_eq!(value["sha256"], serde_json::json!(sha256));
    assert_eq!(value["total_bytes"], serde_json::json!(body.len()));
    assert!(
        value.get("base64").is_none(),
        "an unchanged conditional read must not repeat base64: {value}"
    );
}

#[test]
fn conditional_hash_miss_returns_new_body_and_hash() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changed.txt");
    let old_sha = fs::sha256_hex(b"old\n");
    std::fs::write(&path, "new\n").unwrap();
    let request: FsReadTextRequest = serde_json::from_value(serde_json::json!({
        "path": path,
        "known_sha256": old_sha
    }))
    .expect("v3 accepts known_sha256");

    let value = serde_json::to_value(fs::read_text(&ctx("."), &request).unwrap()).unwrap();
    assert_eq!(value["not_modified"], serde_json::json!(false));
    assert_eq!(value["content"], serde_json::json!("new\n"));
    assert_eq!(value["sha256"], serde_json::json!(fs::sha256_hex(b"new\n")));
}

#[test]
fn conditional_byte_hash_miss_returns_new_body_and_hash() {
    use base64::Engine;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changed.bin");
    let old_sha = fs::sha256_hex(b"old");
    let new_body = b"new\0bytes";
    std::fs::write(&path, new_body).unwrap();
    let request: FsReadBytesRequest = serde_json::from_value(serde_json::json!({
        "path": path,
        "known_sha256": old_sha
    }))
    .expect("v3 accepts known_sha256 for bytes");

    let value = serde_json::to_value(fs::read_bytes(&ctx("."), &request).unwrap()).unwrap();
    assert_eq!(value["not_modified"], serde_json::json!(false));
    assert_eq!(value["sha256"], serde_json::json!(fs::sha256_hex(new_body)));
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value["base64"].as_str().expect("changed byte body"))
        .unwrap();
    assert_eq!(decoded, new_body);
}

#[test]
fn conditional_reads_validate_sha_and_report_empty_file_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty");
    std::fs::write(&path, []).unwrap();

    for read_bytes in [false, true] {
        let invalid = if read_bytes {
            let request: FsReadBytesRequest = serde_json::from_value(serde_json::json!({
                "path": path,
                "known_sha256": "not-a-sha"
            }))
            .unwrap();
            fs::read_bytes(&ctx("."), &request).unwrap_err()
        } else {
            let request: FsReadTextRequest = serde_json::from_value(serde_json::json!({
                "path": path,
                "known_sha256": "not-a-sha"
            }))
            .unwrap();
            fs::read_text(&ctx("."), &request).unwrap_err()
        };
        assert_eq!(invalid.code, ToolErrorCode::InvalidInput);
        assert_eq!(
            invalid.details["reason"].as_str(),
            Some("known_sha256_invalid")
        );
    }

    let empty_sha = fs::sha256_hex(&[]);
    let text_request: FsReadTextRequest = serde_json::from_value(serde_json::json!({
        "path": path,
        "known_sha256": empty_sha
    }))
    .unwrap();
    let text = serde_json::to_value(fs::read_text(&ctx("."), &text_request).unwrap()).unwrap();
    assert_eq!(text["not_modified"], serde_json::json!(true));
    assert_eq!(text["total_lines"], serde_json::json!(0));
    assert_eq!(text["total_bytes"], serde_json::json!(0));
    assert!(text.get("content").is_none());

    let bytes_request: FsReadBytesRequest = serde_json::from_value(serde_json::json!({
        "path": path,
        "known_sha256": empty_sha
    }))
    .unwrap();
    let bytes = serde_json::to_value(fs::read_bytes(&ctx("."), &bytes_request).unwrap()).unwrap();
    assert_eq!(bytes["not_modified"], serde_json::json!(true));
    assert_eq!(bytes["total_bytes"], serde_json::json!(0));
    assert!(bytes.get("base64").is_none());
}

#[test]
fn edit_can_omit_diff_without_losing_integrity_facts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("edit-no-diff.txt");
    std::fs::write(&path, "before\n").unwrap();
    let request: FsEditRequest = serde_json::from_value(serde_json::json!({
        "path": path,
        "old": "before",
        "new": "after",
        "include_diff": false
    }))
    .expect("v3 accepts include_diff");

    let value = serde_json::to_value(fs::fs_edit(&ctx("."), &request).unwrap()).unwrap();
    assert!(
        value.get("diff").is_none(),
        "diff=false must omit wire diff"
    );
    assert_eq!(value["replacements"], serde_json::json!(1));
    assert!(value["before_sha256"].as_str().is_some());
    assert!(value["after_sha256"].as_str().is_some());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "after\n");
}

#[test]
fn edit_diff_projection_defaults_to_present() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("edit-default-diff.txt");
    std::fs::write(&path, "before\n").unwrap();
    let request: FsEditRequest = serde_json::from_value(serde_json::json!({
        "path": path,
        "old": "before",
        "new": "after",
        "dry_run": true
    }))
    .expect("omitted include_diff must decode to the compatibility default");

    let result = fs::fs_edit(&ctx("."), &request).unwrap();
    assert!(
        result
            .diff
            .as_deref()
            .is_some_and(|diff| diff.contains("+after"))
    );
    assert_eq!(std::fs::read_to_string(path).unwrap(), "before\n");
}

fn ctx_cancel(base: &str, cancel: ManualCancellation) -> InvocationContext {
    InvocationContext::new(PathContext::new(PathBuf::from(base)))
        .with_cancellation(Arc::new(cancel))
}

#[test]
fn read_text_large_fixture_is_not_silently_truncated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.txt");
    let body = "line\n".repeat(10_000);
    std::fs::write(&path, &body).unwrap();
    let req = FsReadTextRequest {
        path: path.to_string_lossy().into_owned(),
        base_dir: None,
        start_line: None,
        end_line: None,
        include_sha256: false,
        known_sha256: None,
        format: fs::TextReadFormat::Raw,
        max_bytes: None,
        resume: None,
    };
    let res = fs::read_text(&ctx("."), &req).expect("read_text");
    assert_eq!(
        res.content,
        Some(body),
        "full content must be returned, no truncation"
    );
    assert_eq!(res.total_lines, 10_000);
}

#[test]
fn read_bytes_large_fixture_is_not_silently_truncated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.bin");
    // 5000 bytes, non-UTF-8 to prove binary path works.
    let body: Vec<u8> = (0..5000).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &body).unwrap();
    let req = FsReadBytesRequest {
        path: path.to_string_lossy().into_owned(),
        base_dir: None,
        offset: None,
        length: None,
        include_sha256: false,
        known_sha256: None,
        resume: None,
    };
    let res = fs::read_bytes(&ctx("."), &req).expect("read_bytes");
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(res.base64.as_deref().expect("byte body"))
        .unwrap();
    assert_eq!(decoded, body, "full bytes must be returned, no truncation");
    assert_eq!(res.total_bytes, 5000);
    assert_eq!(res.length, 5000);
}

#[test]
fn search_returns_every_match_when_limit_is_absent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("haystack.txt");
    let body = "target\n".repeat(500);
    std::fs::write(&path, &body).unwrap();
    let req = FsSearchRequest {
        path: path.to_string_lossy().into_owned(),
        pattern: "target".to_string(),
        literal: true,
        case_sensitive: true,
        limit: None,
        cursor: None,
        max_output_bytes: None,
    };
    let res = fs::search(&ctx("."), &req).expect("search");
    assert_eq!(res.matches.len(), 500, "all matches returned when no limit");
}

#[test]
fn raw_search_preserves_hidden_file_coverage() {
    let dir = tempfile::tempdir().unwrap();
    let hidden = dir.path().join(".hidden.txt");
    std::fs::write(&hidden, "legacy-search-match\n").unwrap();
    let root = dir.path().to_string_lossy().into_owned();

    let result = fs::search(
        &ctx(&root),
        &FsSearchRequest {
            path: root,
            pattern: "legacy-search-match".to_string(),
            literal: true,
            case_sensitive: true,
            limit: None,
            cursor: None,
            max_output_bytes: None,
        },
    )
    .expect("raw toolkit search");

    assert_eq!(result.matches.len(), 1);
    assert!(result.matches[0].path.ends_with(".hidden.txt"));
}

#[test]
fn caller_limit_and_cursor_resume_without_duplicate_or_gap() {
    let dir = tempfile::tempdir().unwrap();
    // Create many files, each with one match.
    for i in 0..30u32 {
        let p = dir.path().join(format!("f{i:02}.txt"));
        std::fs::write(&p, "needle\n").unwrap();
    }
    let base = dir.path().to_string_lossy().into_owned();
    // First page: limit 10.
    let req = FsSearchRequest {
        path: base.clone(),
        pattern: "needle".to_string(),
        literal: true,
        case_sensitive: true,
        limit: Some(10),
        cursor: None,
        max_output_bytes: None,
    };
    let res1 = fs::search(&ctx(&base), &req).expect("search page 1");
    assert_eq!(res1.matches.len(), 10, "page 1 returns exactly 10");
    let first_paths: Vec<String> = res1.matches.iter().map(|m| m.path.clone()).collect();
    // Second page via cursor.
    let req2 = FsSearchRequest {
        path: base.clone(),
        pattern: "needle".to_string(),
        literal: true,
        case_sensitive: true,
        limit: Some(10),
        cursor: res1.next_cursor.clone(),
        max_output_bytes: None,
    };
    let res2 = fs::search(&ctx(&base), &req2).expect("search page 2");
    assert_eq!(res2.matches.len(), 10, "page 2 returns exactly 10");
    let second_paths: Vec<String> = res2.matches.iter().map(|m| m.path.clone()).collect();
    // No duplicates between pages.
    for p in &first_paths {
        assert!(
            !second_paths.contains(p),
            "duplicate path across pages: {p}"
        );
    }
    // Collect all 30 across 3 pages; ensure 30 unique total.
    let mut all: Vec<String> = first_paths;
    all.extend(second_paths);
    let req3 = FsSearchRequest {
        path: base.clone(),
        pattern: "needle".to_string(),
        literal: true,
        case_sensitive: true,
        limit: Some(10),
        cursor: res2.next_cursor.clone(),
        max_output_bytes: None,
    };
    let res3 = fs::search(&ctx(&base), &req3).expect("search page 3");
    all.extend(res3.matches.iter().map(|m| m.path.clone()));
    assert_eq!(all.len(), 30);
    let unique: std::collections::HashSet<&String> = all.iter().collect();
    assert_eq!(unique.len(), 30, "no duplicate or gap across pages");
}

#[test]
fn grouped_search_returns_one_line_and_preserves_every_occurrence() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("review.ts");
    std::fs::write(&path, "review-5 review-6\nno match\nreview-7\n").unwrap();
    let root = dir.path().to_string_lossy().into_owned();

    let result = fs::search_with_options(
        &ctx(&root),
        &FsSearchRequest {
            path: root.clone(),
            pattern: r"review-\d+".to_string(),
            literal: false,
            case_sensitive: true,
            limit: Some(1),
            cursor: None,
            max_output_bytes: None,
        },
        &FsSearchOptions {
            group_by_line: true,
            ..FsSearchOptions::default()
        },
    )
    .expect("grouped search");

    assert_eq!(result.matches.len(), 1, "limit counts matching lines");
    let first = &result.matches[0];
    assert_eq!(first.line, 1);
    assert_eq!(first.r#match, "review-5");
    assert_eq!(first.occurrences.as_ref().unwrap().len(), 2);
    assert_eq!(first.occurrences.as_ref().unwrap()[1].column, 10);
    assert!(
        result.next_cursor.is_some(),
        "the second matching line remains"
    );

    let resumed = fs::search_with_options(
        &ctx(&root),
        &FsSearchRequest {
            path: root,
            pattern: r"review-\d+".to_string(),
            literal: false,
            case_sensitive: true,
            limit: Some(1),
            cursor: result.next_cursor,
            max_output_bytes: None,
        },
        &FsSearchOptions {
            group_by_line: true,
            ..FsSearchOptions::default()
        },
    )
    .expect("grouped search resume");
    assert_eq!(resumed.matches.len(), 1);
    assert_eq!(resumed.matches[0].line, 3);
    assert_eq!(resumed.matches[0].occurrences.as_ref().unwrap().len(), 1);
}

struct CancelAfterChecks {
    checks: AtomicUsize,
    allowed_checks: usize,
}

impl CancelAfterChecks {
    fn new(allowed_checks: usize) -> Self {
        Self {
            checks: AtomicUsize::new(0),
            allowed_checks,
        }
    }
}

impl Cancellation for CancelAfterChecks {
    fn is_cancelled(&self) -> bool {
        self.checks.fetch_add(1, Ordering::Relaxed) >= self.allowed_checks
    }
}

#[test]
fn byte_bounded_search_stops_after_one_lookahead_match() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("a.txt");
    std::fs::write(&first, "needle\nneedle\n").unwrap();
    std::fs::write(dir.path().join("b.txt"), "needle\n").unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let unbounded = fs::search(
        &ctx(&root),
        &FsSearchRequest {
            path: root.clone(),
            pattern: "needle".to_string(),
            literal: true,
            case_sensitive: true,
            limit: Some(1),
            cursor: None,
            max_output_bytes: None,
        },
    )
    .expect("measure first match");
    let budget = serde_json::to_vec(&unbounded.matches[0]).unwrap().len() as u64;
    // The walker checks cancellation for the root and both files. Permit those
    // checks plus the first file scan, then cancel if search reaches b.txt.
    let checks_before_second_file_scan = 1 + 2 + 1;
    let bounded_ctx = InvocationContext::new(PathContext::new(dir.path().to_path_buf()))
        .with_cancellation(Arc::new(CancelAfterChecks::new(
            checks_before_second_file_scan,
        )));

    let result = fs::search(
        &bounded_ctx,
        &FsSearchRequest {
            path: root,
            pattern: "needle".to_string(),
            literal: true,
            case_sensitive: true,
            limit: None,
            cursor: None,
            max_output_bytes: Some(budget),
        },
    )
    .expect("bounded page must stop before opening the second file");

    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.returned_item_bytes, budget);
    assert!(result.has_more);
    assert!(result.next_cursor.is_some());

    let control_ctx = InvocationContext::new(PathContext::new(dir.path().to_path_buf()))
        .with_cancellation(Arc::new(CancelAfterChecks::new(
            checks_before_second_file_scan,
        )));
    let error = fs::search(
        &control_ctx,
        &FsSearchRequest {
            path: dir.path().to_string_lossy().into_owned(),
            pattern: "needle".to_string(),
            literal: true,
            case_sensitive: true,
            limit: None,
            cursor: None,
            max_output_bytes: None,
        },
    )
    .expect_err("control search must reach the second file and observe cancellation");
    assert_eq!(error.code, ToolErrorCode::Cancelled);
}

#[test]
fn search_regex_and_literal_have_distinct_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixed.txt");
    // Literal "a+b" should match once; regex "a+b" should match the runs.
    std::fs::write(&path, "a+b\naaab\n").unwrap();
    let base = dir.path().to_string_lossy().into_owned();
    // Literal search for "a+b".
    let lit = fs::search(
        &ctx(&base),
        &FsSearchRequest {
            path: path.to_string_lossy().into_owned(),
            pattern: "a+b".to_string(),
            literal: true,
            case_sensitive: true,
            limit: None,
            cursor: None,
            max_output_bytes: None,
        },
    )
    .expect("literal search");
    assert_eq!(
        lit.matches.len(),
        1,
        "literal matches only the exact string"
    );
    assert_eq!(lit.matches[0].r#match, "a+b");
    // Regex search for a+b.
    let re = fs::search(
        &ctx(&base),
        &FsSearchRequest {
            path: path.to_string_lossy().into_owned(),
            pattern: "a+b".to_string(),
            literal: false,
            case_sensitive: true,
            limit: None,
            cursor: None,
            max_output_bytes: None,
        },
    )
    .expect("regex search");
    assert!(
        re.matches.iter().any(|m| m.r#match == "aaab"),
        "regex should match `aaab`; got matches: {:?}",
        re.matches
    );
}

#[test]
fn crlf_and_lf_report_stable_newline_style() {
    let dir = tempfile::tempdir().unwrap();
    let lf_path = dir.path().join("lf.txt");
    let crlf_path = dir.path().join("crlf.txt");
    std::fs::write(&lf_path, "a\nb\nc\n").unwrap();
    std::fs::write(&crlf_path, "a\r\nb\r\nc\r\n").unwrap();
    let lf = fs::read_text(
        &ctx("."),
        &FsReadTextRequest {
            path: lf_path.to_string_lossy().into_owned(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            known_sha256: None,
            format: fs::TextReadFormat::Raw,
            max_bytes: None,
            resume: None,
        },
    )
    .expect("lf read");
    assert_eq!(lf.newline_style, "lf");
    let crlf = fs::read_text(
        &ctx("."),
        &FsReadTextRequest {
            path: crlf_path.to_string_lossy().into_owned(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            known_sha256: None,
            format: fs::TextReadFormat::Raw,
            max_bytes: None,
            resume: None,
        },
    )
    .expect("crlf read");
    assert_eq!(crlf.newline_style, "crlf");
}

#[test]
fn text_budget_smaller_than_next_utf8_scalar_is_typed_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unicode.txt");
    std::fs::write(&path, "€x").unwrap();
    let error = fs::read_text(
        &ctx("."),
        &FsReadTextRequest {
            path: path.to_string_lossy().into_owned(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            known_sha256: None,
            format: fs::TextReadFormat::Raw,
            max_bytes: Some(1),
            resume: None,
        },
    )
    .expect_err("one byte cannot contain the three-byte euro scalar");
    assert_eq!(error.code, ToolErrorCode::InvalidInput);
    assert_eq!(
        error.details["reason"],
        serde_json::json!("text_window_too_small")
    );
    assert_eq!(
        error.details["minimum_next_window_bytes"],
        serde_json::json!(3)
    );
}

#[test]
fn text_resume_offset_inside_utf8_scalar_is_invalid_input() {
    use sha2::{Digest, Sha256};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unicode-resume.txt");
    let body = "a€z";
    std::fs::write(&path, body).unwrap();
    let preimage: String = Sha256::digest(body.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let error = fs::read_text(
        &ctx("."),
        &FsReadTextRequest {
            path: path.to_string_lossy().into_owned(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            known_sha256: None,
            format: fs::TextReadFormat::Raw,
            max_bytes: Some(4),
            resume: Some(fs::TextResume {
                offset_bytes: 2,
                preimage_sha256: preimage,
                line_range: None,
            }),
        },
    )
    .expect_err("resume offset cannot split a UTF-8 scalar");
    assert_eq!(error.code, ToolErrorCode::InvalidInput);
    assert_eq!(
        error.details["reason"],
        serde_json::json!("resume_offset_invalid")
    );
}

#[test]
fn stale_text_resume_conflict_precedes_new_file_utf8_errors() {
    use sha2::{Digest, Sha256};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stale-unicode-resume.txt");
    let original = "abcdef";
    std::fs::write(&path, original).unwrap();
    let preimage: String = Sha256::digest(original.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    std::fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();

    let error = fs::read_text(
        &ctx("."),
        &FsReadTextRequest {
            path: path.to_string_lossy().into_owned(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            known_sha256: None,
            format: fs::TextReadFormat::Raw,
            max_bytes: Some(2),
            resume: Some(fs::TextResume {
                offset_bytes: 1,
                preimage_sha256: preimage,
                line_range: None,
            }),
        },
    )
    .expect_err("a stale resume must be rejected before parsing new bytes");
    assert_eq!(error.code, ToolErrorCode::Conflict);
    assert_eq!(
        error.details["reason"],
        serde_json::json!("resume_preimage_mismatch")
    );
}

#[test]
fn zero_byte_text_and_binary_windows_are_metadata_only() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data.txt");
    std::fs::write(&path, "content").unwrap();

    let text = fs::read_text(
        &ctx("."),
        &FsReadTextRequest {
            path: path.to_string_lossy().into_owned(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            known_sha256: None,
            format: fs::TextReadFormat::Raw,
            max_bytes: Some(0),
            resume: None,
        },
    )
    .expect("text metadata");
    assert_eq!(text.content.as_deref(), Some(""));
    assert_eq!(text.returned_bytes, Some(0));
    assert!(!text.truncated);
    assert!(text.next_resume.is_none());

    let bytes = fs::read_bytes(
        &ctx("."),
        &FsReadBytesRequest {
            path: path.to_string_lossy().into_owned(),
            base_dir: None,
            offset: None,
            length: Some(0),
            include_sha256: false,
            known_sha256: None,
            resume: None,
        },
    )
    .expect("byte metadata");
    assert_eq!(bytes.base64.as_deref(), Some(""));
    assert_eq!(bytes.length, 0);
    assert!(!bytes.truncated);
    assert!(bytes.next_resume.is_none());
}

#[test]
fn crlf_line_range_windows_reassemble_exact_selected_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("crlf-range.txt");
    let body = "skip\r\nalpha\r\nbeta€\r\nomega\r\n";
    let selected = "alpha\r\nbeta€\r\n";
    std::fs::write(&path, body).unwrap();

    let mut resume = None;
    let mut reassembled = String::new();
    for _ in 0..32 {
        let result = fs::read_text(
            &ctx("."),
            &FsReadTextRequest {
                path: path.to_string_lossy().into_owned(),
                base_dir: None,
                start_line: Some(2),
                end_line: Some(3),
                include_sha256: false,
                known_sha256: None,
                format: fs::TextReadFormat::Raw,
                max_bytes: Some(5),
                resume: resume.clone(),
            },
        )
        .expect("line-range window");
        assert_eq!(result.newline_style, "crlf");
        assert_eq!(result.start_line, Some(2));
        assert_eq!(result.end_line, Some(3));
        reassembled.push_str(result.content.as_deref().expect("line-range content"));
        if result.truncated {
            let next = result.next_resume.expect("truncated range has resume");
            assert_eq!(
                next.line_range
                    .as_ref()
                    .map(|range| (range.start_line, range.end_line)),
                Some((2, 3))
            );
            resume = Some(next);
        } else {
            assert!(result.next_resume.is_none());
            break;
        }
    }
    assert_eq!(reassembled.as_bytes(), selected.as_bytes());
}

#[test]
fn empty_and_past_eof_line_ranges_return_empty_without_panicking() {
    let dir = tempfile::tempdir().unwrap();
    let empty = dir.path().join("empty.txt");
    let short = dir.path().join("short.txt");
    std::fs::write(&empty, "").unwrap();
    std::fs::write(&short, "one\r\ntwo\r\n").unwrap();

    for (path, start, expected_end, expected_offset) in [
        (&empty, 1, 0, 0),
        (&short, 9, 2, std::fs::metadata(&short).unwrap().len()),
    ] {
        let result = fs::read_text(
            &ctx("."),
            &FsReadTextRequest {
                path: path.to_string_lossy().into_owned(),
                base_dir: None,
                start_line: Some(start),
                end_line: None,
                include_sha256: false,
                known_sha256: None,
                format: fs::TextReadFormat::Raw,
                max_bytes: Some(8),
                resume: None,
            },
        )
        .expect("empty range");
        assert_eq!(result.content.as_deref(), Some(""));
        assert_eq!(result.start_line, Some(start));
        assert_eq!(result.end_line, Some(expected_end));
        assert_eq!(result.range_start_bytes, Some(expected_offset));
        assert_eq!(result.range_end_bytes, Some(expected_offset));
        assert!(!result.truncated);
        assert!(result.next_resume.is_none());
    }
}

#[test]
fn write_raw_preserves_requested_newlines() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("raw.txt");
    let content = "a\r\nb\r\n";
    fs::fs_write_text(
        &ctx("."),
        &FsWriteTextRequest {
            path: path.to_string_lossy().into_owned(),
            content: content.to_string(),
            base_dir: None,
            mode: WriteMode::Create,
            create_parents: false,
            expected_sha256: None,
            newline_mode: NewlineMode::Raw,
        },
    )
    .expect("write");
    let on_disk = std::fs::read(&path).unwrap();
    assert_eq!(
        &on_disk,
        content.as_bytes(),
        "raw mode must not transform newlines"
    );
}

#[test]
fn write_expected_hash_conflict_does_not_modify_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("guarded.txt");
    std::fs::write(&path, "original\n").unwrap();
    let before = std::fs::read(&path).unwrap();
    let wrong_hash = "0000000000000000000000000000000000000000000000000000000000000000";
    let res = fs::fs_write_text(
        &ctx("."),
        &FsWriteTextRequest {
            path: path.to_string_lossy().into_owned(),
            content: "new\n".to_string(),
            base_dir: None,
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: Some(wrong_hash.to_string()),
            newline_mode: NewlineMode::Raw,
        },
    );
    assert!(res.is_err(), "mismatched expected_sha256 must error");
    let err = res.unwrap_err();
    assert_eq!(err.code, ToolErrorCode::Conflict);
    // File must NOT be modified.
    let after = std::fs::read(&path).unwrap();
    assert_eq!(after, before, "conflict must not modify the file");
}

#[test]
#[allow(clippy::result_large_err)]
fn concurrent_expected_hash_writes_allow_only_one_winner() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("concurrent-guarded.txt");
    let original = "preimage\n".repeat(250_000);
    std::fs::write(&path, &original).unwrap();
    let expected_sha256 = fs::sha256_hex(original.as_bytes());
    let barrier = Arc::new(Barrier::new(8));

    let mut workers = Vec::new();
    for index in 0..8 {
        let barrier = Arc::clone(&barrier);
        let path = path.clone();
        let expected_sha256 = expected_sha256.clone();
        workers.push(thread::spawn(move || {
            barrier.wait();
            fs::fs_write_text(
                &ctx("."),
                &FsWriteTextRequest {
                    path: path.to_string_lossy().into_owned(),
                    content: format!("winner-{index}\n"),
                    base_dir: None,
                    mode: WriteMode::Overwrite,
                    create_parents: false,
                    expected_sha256: Some(expected_sha256),
                    newline_mode: NewlineMode::Raw,
                },
            )
        }));
    }

    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().expect("worker must join"))
        .collect();
    assert_eq!(
        results.iter().filter(|result| result.is_ok()).count(),
        1,
        "exactly one guarded writer may observe the preimage"
    );
    assert_eq!(
        results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .filter(|error| error.code == ToolErrorCode::Conflict)
            .count(),
        7,
        "all losing writers must report typed conflicts"
    );
    let final_content = std::fs::read_to_string(&path).unwrap();
    assert!(final_content.starts_with("winner-"));
}

#[test]
fn replace_single_rejects_multiple_matches() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("multi.txt");
    std::fs::write(&path, "foo foo foo\n").unwrap();
    let res = fs::fs_replace_text(
        &ctx("."),
        &FsReplaceTextRequest {
            path: path.to_string_lossy().into_owned(),
            old: "foo".to_string(),
            new: "bar".to_string(),
            replace_all: false,
            base_dir: None,
            expected_sha256: None,
        },
    );
    assert!(res.is_err());
    assert_eq!(res.unwrap_err().code, ToolErrorCode::Conflict);
    // replace_all=true succeeds and replaces all.
    let res = fs::fs_replace_text(
        &ctx("."),
        &FsReplaceTextRequest {
            path: path.to_string_lossy().into_owned(),
            old: "foo".to_string(),
            new: "bar".to_string(),
            replace_all: true,
            base_dir: None,
            expected_sha256: None,
        },
    )
    .expect("replace all");
    assert_eq!(res.replacements, 3);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "bar bar bar\n");
}

#[test]
fn copy_and_move_support_spaces_and_unicode() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("my dir/文件 名.txt");
    std::fs::create_dir_all(src.parent().unwrap()).unwrap();
    std::fs::write(&src, "内容 content\n").unwrap();

    let dest = dir.path().join("dest 目录/复制.txt");
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    fs::fs_copy(
        &ctx("."),
        &fs::FsCopyRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: false,
            recursive: true,
        },
    )
    .expect("copy");
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "内容 content\n");

    let moved = dir.path().join("moved 文件.txt");
    std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
    fs::fs_move(
        &ctx("."),
        &fs::FsMoveRequest {
            from: dest.to_string_lossy().into_owned(),
            to: moved.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: false,
        },
    )
    .expect("move");
    assert_eq!(std::fs::read_to_string(&moved).unwrap(), "内容 content\n");
    assert!(!dest.exists(), "source of move must be gone");
}

#[test]
fn move_reports_cross_device_fallback() {
    // We cannot easily force EXDEV in a unit test, but we can assert the result
    // field shape: when rename succeeds, fallback_copy_delete=false. The
    // EXDEV path is exercised in W7 integration. Here we verify the field
    // exists and is false on a same-device move.
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("a.txt");
    std::fs::write(&src, "x").unwrap();
    let dest = dir.path().join("b.txt");
    let res = fs::fs_move(
        &ctx("."),
        &fs::FsMoveRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: false,
        },
    )
    .expect("move");
    assert!(res.moved);
    assert!(
        !res.fallback_copy_delete,
        "same-device move must not report fallback"
    );
}

#[test]
fn remove_nonempty_directory_requires_recursive_flag() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("nonempty");
    std::fs::create_dir_all(nested.join("sub")).unwrap();
    std::fs::write(nested.join("file.txt"), "x").unwrap();

    // recursive=false on non-empty dir -> InvalidInput error.
    let res = fs::fs_remove(
        &ctx("."),
        &FsRemoveRequest {
            path: nested.to_string_lossy().into_owned(),
            base_dir: None,
            recursive: false,
            missing_ok: false,
        },
    );
    assert!(res.is_err());
    assert_eq!(res.unwrap_err().code, ToolErrorCode::InvalidInput);
    assert!(nested.exists(), "non-empty dir must not be removed");

    // recursive=true succeeds.
    fs::fs_remove(
        &ctx("."),
        &FsRemoveRequest {
            path: nested.to_string_lossy().into_owned(),
            base_dir: None,
            recursive: true,
            missing_ok: false,
        },
    )
    .expect("remove recursive");
    assert!(!nested.exists());
}

#[test]
fn absolute_target_outside_base_dir_can_be_written() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("outside-base.txt");
    // base_dir is a different temp dir; writing to absolute `target` outside
    // base_dir must succeed (no containment).
    let base = tempfile::tempdir().unwrap();
    fs::fs_write_text(
        &ctx(&base.path().to_string_lossy()),
        &FsWriteTextRequest {
            path: target.to_string_lossy().into_owned(),
            content: "hello\n".to_string(),
            base_dir: None,
            mode: WriteMode::Create,
            create_parents: false,
            expected_sha256: None,
            newline_mode: NewlineMode::Raw,
        },
    )
    .expect("write outside base");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "hello\n");
}

#[test]
fn symlink_walk_does_not_loop() {
    // Create a directory with a symlink that would loop if followed, then list
    // with follow_symlinks=true and assert it terminates.
    let dir = tempfile::tempdir().unwrap();
    #[allow(unused_variables)]
    let self_link = dir.path().join("loop");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path(), &self_link).unwrap();
    }
    #[cfg(not(unix))]
    {
        // Symlink creation not available on non-unix in std; skip the loop
        // creation and just assert the list completes.
    }
    // follow_symlinks=true with a loop must terminate (walkdir detects cycles).
    let res = fs::fs_list(
        &ctx(&dir.path().to_string_lossy()),
        &fs::FsListRequest {
            path: dir.path().to_string_lossy().into_owned(),
            base_dir: None,
            recursive: true,
            max_depth: Some(3),
            limit: None,
            cursor: None,
            include_hidden: true,
            respect_gitignore: false,
            follow_symlinks: true,
            max_output_bytes: None,
        },
    );
    // Must terminate (Ok) and not hang/panic.
    assert!(res.is_ok(), "symlink walk must terminate: {:?}", res.err());
}

#[test]
fn cancelled_recursive_search_returns_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    // Create many files so the search has iteration work to observe.
    for i in 0..200u32 {
        std::fs::write(dir.path().join(format!("f{i:03}.txt")), "needle\n").unwrap();
    }
    let cancel = ManualCancellation::new();
    let ctx = ctx_cancel(&dir.path().to_string_lossy(), cancel.clone());
    // Cancel immediately before searching.
    cancel.cancel();
    let res = fs::search(
        &ctx,
        &FsSearchRequest {
            path: dir.path().to_string_lossy().into_owned(),
            pattern: "needle".to_string(),
            literal: true,
            case_sensitive: true,
            limit: None,
            cursor: None,
            max_output_bytes: None,
        },
    );
    assert!(res.is_err(), "cancelled search must error");
    assert_eq!(res.unwrap_err().code, ToolErrorCode::Cancelled);
}

// --- review P0/P1 regression: destructive fs defaults + same-source guard ---

/// The serde default for `recursive` MUST be false. A caller that omits it must
/// not silently recurse into a non-empty directory (review P0).
#[test]
fn remove_request_default_recursive_is_false() {
    let req: FsRemoveRequest = serde_json::from_str(r#"{"path":"/tmp/x"}"#).unwrap();
    assert!(
        !req.recursive,
        "recursive must default to false (destructive op)"
    );
}

/// Omitting `recursive` against a non-empty directory must refuse, not delete.
#[test]
fn remove_nonempty_directory_without_recursive_flag_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("nonempty");
    std::fs::create_dir_all(nested.join("sub")).unwrap();
    std::fs::write(nested.join("file.txt"), "x").unwrap();

    // Simulate a caller that sends no `recursive` field at all. Build via json!
    // (not a hand-rolled JSON string) so Windows backslash paths are escaped
    // correctly instead of producing invalid JSON escapes (\p, \t, ...).
    let req: FsRemoveRequest =
        serde_json::from_value(serde_json::json!({ "path": nested.to_string_lossy() })).unwrap();
    let res = fs::fs_remove(&ctx("."), &req);
    assert!(
        res.is_err(),
        "default (no recursive) must refuse non-empty dir"
    );
    assert_eq!(res.unwrap_err().code, ToolErrorCode::InvalidInput);
    assert!(
        nested.exists(),
        "non-empty dir must survive a default remove call"
    );
}

/// `fs_copy` from a path onto itself with overwrite=true must be refused BEFORE
/// the destination is deleted; otherwise the source is lost (review P0).
#[test]
fn copy_onto_self_with_overwrite_refuses_and_preserves_source() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("same.txt");
    std::fs::write(&f, "important").unwrap();
    let res = fs::fs_copy(
        &ctx("."),
        &fs::FsCopyRequest {
            from: f.to_string_lossy().into_owned(),
            to: f.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: true,
            recursive: true,
        },
    );
    assert!(res.is_err(), "copy onto self must be refused");
    assert_eq!(res.unwrap_err().code, ToolErrorCode::InvalidInput);
    assert_eq!(
        std::fs::read_to_string(&f).unwrap(),
        "important",
        "source must be intact after refused copy"
    );
}

/// `fs_move` from a path onto itself with overwrite=true must be refused BEFORE
/// the destination (= source) is deleted (review P0).
#[test]
fn move_onto_self_with_overwrite_refuses_and_preserves_source() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("same.txt");
    std::fs::write(&f, "keep-me").unwrap();
    let res = fs::fs_move(
        &ctx("."),
        &fs::FsMoveRequest {
            from: f.to_string_lossy().into_owned(),
            to: f.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: true,
        },
    );
    assert!(res.is_err(), "move onto self must be refused");
    assert_eq!(res.unwrap_err().code, ToolErrorCode::InvalidInput);
    assert_eq!(
        std::fs::read_to_string(&f).unwrap(),
        "keep-me",
        "source must be intact after refused move"
    );
}

/// Copying a directory into its own subtree must be refused to avoid divergence
/// / infinite recursion (review P0).
#[test]
fn copy_directory_into_own_subtree_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("tree");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::write(src.join("sub/f.txt"), "x").unwrap();
    // Destination nested inside the source.
    let dest = src.join("sub/inside");
    let res = fs::fs_copy(
        &ctx("."),
        &fs::FsCopyRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: true,
            recursive: true,
        },
    );
    assert!(res.is_err(), "copy into own subtree must be refused");
    assert_eq!(res.unwrap_err().code, ToolErrorCode::InvalidInput);
}

/// A symlink inside a copied directory must be replicated, not silently
/// dropped — otherwise a cross-device move fallback would lose it before
/// deleting the source (review P1). Unix-only (std symlink creation).
#[cfg(unix)]
#[test]
fn copy_directory_replicates_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("withlink");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("real.txt"), "payload").unwrap();
    std::os::unix::fs::symlink("real.txt", src.join("alias")).unwrap();

    let dest = dir.path().join("copied");
    fs::fs_copy(
        &ctx("."),
        &fs::FsCopyRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: false,
            recursive: true,
        },
    )
    .expect("copy");
    let alias = dest.join("alias");
    assert!(
        alias.is_symlink(),
        "symlink must be replicated, not dropped"
    );
    assert_eq!(
        std::fs::read_link(&alias).unwrap().to_string_lossy(),
        "real.txt"
    );
}

/// `offset + length` must not overflow u64 and panic on a hostile request
/// (review P1). The request is clamped to EOF and returns a normal result.
#[test]
fn read_bytes_offset_plus_length_does_not_overflow() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("small.bin");
    std::fs::write(&path, b"hello").unwrap();
    // offset=1, length=u64::MAX would panic on naive `offset + length`.
    let res = fs::read_bytes(
        &ctx("."),
        &FsReadBytesRequest {
            path: path.to_string_lossy().into_owned(),
            base_dir: None,
            offset: Some(1),
            length: Some(u64::MAX),
            include_sha256: false,
            known_sha256: None,
            resume: None,
        },
    )
    .expect("read_bytes must not panic / must clamp to EOF");
    // Clamped to file size minus offset.
    assert_eq!(res.length, 4);
    assert_eq!(res.offset, 1);
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(res.base64.as_deref().expect("byte body"))
        .unwrap();
    assert_eq!(decoded, b"ello");
}

// --- review P0 round 2: source-inside-destination overlap + staging ---

/// A source located INSIDE the destination must be refused with overwrite=true
/// BEFORE the destination is deleted — otherwise both are lost. The first guard
/// pass only checked destination-inside-source (review P0 round 2).
#[test]
fn copy_source_inside_destination_with_overwrite_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let src = dest.join("inner.txt"); // source INSIDE destination
    std::fs::write(&src, "payload").unwrap();
    let res = fs::fs_copy(
        &ctx("."),
        &fs::FsCopyRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: true,
            recursive: true,
        },
    );
    assert!(res.is_err(), "copy source-in-dest must be refused");
    assert_eq!(res.unwrap_err().code, ToolErrorCode::InvalidInput);
    assert!(src.exists(), "source must survive refused copy");
    assert!(dest.exists(), "destination must survive refused copy");
}

#[test]
fn move_source_inside_destination_with_overwrite_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let src = dest.join("inner.txt"); // source INSIDE destination
    std::fs::write(&src, "payload").unwrap();
    let res = fs::fs_move(
        &ctx("."),
        &fs::FsMoveRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: true,
        },
    );
    assert!(res.is_err(), "move source-in-dest must be refused");
    assert_eq!(res.unwrap_err().code, ToolErrorCode::InvalidInput);
    assert!(src.exists(), "source must survive refused move");
    assert!(dest.exists(), "destination must survive refused move");
}

/// Copy with overwrite atomically stages the replacement (happy path still
/// yields the new content); the destination is never left deleted (review P0
/// round 2).
#[test]
fn copy_overwrite_uses_atomic_staging() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("dest.txt");
    std::fs::write(&dest, "original").unwrap();
    let src = dir.path().join("src.txt");
    std::fs::write(&src, "replacement").unwrap();
    fs::fs_copy(
        &ctx("."),
        &fs::FsCopyRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: true,
            recursive: true,
        },
    )
    .expect("copy overwrite");
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "replacement");
}

/// A FIFO inside a copied directory must error (Unsupported), not be silently
/// dropped — otherwise a cross-device move would delete it with the source
/// (review P1 round 2). Unix-only (FIFO creation).
#[cfg(unix)]
#[test]
fn copy_directory_rejects_fifo_entries() {
    use std::os::unix::fs::FileTypeExt;
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("withfifo");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("real.txt"), "x").unwrap();
    let fifo = src.join("named.fifo");
    let mk = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !mk
        || !std::fs::symlink_metadata(&fifo)
            .map(|m| m.file_type().is_fifo())
            .unwrap_or(false)
    {
        eprintln!("mkfifo unavailable; skipping FIFO copy test");
        return;
    }
    let dest = dir.path().join("copied");
    let res = fs::fs_copy(
        &ctx("."),
        &fs::FsCopyRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: false,
            recursive: true,
        },
    );
    assert!(
        res.is_err(),
        "copying a FIFO must error, not silently drop it"
    );
    assert_eq!(res.unwrap_err().code, ToolErrorCode::Unsupported);
}

/// Copying a FILE over a non-empty DIRECTORY with overwrite must preserve the
/// destination when the copy fails (review round-3 F2). The staged copy fails
/// before the destination is removed. Unix-only (chmod to induce a read fail).
#[cfg(unix)]
#[test]
fn copy_file_over_dir_failure_preserves_destination() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src.txt");
    std::fs::write(&src, "x").unwrap();
    let dest = dir.path().join("dest");
    std::fs::create_dir_all(dest.join("sub")).unwrap();
    std::fs::write(dest.join("keep.txt"), "important").unwrap();
    std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o000)).unwrap();
    let res = fs::fs_copy(
        &ctx("."),
        &fs::FsCopyRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: true,
            recursive: true,
        },
    );
    let _ = std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o644));
    assert!(res.is_err(), "copy must fail (unreadable source)");
    assert!(
        dest.exists(),
        "destination dir must survive the failed copy"
    );
    assert!(
        dest.join("keep.txt").exists(),
        "destination contents must survive the failed copy"
    );
}

/// The symlink branch of a recursive copy must honor `overwrite` (review
/// round-3 F4). Unix-only (symlink creation).
#[cfg(unix)]
#[test]
fn copy_recursive_symlink_respects_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::os::unix::fs::symlink("target", src.join("l")).unwrap();
    let dest = dir.path().join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::write(dest.join("l"), "blocker").unwrap();
    let r = fs::fs_copy(
        &ctx("."),
        &fs::FsCopyRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: false,
            recursive: true,
        },
    );
    assert!(r.is_err());
    assert_eq!(r.unwrap_err().code, ToolErrorCode::AlreadyExists);
    fs::fs_copy(
        &ctx("."),
        &fs::FsCopyRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: true,
            recursive: true,
        },
    )
    .expect("copy with overwrite");
    assert!(
        dest.join("l").is_symlink(),
        "symlink must replace the blocking file on overwrite"
    );
}

/// W7 C-11 red oracle: copying an EXISTING source onto a destination whose
/// parent directory is missing must report `not_found` against the
/// DESTINATION with `path_role=destination` (previously the error path
/// mis-attributed the failure to the source). Zero writes to the destination.
#[test]
fn copy_missing_destination_parent_reports_destination_role() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src.txt");
    std::fs::write(&src, "payload").unwrap();
    let dest = dir.path().join("missing-parent").join("dest.txt");
    let error = fs::fs_copy(
        &ctx("."),
        &fs::FsCopyRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: false,
            recursive: true,
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ToolErrorCode::NotFound, "{error}");
    assert_eq!(error.details["path_role"], "destination", "{error}");
    assert_eq!(
        error.path.as_deref(),
        Some(dest.to_string_lossy().as_ref()),
        "error path must be the destination, not the source"
    );
    assert!(!dest.exists(), "failure must leave zero destination writes");
}

/// W7 C-11: a single middle-line edit must produce a LOCAL hunk (context
/// lines around the one changed line, not a whole-file delete+add), and the
/// emitted diff must replay through `fs_patch` onto the original preimage.
#[test]
fn single_line_edit_emits_replayable_local_hunk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.txt");
    let original: String = (1..=200).map(|i| format!("line {i:03}\n")).collect();
    std::fs::write(&path, &original).unwrap();
    let preview = fs::fs_edit(
        &ctx("."),
        &FsEditRequest {
            path: path.to_string_lossy().into_owned(),
            old: "line 100\n".to_string(),
            new: "line 100 EDITED\n".to_string(),
            replace_all: false,
            base_dir: None,
            expected_sha256: None,
            dry_run: true,
            reversible: false,
            include_diff: true,
        },
    )
    .expect("dry-run edit preview");
    let diff = preview.diff.expect("dry-run emits a diff preview");
    let minus_lines: Vec<&str> = diff
        .lines()
        .filter(|l| l.starts_with('-') && !l.starts_with("--- "))
        .collect();
    let plus_lines: Vec<&str> = diff
        .lines()
        .filter(|l| l.starts_with('+') && !l.starts_with("+++ "))
        .collect();
    assert_eq!(
        (minus_lines.len(), plus_lines.len()),
        (1, 1),
        "local hunk must contain exactly the changed line, not a whole-file \
         rewrite (got {minus_lines:?} / {plus_lines:?})"
    );
    assert_eq!(
        diff.lines().filter(|l| l.starts_with("@@")).count(),
        1,
        "single edit produces exactly one hunk:\n{diff}"
    );

    // Replay: apply the preview diff onto the ORIGINAL preimage via fs_patch.
    let original_sha = xuanling_toolkit::fs::sha256_hex(original.as_bytes());
    let applied = fs::fs_patch(
        &ctx("."),
        &xuanling_toolkit::fs::FsPatchRequest {
            path: path.to_string_lossy().into_owned(),
            expected_preimage_sha256: original_sha.clone(),
            unified_diff: diff.clone(),
            base_dir: None,
        },
    )
    .expect("replay through fs_patch");
    assert_eq!(applied.hunks_applied, 1);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        original.replace("line 100\n", "line 100 EDITED\n"),
        "replayed patch must reproduce the edited content"
    );
    assert_ne!(applied.after_sha256, original_sha);
}

// --- Wave 0 / F1: fs_move data-loss path (plan §4.2, §4.3) ---
//
// `fs_move(overwrite=true)` previously deleted the destination BEFORE trying
// the install rename whenever source/destination types differed, and relied on
// a bare `rename` for same-type dir-over-dir (which fails ENOTEMPTY on POSIX
// and cannot replace a directory on Windows). These tests pin the data-safety
// invariants: backup-then-install-then-restore-on-failure, atomic directory
// replacement, and non-colliding staging names.

/// `fs_move(overwrite=true)` with a file↔dir type mismatch must NOT delete the
/// destination before the install rename succeeds. When the install rename then
/// fails (source's parent dir is read-only → EACCES, same filesystem so it is
/// NOT an EXDEV), the destination must be restored from the backup rather than
/// lost (plan §4.2: 类型不匹配 先把目标移动到唯一 backup；安装失败时恢复 backup).
#[cfg(unix)]
#[test]
fn move_type_mismatch_rename_failure_restores_destination() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();

    // Destination is a DIRECTORY with content that must survive.
    let to = root.path().join("destdir");
    std::fs::create_dir_all(to.join("sub")).unwrap();
    std::fs::write(to.join("keep.txt"), "important").unwrap();

    // Source is a FILE in a separate, read-only subdirectory. Same filesystem
    // (so the failure is EACCES, not EXDEV): the install rename is denied
    // because the process cannot update the source directory's entries.
    let fromdir = root.path().join("fromdir");
    std::fs::create_dir_all(&fromdir).unwrap();
    let from = fromdir.join("src.txt");
    std::fs::write(&from, "new").unwrap();
    std::fs::set_permissions(&fromdir, std::fs::Permissions::from_mode(0o555)).unwrap();

    let res = fs::fs_move(
        &ctx("."),
        &fs::FsMoveRequest {
            from: from.to_string_lossy().into_owned(),
            to: to.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: true,
        },
    );
    // Restore permissions so the tempdir can be cleaned up either way.
    let _ = std::fs::set_permissions(&fromdir, std::fs::Permissions::from_mode(0o755));

    assert!(res.is_err(), "move must fail (install rename denied)");
    // Destination must be RESTORED: still a directory with intact content —
    // not deleted by a delete-before-install data-loss window.
    assert!(to.is_dir(), "destination dir must be restored, not deleted");
    assert_eq!(
        std::fs::read_to_string(to.join("keep.txt")).unwrap(),
        "important",
        "destination content must survive the failed move"
    );
    assert!(from.exists(), "source must survive the failed move");
}

/// Moving a directory over an existing NON-EMPTY directory with overwrite=true
/// must replace the destination on every supported OS. The previous
/// implementation called `rename(dir, nonempty_dir)` directly, which fails with
/// ENOTEMPTY on POSIX and cannot replace a directory at all on Windows — so the
/// move was unusable for directory replacement (plan §4.2: 同类型 dir→dir 使用
/// 同目录 staging 或平台等价的原子替换).
#[test]
fn move_directory_over_directory_has_same_result_on_supported_os() {
    let root = tempfile::tempdir().unwrap();

    // Source: a non-empty directory tree.
    let src = root.path().join("src");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::write(src.join("a.txt"), "src-a").unwrap();
    std::fs::write(src.join("sub").join("b.txt"), "src-b").unwrap();

    // Destination: a non-empty directory with different content.
    let dest = root.path().join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::write(dest.join("old.txt"), "old").unwrap();

    let res = fs::fs_move(
        &ctx("."),
        &fs::FsMoveRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: true,
        },
    )
    .expect("dir-over-dir overwrite must replace the destination");

    assert!(res.moved, "moved must be true");
    // Destination now reflects the SOURCE tree.
    assert_eq!(
        std::fs::read_to_string(dest.join("a.txt")).unwrap(),
        "src-a"
    );
    assert_eq!(
        std::fs::read_to_string(dest.join("sub").join("b.txt")).unwrap(),
        "src-b"
    );
    // Old destination content is gone (replaced atomically).
    assert!(
        !dest.join("old.txt").exists(),
        "old destination content must be replaced"
    );
    // Source is gone (moved).
    assert!(!src.exists(), "source must be moved away");
}

/// The backup/staging name used while replacing a destination must not collide
/// with — and therefore overwrite — an unrelated sibling entry, and must be
/// cleaned up after a successful move (plan §4.2: staging/backup 文件名使用不可
/// 预测、创建即独占的方式；不能用可碰撞的固定临时名). This is a forward-looking
/// regression lock: a fixed, predictable staging name would clobber one of the
/// decoys below.
#[test]
fn staging_name_collision_does_not_overwrite_unrelated_entry() {
    let root = tempfile::tempdir().unwrap();
    let pid = std::process::id();

    // A pre-existing unrelated file that must survive untouched.
    let keep = root.path().join("keep.txt");
    std::fs::write(&keep, "untouched").unwrap();

    // Decoys with the names a collidable fixed scheme would reuse. Exclusive /
    // unpredictable naming must never clobber any of them.
    let mut decoys: Vec<(PathBuf, String)> = Vec::new();
    for prefix in [
        ".xuanling-backup",
        ".xuanling-stage",
        ".xuanling-backup-tmp",
    ] {
        for seq in 0..4u32 {
            let p = root.path().join(format!("{prefix}-{pid}-{seq}"));
            let c = format!("{prefix}-{pid}-{seq}");
            std::fs::write(&p, &c).unwrap();
            decoys.push((p, c));
        }
    }
    // Names of the pre-existing decoys, to exclude from the post-move leftover
    // scan (they are supposed to survive, not be treated as stray artifacts).
    let decoy_names: std::collections::HashSet<String> = decoys
        .iter()
        .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();

    // Destination is a DIRECTORY; source is a FILE → type mismatch forces the
    // backup path (destination backed up aside, then source installed).
    let dest = root.path().join("destdir");
    std::fs::create_dir_all(dest.join("inner")).unwrap();
    std::fs::write(dest.join("inner").join("f.txt"), "old").unwrap();
    let src = root.path().join("src.txt");
    std::fs::write(&src, "new").unwrap();

    fs::fs_move(
        &ctx("."),
        &fs::FsMoveRequest {
            from: src.to_string_lossy().into_owned(),
            to: dest.to_string_lossy().into_owned(),
            base_dir: None,
            overwrite: true,
        },
    )
    .expect("type-mismatch overwrite move must succeed");

    // Destination is now the source file (overwrite replaced the dir).
    assert!(dest.is_file(), "destination must now hold the moved file");
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new");
    assert!(!src.exists(), "source must be moved away");

    // Unrelated file untouched.
    assert_eq!(std::fs::read_to_string(&keep).unwrap(), "untouched");

    // Every decoy intact: the backup name did not collide with any of them.
    for (p, expected) in &decoys {
        assert_eq!(
            std::fs::read_to_string(p).unwrap_or_default(),
            *expected,
            "decoy {} was clobbered by staging/backup naming",
            p.display()
        );
    }

    // No NEW staging/backup artifacts after a successful move (pre-existing
    // decoys are excluded — they are expected to survive, not be cleaned up).
    let leftovers: Vec<String> = std::fs::read_dir(root.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| {
            (n.starts_with(".xuanling-backup") || n.starts_with(".xuanling-stage"))
                && !decoy_names.contains(n.as_str())
        })
        .collect();
    assert!(
        leftovers.is_empty(),
        "staging/backup artifacts must be cleaned up, found: {leftovers:?}"
    );
}

/// Cross-device move fallback must preserve the SOURCE when the copy step
/// cannot complete, and must leave the backed-up destination intact. The
/// destination's backup is managed by `fs_move`; here we exercise the EXDEV
/// install seam directly (a real cross-device boundary is not reliably
/// reproducible in a unit test) after manually backing the destination up the
/// same way `fs_move` does (plan §4.2: EXDEV copy-delete fallback 在 copy 不完整
/// 时保留源和可诊断的目标状态).
#[cfg(unix)]
#[test]
fn move_type_mismatch_cross_device_copy_failure_preserves_source_and_backup() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();

    // The original destination: a DIRECTORY with content. Simulate the
    // `fs_move` backup step by moving it aside into `backup`.
    let to = root.path().join("dest");
    std::fs::create_dir_all(to.join("sub")).unwrap();
    std::fs::write(to.join("sub").join("f.txt"), "old-dest").unwrap();
    let backup = root.path().join(".xuanling-backup-dest");
    std::fs::rename(&to, &backup).unwrap();
    // `to` is now absent (destination slot cleared by the backup).

    // Source: a FILE whose contents cannot be read (chmod 0000) → copy fails.
    let from = root.path().join("src");
    std::fs::write(&from, "src-data").unwrap();
    std::fs::set_permissions(&from, std::fs::Permissions::from_mode(0o000)).unwrap();

    let res = xuanling_toolkit::fs::copy_move_remove::fs_move_exdev_install(&ctx("."), &from, &to);
    // Restore permissions for tempdir cleanup either way.
    let _ = std::fs::set_permissions(&from, std::fs::Permissions::from_mode(0o644));

    assert!(
        res.is_err(),
        "cross-device install must fail when the source cannot be copied"
    );
    // Source preserved (never deleted after an incomplete copy).
    assert!(
        from.is_file(),
        "source must survive the failed cross-device copy"
    );
    assert_eq!(
        std::fs::read_to_string(&from).unwrap(),
        "src-data",
        "source content must be intact"
    );
    // Backup (the original destination) preserved.
    assert!(
        backup.is_dir(),
        "destination backup must survive the failed install"
    );
    assert_eq!(
        std::fs::read_to_string(backup.join("sub").join("f.txt")).unwrap(),
        "old-dest",
        "destination backup content must be intact"
    );
    // Destination slot is diagnosable (absent — nothing half-installed).
    assert!(
        !to.exists(),
        "destination slot must be left clear after the failed copy"
    );
}

#[test]
fn multi_file_changeset_is_all_or_rollback_per_contract() {
    // ADR 0027 §8.4: a multi-file apply is all-or-rollback. If any file's write
    // fails, every file already written in the SAME apply must be restored to its
    // before-bytes — never a partial apply.
    let dir = std::env::temp_dir().join(format!(
        "xuanling-w4-multi-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();

    // File A exists and will be (successfully) rewritten.
    let a = dir.join("a.txt");
    std::fs::write(&a, b"A-before").unwrap();
    // File B targets a path whose PARENT does not exist -> atomic_write fails.
    let b = dir.join("no_such_subdir").join("b.txt");

    let changes = vec![
        xuanling_toolkit::fs::MultiFileChange {
            path: a.clone(),
            after_bytes: b"A-after".to_vec(),
            expected_preimage_sha256: None,
        },
        xuanling_toolkit::fs::MultiFileChange {
            path: b.clone(),
            after_bytes: b"B-after".to_vec(),
            expected_preimage_sha256: None,
        },
    ];
    let res = xuanling_toolkit::fs::changeset_apply_multi(changes);
    assert!(
        res.is_err(),
        "multi-file apply with a failing file must error"
    );
    let err = res.unwrap_err();
    assert_eq!(
        err.code,
        xuanling_toolkit::ToolErrorCode::IoError,
        "write failure must be io_error: {err:?}"
    );
    // all-or-rollback: A must be restored to its BEFORE content (NOT "A-after").
    assert_eq!(
        std::fs::read(&a).unwrap(),
        b"A-before".to_vec(),
        "already-applied file A must be rolled back on failure (all-or-rollback)"
    );
    // B was never written (its parent dir was absent).
    assert!(!b.exists(), "the failing file B must not exist");

    // Sanity: a fully-valid multi-apply succeeds and writes all files.
    let c = dir.join("c.txt");
    std::fs::write(&c, b"C-before").unwrap();
    let ok = xuanling_toolkit::fs::changeset_apply_multi(vec![
        xuanling_toolkit::fs::MultiFileChange {
            path: a.clone(),
            after_bytes: b"A-after2".to_vec(),
            expected_preimage_sha256: None,
        },
        xuanling_toolkit::fs::MultiFileChange {
            path: c.clone(),
            after_bytes: b"C-after".to_vec(),
            expected_preimage_sha256: None,
        },
    ])
    .expect("all-valid multi-apply succeeds");
    assert_eq!(ok.applied_paths.len(), 2);
    assert_eq!(std::fs::read(&a).unwrap(), b"A-after2");
    assert_eq!(std::fs::read(&c).unwrap(), b"C-after");

    // And a preimage-mismatch on the 2nd file rolls back the 1st (zero partial).
    std::fs::write(&a, b"A-before2").unwrap();
    let sha_a = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"A-before2");
        h.finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let mismatch = xuanling_toolkit::fs::changeset_apply_multi(vec![
        xuanling_toolkit::fs::MultiFileChange {
            path: a.clone(),
            after_bytes: b"A-applied".to_vec(),
            expected_preimage_sha256: Some(sha_a),
        },
        xuanling_toolkit::fs::MultiFileChange {
            path: c.clone(),
            after_bytes: b"C-new".to_vec(),
            expected_preimage_sha256: Some("deadbeef".to_string()), // mismatch
        },
    ]);
    assert!(mismatch.is_err(), "preimage mismatch must fail the apply");
    assert_eq!(
        std::fs::read(&a).unwrap(),
        b"A-before2",
        "A must be rolled back after the 2nd file's preimage mismatch"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn multi_file_rollback_restores_absent_targets_as_absent() {
    // An absent target and an empty file are distinct filesystem states. If a
    // later write fails, rollback must delete an earlier newly-created target;
    // restoring it as empty would leave a partial mutation behind.
    let dir = tempfile::tempdir().unwrap();
    let created_then_rolled_back = dir.path().join("created.txt");
    let failing = dir.path().join("missing-parent").join("failing.txt");

    let error = xuanling_toolkit::fs::changeset_apply_multi(vec![
        xuanling_toolkit::fs::MultiFileChange {
            path: created_then_rolled_back.clone(),
            after_bytes: b"new file".to_vec(),
            expected_preimage_sha256: None,
        },
        xuanling_toolkit::fs::MultiFileChange {
            path: failing,
            after_bytes: b"cannot write".to_vec(),
            expected_preimage_sha256: None,
        },
    ])
    .expect_err("second write must fail");

    assert_eq!(error.code, ToolErrorCode::IoError);
    assert_eq!(
        error.details["reason"],
        serde_json::json!("multi_apply_write_failed"),
        "clean rollback must be reported distinctly from a rollback failure"
    );
    assert!(
        !created_then_rolled_back.exists(),
        "rollback must restore an originally absent target by removing it"
    );
}

#[test]
fn rollback_terminal_states_reject_a_second_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let restored = dir.path().join("restored.txt");
    std::fs::write(&restored, "before").unwrap();
    let applied = fs::fs_edit(
        &ctx("."),
        &FsEditRequest {
            path: restored.to_string_lossy().into_owned(),
            old: "before".to_string(),
            new: "after".to_string(),
            replace_all: false,
            base_dir: None,
            expected_sha256: None,
            dry_run: false,
            reversible: true,
            include_diff: true,
        },
    )
    .expect("reversible edit");
    let restored_id = applied.change_id.expect("change id");
    assert_eq!(
        fs::changeset_rollback(&restored_id).expect("first rollback"),
        fs::ChangeSetState::RolledBack
    );
    let second = fs::changeset_rollback(&restored_id).expect_err("rolled_back is terminal");
    assert_eq!(second.code, ToolErrorCode::Conflict);
    assert_eq!(
        second.details["reason"],
        serde_json::json!("invalid_changeset_state")
    );
    assert_eq!(second.details["state"], serde_json::json!("rolled_back"));

    let conflicted = dir.path().join("conflicted.txt");
    std::fs::write(&conflicted, "before").unwrap();
    let applied = fs::fs_edit(
        &ctx("."),
        &FsEditRequest {
            path: conflicted.to_string_lossy().into_owned(),
            old: "before".to_string(),
            new: "after".to_string(),
            replace_all: false,
            base_dir: None,
            expected_sha256: None,
            dry_run: false,
            reversible: true,
            include_diff: true,
        },
    )
    .expect("reversible edit");
    let conflicted_id = applied.change_id.expect("change id");
    std::fs::write(&conflicted, "user edit").unwrap();
    assert_eq!(
        fs::changeset_rollback(&conflicted_id).expect("first rollback"),
        fs::ChangeSetState::RollbackConflict
    );
    let second = fs::changeset_rollback(&conflicted_id).expect_err("rollback_conflict is terminal");
    assert_eq!(second.code, ToolErrorCode::Conflict);
    assert_eq!(
        second.details["reason"],
        serde_json::json!("invalid_changeset_state")
    );
    assert_eq!(
        second.details["state"],
        serde_json::json!("rollback_conflict")
    );
    assert_eq!(std::fs::read_to_string(conflicted).unwrap(), "user edit");
}

#[cfg(unix)]
#[test]
fn rollback_restore_io_failure_keeps_change_retryable() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("retry.txt");
    std::fs::write(&path, "before").unwrap();
    let applied = fs::fs_edit(
        &ctx("."),
        &FsEditRequest {
            path: path.to_string_lossy().into_owned(),
            old: "before".to_string(),
            new: "after".to_string(),
            replace_all: false,
            base_dir: None,
            expected_sha256: None,
            dry_run: false,
            reversible: true,
            include_diff: true,
        },
    )
    .expect("reversible edit");
    let change_id = applied.change_id.expect("change id");

    let original_mode = std::fs::metadata(dir.path()).unwrap().permissions().mode();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
    let failed = fs::changeset_rollback(&change_id).expect_err("readonly parent blocks temp file");
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(original_mode)).unwrap();
    assert_eq!(failed.code, ToolErrorCode::IoError);
    assert_eq!(
        failed.details["reason"],
        serde_json::json!("rollback_restore_failed")
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "after");

    assert_eq!(
        fs::changeset_rollback(&change_id).expect("retry after restoring permissions"),
        fs::ChangeSetState::RolledBack
    );
    assert_eq!(std::fs::read_to_string(path).unwrap(), "before");
}
