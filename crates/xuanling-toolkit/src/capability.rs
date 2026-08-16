//! Optional execution capabilities applied after locator resolution.
//!
//! `PathContext` answers where a locator points. `FilesystemScope` answers
//! whether the configured server may open that path. Keeping the concepts
//! separate preserves the toolkit's unrestricted library contract while
//! allowing an MCP deployment to opt into workspace containment.

use std::path::{Component, Path, PathBuf};

use serde_json::json;

use crate::error::{ToolError, ToolErrorCode};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathAccess {
    Read,
    /// Inspect the final directory entry without following a symlink stored in
    /// that slot. Ancestor symlinks are still resolved and contained.
    ReadEntry,
    Write,
    Delete,
    /// Unlink the final directory entry without following it. A symlink is
    /// allowed only in the final component; mutation through a symlink
    /// ancestor remains rejected.
    DeleteEntry,
    ProcessCwd,
}

impl PathAccess {
    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::ReadEntry => "read_entry",
            Self::Write => "write",
            Self::Delete => "delete",
            Self::DeleteEntry => "delete_entry",
            Self::ProcessCwd => "process_cwd",
        }
    }

    fn requires_mutation_check(self) -> bool {
        matches!(self, Self::Write | Self::Delete | Self::DeleteEntry)
    }

    fn operates_on_entry(self) -> bool {
        matches!(self, Self::ReadEntry | Self::DeleteEntry)
    }
}

#[derive(Clone, Debug, Default)]
pub enum FilesystemScope {
    #[default]
    Unrestricted,
    Workspace(WorkspaceScope),
}

impl FilesystemScope {
    /// Single write root; the legacy single-root capability.
    pub fn workspace(root: impl AsRef<Path>) -> Result<Self, ToolError> {
        Self::workspace_roots([root])
    }

    /// Multiple write roots (ADR 0029). Every root admits read and write.
    pub fn workspace_roots<I>(roots: I) -> Result<Self, ToolError>
    where
        I: IntoIterator,
        I::Item: AsRef<Path>,
    {
        Self::workspace_with_read_roots(roots, std::iter::empty::<&Path>())
    }

    /// Write roots plus read-only roots (ADR 0029). A path inside a read-only
    /// root admits read-class access only; write-class access is rejected.
    pub fn workspace_with_read_roots<W, R>(write_roots: W, read_roots: R) -> Result<Self, ToolError>
    where
        W: IntoIterator,
        W::Item: AsRef<Path>,
        R: IntoIterator,
        R::Item: AsRef<Path>,
    {
        WorkspaceScope::new(write_roots, read_roots).map(Self::Workspace)
    }

    /// Whether any capability root is configured (contained mode).
    pub fn is_contained(&self) -> bool {
        matches!(self, Self::Workspace(_))
    }

    /// The default `--base-dir` target in contained mode: the first write
    /// root, falling back to the first read root in a read-only deployment.
    pub fn first_workspace_root(&self) -> Option<&Path> {
        match self {
            Self::Unrestricted => None,
            Self::Workspace(scope) => scope.first_write_root(),
        }
    }

    /// Configured write-root count (`_meta` diagnostics, ADR 0029).
    pub fn write_root_count(&self) -> usize {
        match self {
            Self::Unrestricted => 0,
            Self::Workspace(scope) => scope.write_roots().len(),
        }
    }

    /// Configured read-only-root count (`_meta` diagnostics, ADR 0029).
    pub fn read_root_count(&self) -> usize {
        match self {
            Self::Unrestricted => 0,
            Self::Workspace(scope) => scope.read_roots().len(),
        }
    }

    pub fn permits_existing_read(&self, path: &Path, operation: &str) -> Result<bool, ToolError> {
        match self {
            Self::Unrestricted => Ok(true),
            Self::Workspace(scope) => scope.permits_existing_read(path, operation),
        }
    }

    /// Whether a recursive walker may descend into `path`.
    ///
    /// This intentionally asks about the object that would be opened, not just
    /// the directory entry's spelling. In workspace mode, a symlink directory
    /// whose target leaves the workspace is rejected before a walker opens it.
    pub fn permits_directory_descent(
        &self,
        path: &Path,
        operation: &str,
    ) -> Result<bool, ToolError> {
        self.permits_existing_read(path, operation)
    }

