//! ZCode compatibility shim (dynamic plan revision 2026-08-15, C-16).
//!
//! The ZCode host's tool-call argument coercion does not resolve JSON-Schema
//! `$ref` properties: parameters whose declared schema is a `$ref` into
//! `$defs` (e.g. `output`, `scope`, `payload`, `stdout`/`stderr`) arrive as
//! JSON-encoded STRINGS, while inline-typed object parameters (e.g.
//! `process_run.env`) parse correctly — confirmed live against the 0.2.0
//! server. Raw MCP with the same objects passes 9/9, so the defect is
//! host-side.
//!
//! `--compat-lenient-object-params` (default OFF) lets THIS deployment accept
//! the host's stringified objects: for each top-level parameter whose schema
//! resolves to an object (or a union containing an object), a string value
//! that parses as a JSON object is coerced to that object before dispatch.
//! String-typed parameters are never coerced, and the strict contract stays
//! the default — the shim exists only where a known-buggy host cannot be
//! fixed first.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde_json::{Map, Value};

/// Coerce stringified object parameters in `arguments` for `tool`, per the
/// precomputed catalog table. Returns the (possibly new) arguments map.
pub fn coerce_stringified_objects(tool: &str, arguments: &mut Map<String, Value>) {
    let Some(object_params) = object_typed_params().get(tool) else {
        return;
    };
    for param in object_params {
        if let Some(Value::String(text)) = arguments.get(param) {
            match serde_json::from_str::<Value>(text) {
                Ok(parsed @ Value::Object(_)) => {
                    arguments.insert((*param).to_string(), parsed);
                }
                _ => {
                    // Not a JSON object (or unparseable): leave it for the
                    // strict deserializer to reject with its typed error.
                }
            }
        }
    }
}

/// Per-tool top-level parameters whose schema resolves to an object or a
/// union containing an object. Computed once from the static catalog by
/// walking each tool's serialized JSON Schema.
fn object_typed_params() -> &'static HashMap<String, HashSet<String>> {
    static TABLE: OnceLock<HashMap<String, HashSet<String>>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = HashMap::new();
        for tool in crate::handlers::catalog() {
            let schema = serde_json::to_value(&tool.input_schema).unwrap_or(Value::Null);
            let mut params = HashSet::new();
            if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
                for (name, property) in properties {
                    if schema_expects_object(property, &schema, 0) {
                        params.insert(name.clone());
                    }
                }
            }
            if !params.is_empty() {
                table.insert(tool.name.to_string(), params);
            }
        }
        table
    })
}

/// Whether `schema` (a serialized JSON Schema node) expects a JSON object at
/// the top level. `$ref` chains are resolved against the root schema's
/// `$defs`/`definitions` with a depth guard against cycles.
fn schema_expects_object(schema: &Value, root: &Value, depth: usize) -> bool {
    if depth > 16 {
        return false;
    }
    // Local references only: "#/$defs/Name" / "#/definitions/Name".
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        if let Some(resolved) = resolve_local_ref(reference, root) {
            return schema_expects_object(resolved, root, depth + 1);
        }
        return false;
    }
    if schema.get("type").and_then(Value::as_str) == Some("object") {
        return true;
    }
    for union in ["oneOf", "anyOf", "allOf"] {
        if let Some(members) = schema.get(union).and_then(Value::as_array)
            && members
                .iter()
                .any(|member| schema_expects_object(member, root, depth + 1))
        {
            return true;
        }
    }
    // `additionalProperties`-only object schemas (map types).
    schema
        .get("additionalProperties")
        .is_some_and(|v| v.is_object())
}

fn resolve_local_ref<'a>(reference: &str, root: &'a Value) -> Option<&'a Value> {
    let pointer = reference.strip_prefix('#')?;
    let mut current = root;
    for segment in pointer.trim_start_matches('/').split('/') {
        if segment.is_empty() {
            continue;
        }
        current = current.get(segment.replace("~1", "/").replace("~0", "~"))?;
    }
    Some(current)
}
