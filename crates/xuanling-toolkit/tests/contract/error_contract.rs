//! Error-code wire-format contract (plan §5, §10 W0).
//!
//! Asserts every [`ToolErrorCode`] serializes to and deserializes from the
//! canonical `snake_case` string, and that `ToolError` round-trips through
//! serde. This pins the stable program-readable failure surface that agents
//! branch on instead of scraping free text.

use serde_json::json;
use xuanling_toolkit::{ToolError, ToolErrorCode};

#[test]
fn tool_error_code_round_trips_as_snake_case() {
    let cases = [
        (ToolErrorCode::InvalidInput, "invalid_input"),
        (ToolErrorCode::NotFound, "not_found"),
        (ToolErrorCode::PermissionDenied, "permission_denied"),
        (ToolErrorCode::OutsideCapability, "outside_capability"),
        (ToolErrorCode::AlreadyExists, "already_exists"),
        (ToolErrorCode::NotDirectory, "not_directory"),
        (ToolErrorCode::IsDirectory, "is_directory"),
        (ToolErrorCode::InvalidUtf8, "invalid_utf8"),
        (ToolErrorCode::Unsupported, "unsupported"),
        (ToolErrorCode::Conflict, "conflict"),
        (ToolErrorCode::Cancelled, "cancelled"),
        (ToolErrorCode::DeadlineExceeded, "deadline_exceeded"),
        (ToolErrorCode::SpawnFailed, "spawn_failed"),
        (ToolErrorCode::DatabaseBusy, "database_busy"),
        (ToolErrorCode::IoError, "io_error"),
        (ToolErrorCode::RecoveryFailed, "recovery_failed"),
        (ToolErrorCode::Internal, "internal"),
    ];
    for (code, expected) in cases {
        // Serialize matches snake_case literal.
        let s = serde_json::to_string(&code).expect("serialize code");
        assert_eq!(s, format!("\"{expected}\""), "code {code:?} -> {s}");
        // as_snake_case helper agrees with serde.
        assert_eq!(code.as_snake_case(), expected);
        // Deserialize round-trips back.
        let back: ToolErrorCode = serde_json::from_str(&s).expect("deserialize code");
        assert_eq!(back, code, "round-trip mismatch for {code:?}");
    }
}

#[test]
fn tool_error_round_trips_with_structured_fields() {
    let err = ToolError::new(
        ToolErrorCode::Conflict,
        "fs.write_text",
        "expected hash mismatch",
    )
    .with_path("/tmp/x.txt")
    .with_details(json!({ "actual_sha256": "abcdef" }));
    let json_str = serde_json::to_string(&err).expect("serialize error");
    let back: ToolError = serde_json::from_str(&json_str).expect("deserialize error");
    assert_eq!(back.code, ToolErrorCode::Conflict);
    assert_eq!(back.operation, "fs.write_text");
    assert_eq!(back.path.as_deref(), Some("/tmp/x.txt"));
    assert_eq!(back.details, json!({ "actual_sha256": "abcdef" }));
}