    pub(crate) fn validate(
        &self,
        candidate: &Path,
        access: PathAccess,
        operation: &str,
    ) -> Result<PathBuf, ToolError> {
        match self {
            Self::Unrestricted => {
                let candidate = if access.operates_on_entry() {
                    normalize_entry_symlink_locator(candidate)
                } else {
                    candidate.to_path_buf()
                };
                Ok(candidate)
            }
            Self::Workspace(scope) => scope.validate(candidate, access, operation),
        }
    }

    /// Resolve a `base_dir` locator for a subsequent relative path.
    ///
    /// A workspace scope treats an existing base directory as a locator for a
    /// physical directory: after proving that its target is contained, it
    /// freezes the base to its canonical spelling. This intentionally differs
    /// from resolving an operation target. A target remains lexical so a write
    /// through a symlink *below* the effective base is still rejected.
    ///
    /// Missing bases retain their validated lexical spelling. Some filesystem
    /// calls legitimately create descendants of a missing base, and there is
    /// no physical directory identity to freeze yet.
    pub(crate) fn resolve_base(
        &self,
        candidate: &Path,
        operation: &str,
    ) -> Result<PathBuf, ToolError> {
        match self {
            Self::Unrestricted => Ok(candidate.to_path_buf()),
            Self::Workspace(scope) => scope.resolve_base(candidate, operation),
        }
    }
}

#[derive(Clone, Debug)]
pub struct WorkspaceScope {
    write_roots: Vec<PathBuf>,
    read_roots: Vec<PathBuf>,
}

