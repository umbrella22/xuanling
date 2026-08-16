//! Memory v2 scope: strict tagged JSON, caller-provided opaque ids.
//!
//! `{"type":"global"}`, `{"type":"project","project_id":"…"}` and
//! `{"type":"workspace","project_id":"…","workspace_id":"…"}` are the only
//! accepted shapes. Unknown fields, empty ids, or ids containing the canonical
//! separator are `invalid_input`. The scope is NOT an authentication boundary
//! and is never derived from paths, Git, or workspace detection.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

impl Serialize for MemoryScope {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(3))?;
        match self {
            MemoryScope::Global => {
                map.serialize_entry("type", "global")?;
            }
            MemoryScope::Project { project_id } => {
                map.serialize_entry("type", "project")?;
                map.serialize_entry("project_id", project_id)?;
            }
            MemoryScope::Workspace {
                project_id,
                workspace_id,
            } => {
                map.serialize_entry("type", "workspace")?;
                map.serialize_entry("project_id", project_id)?;
                map.serialize_entry("workspace_id", workspace_id)?;
            }
        }
        map.end()
    }
}

use crate::error::{ToolError, ToolErrorCode};

/// Canonical separator for scope keys; forbidden inside caller-provided ids.
pub(crate) const SCOPE_SEP: char = '\u{1f}';

/// Exact memory scope (plan §5, C-04).
// The wire form is the strict tagged object implemented by the manual
// Serialize/Deserialize below; the serde container attributes are metadata so
// schema generation describes that same tagged form.
#[derive(Clone, Debug, PartialEq, Eq, Hash, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MemoryScope {
    Global,
    Project {
        project_id: String,
    },
    Workspace {
        project_id: String,
        workspace_id: String,
    },
}

impl MemoryScope {
    /// Canonical scope key: stable, non-null, safe for UNIQUE indexes.
    pub fn scope_key(&self) -> String {
        match self {
            Self::Global => "global".to_string(),
            Self::Project { project_id } => format!("project{SCOPE_SEP}{project_id}"),
            Self::Workspace {
                project_id,
                workspace_id,
            } => format!("workspace{SCOPE_SEP}{project_id}{SCOPE_SEP}{workspace_id}"),
        }
    }

    /// Ancestor scopes for `ancestors` search: workspace → project → global.
    /// Never crosses into a sibling project.
    pub fn ancestors(&self) -> Vec<MemoryScope> {
        match self {
            Self::Global => vec![Self::Global],
            Self::Project { project_id } => vec![
                Self::Project {
                    project_id: project_id.clone(),
                },
                Self::Global,
            ],
            Self::Workspace {
                project_id,
                workspace_id,
            } => vec![
                Self::Workspace {
                    project_id: project_id.clone(),
                    workspace_id: workspace_id.clone(),
                },
                Self::Project {
                    project_id: project_id.clone(),
                },
                Self::Global,
            ],
        }
    }

    fn validate_id(value: &str, field: &str) -> Result<(), ToolError> {
        if value.is_empty() {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "memory.scope",
                format!("{field} must not be empty"),
            ));
        }
        if value.contains(SCOPE_SEP) {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "memory.scope",
                format!("{field} must not contain the canonical separator U+001F"),
            ));
        }
        Ok(())
    }

    pub(crate) fn validate(&self) -> Result<(), ToolError> {
        match self {
            Self::Global => Ok(()),
            Self::Project { project_id } => Self::validate_id(project_id, "project_id"),
            Self::Workspace {
                project_id,
                workspace_id,
            } => {
                Self::validate_id(project_id, "project_id")?;
                Self::validate_id(workspace_id, "workspace_id")
            }
        }
    }

    pub(crate) fn type_name(&self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project { .. } => "project",
            Self::Workspace { .. } => "workspace",
        }
    }

    pub(crate) fn project_id(&self) -> Option<&str> {
        match self {
            Self::Global => None,
            Self::Project { project_id } | Self::Workspace { project_id, .. } => Some(project_id),
        }
    }

    pub(crate) fn workspace_id(&self) -> Option<&str> {
        match self {
            Self::Workspace { workspace_id, .. } => Some(workspace_id),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for MemoryScope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let map = match &value {
            serde_json::Value::Object(map) => map,
            _ => {
                return Err(serde::de::Error::custom(
                    "scope must be a tagged object like {\"type\":\"global\"}",
                ));
            }
        };
        let type_name = match map.get("type") {
            Some(serde_json::Value::String(s)) => s.as_str(),
            _ => {
                return Err(serde::de::Error::custom(
                    "scope requires a string \"type\" of global|project|workspace",
                ));
            }
        };
        let scope = match type_name {
            "global" => {
                if map.len() != 1 {
                    return Err(serde::de::Error::custom(
                        "global scope accepts no additional fields",
                    ));
                }
                Self::Global
            }
            "project" => {
                if map.len() != 2 {
                    return Err(serde::de::Error::custom(
                        "project scope accepts exactly project_id",
                    ));
                }
                Self::Project {
                    project_id: take_id::<D::Error>(map, "project_id", "project")?,
                }
            }
            "workspace" => {
                if map.len() != 3 {
                    return Err(serde::de::Error::custom(
                        "workspace scope accepts exactly project_id and workspace_id",
                    ));
                }
                Self::Workspace {
                    project_id: take_id::<D::Error>(map, "project_id", "workspace")?,
                    workspace_id: take_id::<D::Error>(map, "workspace_id", "workspace")?,
                }
            }
            other => {
                return Err(serde::de::Error::custom(format!(
                    "unknown scope type {other:?}; expected global|project|workspace"
                )));
            }
        };
        scope
            .validate()
            .map_err(|e| serde::de::Error::custom(e.message))?;
        Ok(scope)
    }
}

fn take_id<E>(
    map: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    type_name: &str,
) -> Result<String, E>
where
    E: serde::de::Error,
{
    match map.get(key) {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Ok(s.clone()),
        Some(_) => Err(E::custom(format!("scope.{key} must be a non-empty string"))),
        None => Err(E::custom(format!(
            "scope type {type_name:?} requires {key}"
        ))),
    }
}

impl MemoryScope {
    /// Rebuild from stored columns.
    pub(crate) fn from_columns(
        scope_type: &str,
        project_id: Option<&str>,
        workspace_id: Option<&str>,
    ) -> Result<Self, ToolError> {
        match scope_type {
            "global" => Ok(Self::Global),
            "project" => Ok(Self::Project {
                project_id: project_id
                    .ok_or_else(|| {
                        ToolError::new(
                            ToolErrorCode::IntegrityError,
                            "memory.scope",
                            "project scope row missing project_id",
                        )
                    })?
                    .to_string(),
            }),
            "workspace" => Ok(Self::Workspace {
                project_id: project_id
                    .ok_or_else(|| {
                        ToolError::new(
                            ToolErrorCode::IntegrityError,
                            "memory.scope",
                            "workspace scope row missing project_id",
                        )
                    })?
                    .to_string(),
                workspace_id: workspace_id
                    .ok_or_else(|| {
                        ToolError::new(
                            ToolErrorCode::IntegrityError,
                            "memory.scope",
                            "workspace scope row missing workspace_id",
                        )
                    })?
                    .to_string(),
            }),
            other => Err(ToolError::new(
                ToolErrorCode::IntegrityError,
                "memory.scope",
                format!("unknown stored scope type {other:?}"),
            )),
        }
    }
}
