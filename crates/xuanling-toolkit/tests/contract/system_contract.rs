//! `system_info` contract (plan §7.1, §10 W1).
//!
//! Asserts `system_info` returns deterministic runtime facts and NEVER leaks
//! the full environment or any secret. The full env block is intentionally not
//! part of the result.

use std::sync::Arc;
use xuanling_toolkit::system::system_info;
use xuanling_toolkit::{InvocationContext, NoCancellation, PathContext};

fn ctx() -> InvocationContext {
    InvocationContext::new(PathContext::new(std::path::PathBuf::from(".")))
        .with_cancellation(Arc::new(NoCancellation))
}

#[test]
fn system_info_never_returns_environment_values() {
    // Plant a uniquely-named env var; if system_info ever returned the env
    // block, this token would appear somewhere in the serialized result.
    let token = "XUANLING_SYSINFO_CANARY_B4D1F00D";
    // Edition 2024 requires `unsafe` for env mutation.
    unsafe { std::env::set_var(token, "leak-if-returned") };
    let info = system_info();

    let json = serde_json::to_string(&info).expect("serialize system_info");
    assert!(
        !json.contains(token) && !json.contains("leak-if-returned"),
        "system_info must NOT return environment variables; found env canary in result: {json}"
    );

    // The field set must not contain an `environment`/`env` field at all.
    let value: serde_json::Value = serde_json::from_str(&json).expect("parse");
    let obj = value.as_object().expect("object");
    for forbidden in ["environment", "env", "environ", "vars"] {
        assert!(
            !obj.contains_key(forbidden),
            "system_info must not expose a `{forbidden}` field"
        );
    }
}

#[test]
fn system_info_returns_required_fields() {
    let info = system_info();
    // Plan §7.1 required fields.
    assert!(!info.family.is_empty(), "family must be populated");
    assert!(!info.os.is_empty(), "os must be populated");
    assert!(!info.arch.is_empty(), "arch must be populated");
    assert!(
        !info.path_separator.is_empty(),
        "path_separator must be set"
    );
    assert!(!info.newline.is_empty(), "newline must be set");
    assert!(matches!(info.pointer_width, 32 | 64));
    // executable_suffixes is a list (empty off-Windows, populated on Windows).
    let _ = &info.executable_suffixes;

    // Family/os consistency: windows family only on Windows target.
    let is_windows = cfg!(target_os = "windows");
    assert_eq!(info.family == "windows", is_windows);
    assert_eq!(info.os == "windows", is_windows);

    // Path separator matches the target's MAIN_SEPARATOR.
    assert_eq!(info.path_separator, std::path::MAIN_SEPARATOR.to_string());

    // Entry point agrees with the free function.
    let via_ctx = xuanling_toolkit::system::info(&ctx()).expect("info via ctx");
    assert_eq!(via_ctx.os, info.os);
    assert_eq!(via_ctx.arch, info.arch);
}