impl WorkspaceScope {
    fn new<W, R>(write_roots: W, read_roots: R) -> Result<Self, ToolError>
    where
        W: IntoIterator,
        W::Item: AsRef<Path>,
        R: IntoIterator,
        R::Item: AsRef<Path>,
    {
        let canonicalize = |requested: &Path| -> Result<PathBuf, ToolError> {
            let canonical = std::fs::canonicalize(requested).map_err(|error| {
                scope_io_error(
                    error,
                    "capability.workspace",
                    requested,
                    "workspace_root_invalid",
                )
            })?;
            if !canonical.is_dir() {
                return Err(ToolError::new(
                    ToolErrorCode::NotDirectory,
                    "capability.workspace",
                    "workspace root is not a directory",
                )
                .with_path(canonical.to_string_lossy()));
            }
            Ok(canonical)
        };
        let write_roots = write_roots
            .into_iter()
            .map(|root| canonicalize(root.as_ref()))
            .collect::<Result<Vec<_>, _>>()?;
        let read_roots = read_roots
            .into_iter()
            .map(|root| canonicalize(root.as_ref()))
            .collect::<Result<Vec<_>, _>>()?;
        if write_roots.is_empty() && read_roots.is_empty() {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "capability.workspace",
                "at least one workspace or read root is required",
            ));
        }
        Ok(Self {
            write_roots,
            read_roots,
        })
    }

    fn write_roots(&self) -> &[PathBuf] {
        &self.write_roots
    }

    fn read_roots(&self) -> &[PathBuf] {
        &self.read_roots
    }

    fn first_write_root(&self) -> Option<&Path> {
        self.write_roots
            .first()
            .map(PathBuf::as_path)
            .or_else(|| self.read_roots.first().map(PathBuf::as_path))
    }

    /// Whether `path` is contained in any root that admits `access`
    /// (ADR 0029): read-class access is admitted by write AND read roots;
    /// write-class access by write roots only.
    fn contained_in(&self, path: &Path, access: PathAccess) -> bool {
        match access {
            PathAccess::Read | PathAccess::ReadEntry => self
                .write_roots
                .iter()
                .chain(self.read_roots.iter())
                .any(|root| path.starts_with(root)),
            _ => self.write_roots.iter().any(|root| path.starts_with(root)),
        }
    }

    fn permits_existing_read(&self, path: &Path, operation: &str) -> Result<bool, ToolError> {
        let canonical = match std::fs::canonicalize(path) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(scope_io_error(
                    error,
                    operation,
                    path,
                    "candidate_resolution_failed",
                ));
            }
        };
        Ok(self.contained_in(&canonical, PathAccess::Read))
    }

    fn validate(
        &self,
        candidate: &Path,
        access: PathAccess,
        operation: &str,
    ) -> Result<PathBuf, ToolError> {
        let has_entry_suffix = access.operates_on_entry() && entry_suffix_free(candidate).is_some();
        let absolute = if has_entry_suffix {
            absolute_path_preserving_representation(candidate)
        } else {
            absolute_path(candidate)
        }
        .map_err(|error| {
            scope_io_error(error, operation, candidate, "candidate_resolution_failed")
        })?;

        if access.operates_on_entry() {
            let entry_path = entry_suffix_free(&absolute).unwrap_or_else(|| absolute.clone());
            let parent = entry_path.parent().ok_or_else(|| {
                self.outside_error(candidate, access, operation, "path_outside_workspace")
            })?;
            let containment_parent = match std::fs::canonicalize(parent) {
                Ok(canonical) => canonical,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.resolve_missing_intent(parent, candidate, access, operation, 0)?
                }
                Err(error) => {
                    return Err(scope_io_error(
                        error,
                        operation,
                        candidate,
                        "candidate_resolution_failed",
                    ));
                }
            };
            if !self.contained_in(&containment_parent, access) {
                return Err(self.outside_error(
                    candidate,
                    access,
                    operation,
                    "path_outside_workspace",
                ));
            }
            if access.requires_mutation_check() {
                self.reject_symlink_components(&entry_path, candidate, access, operation, true)?;
            }
            let entry_metadata = std::fs::symlink_metadata(&entry_path);
            if entry_metadata
                .as_ref()
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Ok(entry_path);
            }
        }

        let containment_path = match std::fs::canonicalize(&absolute) {
            Ok(canonical) => canonical,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.resolve_missing_intent(&absolute, candidate, access, operation, 0)?
            }
            Err(error) => {
                return Err(scope_io_error(
                    error,
                    operation,
                    candidate,
                    "candidate_resolution_failed",
                ));
            }
        };
        if !self.contained_in(&containment_path, access) {
            return Err(self.outside_error(candidate, access, operation, "path_outside_workspace"));
        }
        if access.requires_mutation_check() {
            self.reject_symlink_components(&absolute, candidate, access, operation, false)?;
        }
        // Canonical or intent-resolved form is only the containment proof.
        // Preserve the lexical target so no-follow callers retain directory
        // entry semantics and mutation checks still see lexical symlinks.
        Ok(absolute)
    }

    /// Resolve the intended location of a missing path without treating a
    /// dangling symlink as if its containing directory were the target's
    /// ancestor. This keeps an external dangling target from becoming an
    /// existence oracle while still allowing an internal missing target to
    /// reach the caller and produce `not_found`.
    fn resolve_missing_intent(
        &self,
        absolute: &Path,
        requested: &Path,
        access: PathAccess,
        operation: &str,
        symlink_depth: u32,
    ) -> Result<PathBuf, ToolError> {
        const MAX_SYMLINK_DEPTH: u32 = 40;
        if symlink_depth >= MAX_SYMLINK_DEPTH {
            return Err(ToolError::new(
                ToolErrorCode::IoError,
                operation,
                "too many symbolic links while resolving capability path",
            )
            .with_path(requested.to_string_lossy())
            .with_details(json!({ "reason": "candidate_resolution_failed" })));
        }

        let components = absolute.components().collect::<Vec<_>>();
        for split in (1..=components.len()).rev() {
            let prefix = components_to_path(&components[..split]);
            let suffix = components_to_path(&components[split..]);
            match std::fs::canonicalize(&prefix) {
                Ok(canonical_prefix) => {
                    let intent = normalize_from(&canonical_prefix, &suffix);
                    if intent == absolute {
                        return Ok(intent);
                    }
                    return match std::fs::canonicalize(&intent) {
                        Ok(canonical) => Ok(canonical),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => self
                            .resolve_missing_intent(
                                &intent,
                                requested,
                                access,
                                operation,
                                symlink_depth,
                            ),
                        Err(error) => Err(scope_io_error(
                            error,
                            operation,
                            requested,
                            "candidate_resolution_failed",
                        )),
                    };
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(scope_io_error(
                        error,
                        operation,
                        requested,
                        "candidate_resolution_failed",
                    ));
                }
            }

            let metadata = match std::fs::symlink_metadata(&prefix) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(scope_io_error(
                        error,
                        operation,
                        requested,
                        "candidate_resolution_failed",
                    ));
                }
            };
            if metadata.file_type().is_symlink() {
                let parent = prefix.parent().ok_or_else(|| {
                    self.outside_error(requested, access, operation, "path_outside_workspace")
                })?;
                let canonical_parent = std::fs::canonicalize(parent).map_err(|error| {
                    scope_io_error(error, operation, requested, "candidate_resolution_failed")
                })?;
                let target = std::fs::read_link(&prefix).map_err(|error| {
                    scope_io_error(error, operation, requested, "candidate_resolution_failed")
                })?;
                let target = if target.is_absolute() {
                    target
                } else {
                    canonical_parent.join(target)
                };
                let expanded = target.join(suffix);
                return match std::fs::canonicalize(&expanded) {
                    Ok(canonical) => Ok(canonical),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => self
                        .resolve_missing_intent(
                            &expanded,
                            requested,
                            access,
                            operation,
                            symlink_depth.saturating_add(1),
                        ),
                    Err(error) => Err(scope_io_error(
                        error,
                        operation,
                        requested,
                        "candidate_resolution_failed",
                    )),
                };
            }
        }

        Err(self.outside_error(requested, access, operation, "path_outside_workspace"))
    }

    fn resolve_base(&self, candidate: &Path, operation: &str) -> Result<PathBuf, ToolError> {
        // Validate the locator before canonicalizing it. In particular, an
        // alias to an external directory must not be accepted simply because
        // the resulting target is later used as a base rather than a file.
        let lexical = self.validate(candidate, PathAccess::Read, operation)?;
        match std::fs::canonicalize(&lexical) {
            // An existing base is a locator for this physical directory. Do
            // not retain an alias such as `/tmp/sub-link -> workspace/sub`,
            // because a later mutation would otherwise mistake that locator
            // symlink for a symlink beneath the effective base.
            Ok(canonical) => Ok(canonical),
            // Preserve the established behavior for bases that do not exist
            // yet. `validate` above has already proved their closest existing
            // ancestor is contained.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(lexical),
            Err(error) => Err(scope_io_error(
                error,
                operation,
                candidate,
                "candidate_resolution_failed",
            )),
        }
    }

    fn reject_symlink_components(
        &self,
        absolute: &Path,
        requested: &Path,
        access: PathAccess,
        operation: &str,
        allow_leaf_symlink: bool,
    ) -> Result<(), ToolError> {
        // The configured root is stored canonically, but callers may address
        // it through a valid symlink alias (notably macOS `/var` ->
        // `/private/var`). Find the lexical prefix whose canonical target is
        // exactly the capability root before inspecting descendants. This
        // permits the alias itself while still rejecting symlink components
        // below the workspace root.
        let lexical_root = self.lexical_workspace_root(
            absolute,
            requested,
            access,
            operation,
            allow_leaf_symlink,
        )?;
        let mut current = lexical_root.clone();
        let relative = absolute.strip_prefix(&lexical_root).map_err(|_| {
            self.outside_error(requested, access, operation, "path_outside_workspace")
        })?;
        let normal_component_count = relative
            .components()
            .filter(|component| matches!(component, Component::Normal(_)))
            .count();
        let mut normal_component_index = 0;
        for component in relative.components() {
            match component {
                Component::CurDir => continue,
                Component::ParentDir => {
                    current.pop();
                    continue;
                }
                Component::Normal(_) => {}
                Component::Prefix(_) | Component::RootDir => {
                    return Err(self.outside_error(
                        requested,
                        access,
                        operation,
                        "path_outside_workspace",
                    ));
                }
            }
            normal_component_index += 1;
            current.push(component.as_os_str());
            match std::fs::symlink_metadata(&current) {
                Ok(metadata)
                    if metadata.file_type().is_symlink()
                        && !(allow_leaf_symlink
                            && normal_component_index == normal_component_count) =>
                {
                    return Err(self.outside_error(requested, access, operation, "symlink_escape"));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => {
                    return Err(scope_io_error(
                        error,
                        operation,
                        requested,
                        "candidate_resolution_failed",
                    ));
                }
            }
        }
        Ok(())
    }

    fn lexical_workspace_root(
        &self,
        absolute: &Path,
        requested: &Path,
        access: PathAccess,
        operation: &str,
        skip_final_component: bool,
    ) -> Result<PathBuf, ToolError> {
        // The mutation machinery only ever runs against write-class roots, but
        // the helper stays access-aware so a future read-side caller cannot
        // silently treat a read root as a mutation alias base (ADR 0029).
        let roots: Vec<&Path> = match access {
            PathAccess::Read | PathAccess::ReadEntry => self
                .write_roots
                .iter()
                .chain(self.read_roots.iter())
                .map(PathBuf::as_path)
                .collect(),
            _ => self.write_roots.iter().map(PathBuf::as_path).collect(),
        };
        for root in roots {
            let mut current = PathBuf::new();
            let component_count = absolute.components().count();
            for (index, component) in absolute.components().enumerate() {
                current.push(component.as_os_str());
                // The leaf is the mutation target, not a workspace-root alias.
                // Do not canonicalize it here: doing so would follow the
                // symlink that DeleteEntry is specifically meant to unlink
                // without following.
                if skip_final_component && index + 1 == component_count {
                    break;
                }
                let canonical = match std::fs::canonicalize(&current) {
                    Ok(path) => path,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                    Err(error) => {
                        return Err(scope_io_error(
                            error,
                            operation,
                            requested,
                            "candidate_resolution_failed",
                        ));
                    }
                };
                if canonical == root {
                    return Ok(current);
                }
            }
        }
        Err(self.outside_error(requested, access, operation, "path_outside_workspace"))
    }

    fn outside_error(
        &self,
        requested: &Path,
        access: PathAccess,
        operation: &str,
        reason: &str,
    ) -> ToolError {
        ToolError::new(
            ToolErrorCode::OutsideCapability,
            operation,
            "path is outside the configured workspace capability",
        )
        .with_path(requested.to_string_lossy())
        .with_details(json!({
            "reason": reason,
            "access": access.as_str(),
            "workspace_root": self
                .first_write_root()
                .map(|root| root.to_string_lossy().into_owned())
                .unwrap_or_default(),
            "workspace_roots": self
                .write_roots
                .iter()
                .map(|root| root.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            "read_roots": self
                .read_roots
                .iter()
                .map(|root| root.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            "requested_path": requested.to_string_lossy(),
        }))
    }
}

fn components_to_path(components: &[Component<'_>]) -> PathBuf {
    components
        .iter()
        .fold(PathBuf::new(), |mut path, component| {
            path.push(component.as_os_str());
            path
        })
}

fn normalize_from(base: &Path, suffix: &Path) -> PathBuf {
    let mut normalized = base.to_path_buf();
    for component in suffix.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(_) => normalized.push(component.as_os_str()),
            Component::Prefix(_) | Component::RootDir => {
                normalized = PathBuf::from(component.as_os_str());
            }
        }
    }
    normalized
}

/// Make a locator absolute without normalizing its components. The operating
/// system resolves `..` after following the preceding symlink, so lexical
/// normalization here would change the path's meaning before capability
/// validation.
fn absolute_path(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    Ok(absolute
        .components()
        .filter(|component| !matches!(component, Component::CurDir))
        .fold(PathBuf::new(), |mut normalized, component| {
            normalized.push(component.as_os_str());
            normalized
        }))
}

fn absolute_path_preserving_representation(path: &Path) -> std::io::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

/// Preserve no-follow entry semantics when a locator uses a directory-style
/// suffix. On POSIX, `lstat("link/")` follows a directory symlink before
/// reporting metadata; Windows has analogous directory-link behavior. We can
/// safely remove the suffix only after checking the suffix-free spelling with
/// `symlink_metadata` and proving that the final entry itself is a symlink.
///
/// This is deliberately not a general path normalizer: ordinary files and
/// directories retain the caller's spelling, and `..` components are never
/// rewritten because their OS resolution order is semantically meaningful.
fn normalize_entry_symlink_locator(candidate: &Path) -> PathBuf {
    let Some(suffix_free) = entry_suffix_free(candidate) else {
        return candidate.to_path_buf();
    };

    match std::fs::symlink_metadata(&suffix_free) {
        Ok(metadata) if metadata.file_type().is_symlink() => suffix_free,
        _ => candidate.to_path_buf(),
    }
}

fn entry_suffix_free(candidate: &Path) -> Option<PathBuf> {
    let file_name = candidate.file_name()?;
    let parent = candidate.parent()?;

    let mut suffix_free = parent.to_path_buf();
    suffix_free.push(file_name);
    if suffix_free.as_os_str() == candidate.as_os_str() {
        return None;
    }
    Some(suffix_free)
}

fn scope_io_error(error: std::io::Error, operation: &str, path: &Path, reason: &str) -> ToolError {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => ToolErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ToolErrorCode::PermissionDenied,
        _ => ToolErrorCode::IoError,
    };
    ToolError::new(code, operation, error.to_string())
        .with_path(path.to_string_lossy())
        .with_raw_os_error(error.raw_os_error())
        .with_details(json!({ "reason": reason }))
}
