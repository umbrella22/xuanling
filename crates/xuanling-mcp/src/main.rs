//! `xuanling-mcp` binary entrypoint (plan §9.1).
//!
//! Runs the local stdio MCP server. All diagnostics/tracing go to stderr so
//! stdout carries only MCP framing (plan §9.2).

use std::path::{Path, PathBuf};

use clap::Parser;
use rmcp::ServiceExt;
use xuanling_mcp::{ToolProfile, ToolProfileSelection, XuanlingServer};
use xuanling_toolkit::FilesystemScope;

#[derive(Debug, Parser)]
#[command(
    name = "xuanling-mcp",
    version,
    about = "Local stdio MCP server for XuanLing's typed tools"
)]
struct Cli {
    /// Default resolution context for relative tool paths (not a sandbox).
    #[arg(long, value_name = "PATH")]
    base_dir: Option<PathBuf>,

    /// SQLite database shared by the memory tools.
    #[arg(long, value_name = "PATH")]
    memory_db: Option<PathBuf>,

    /// Convenience namespace used when a memory request omits one.
    #[arg(long, value_name = "VALUE")]
    default_namespace: Option<String>,

    /// SQLite busy timeout in milliseconds.
    #[arg(long, value_name = "MILLISECONDS", default_value_t = 5000)]
    sqlite_busy_timeout_ms: u32,

    /// Tool groups exposed through discovery and dispatch. Repeat to combine
    /// groups. Defaults to all for backward compatibility.
    #[arg(long, value_enum, value_name = "PROFILE")]
    tool_profile: Vec<ToolProfile>,

    /// Restrict server-opened filesystem write paths to these directories
    /// (repeatable, ADR 0029). Reads are additionally permitted inside
    /// `--read-root` directories. With neither flag the scope is unrestricted.
    #[arg(long, value_name = "PATH")]
    workspace_root: Vec<PathBuf>,

    /// Additional read-only capability roots (repeatable, ADR 0029): the
    /// server may read/list/search/hash these directories but never write,
    /// delete, or use them as a child process cwd.
    #[arg(long, value_name = "PATH")]
    read_root: Vec<PathBuf>,

    /// ZCode compatibility shim (C-16): accept JSON-encoded STRINGS for
    /// parameters whose schema resolves to an object (the ZCode host's
    /// argument coercion does not resolve `$ref` schemas and stringifies
    /// them). Default OFF — the strict schema contract stays the default.
    #[arg(long)]
    compat_lenient_object_params: bool,

    /// Optional maintenance subcommand. Without a subcommand the binary runs
    /// the stdio MCP server.
    #[command(subcommand)]
    command: Option<CliCommand>,
}

/// Root maintenance group: `xuanling-mcp memory <subcommand>` (plan §6).
#[derive(Debug, clap::Subcommand)]
enum CliCommand {
    /// Canonical memory database maintenance (export/import/rebuild-index).
    Memory {
        /// Memory maintenance operation (plan §6).
        #[command(subcommand)]
        command: MemoryCommand,
    },
}

/// `xuanling-mcp memory <subcommand>` maintenance surface (plan §6).
#[derive(Debug, clap::Subcommand)]
enum MemoryCommand {
    /// Export the canonical memory tables to a versioned JSONL file. The
    /// output is written atomically; an existing target is refused.
    Export {
        /// Destination JSONL file (must not exist).
        #[arg(long, value_name = "FILE")]
        output: PathBuf,
    },
    /// Import a canonical JSONL file into an EMPTY memory database after full
    /// validation; any failure leaves the target empty.
    Import {
        /// Source JSONL file.
        #[arg(long, value_name = "FILE")]
        input: PathBuf,
    },
    /// Rebuild the derived FTS projection from canonical rows. Canonical
    /// tables are never modified.
    RebuildIndex,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init()
        .ok();

    // Keep the CLI-supplied path unresolved for the stdio server. Opening (and
    // even creating the parent of) the default database is deferred until a
    // memory tool is actually called. Maintenance commands remain explicitly
    // eager because opening their target is the command's requested effect.
    let memory_db_arg = cli.memory_db;

    // Maintenance subcommands complete and exit; without one, the stdio
    // MCP server runs (below).
    if let Some(CliCommand::Memory { command }) = cli.command {
        let memory_db = memory_db_arg
            .or_else(xuanling_memory::default_db_path)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "unavailable: cannot resolve the default memory DB path (HOME/USERPROFILE); \
                     pass an explicit --memory-db"
                )
            })?;
        return run_memory_command(command, &memory_db, cli.sqlite_busy_timeout_ms).await;
    }
    let default_namespace = cli.default_namespace;
    let tool_profiles = ToolProfileSelection::new(cli.tool_profile);

    let filesystem_scope = if cli.workspace_root.is_empty() && cli.read_root.is_empty() {
        FilesystemScope::Unrestricted
    } else {
        FilesystemScope::workspace_with_read_roots(&cli.workspace_root, &cli.read_root).map_err(
            |error| anyhow::anyhow!("invalid --workspace-root/--read-root configuration: {error}"),
        )?
    };
    // `--base-dir` remains a locator setting. In contained mode, default it to
    // the first workspace root (ADR 0029) so `--workspace-root <dir>` is
    // useful on its own.
    let path_context = match cli
        .base_dir
        .or_else(|| filesystem_scope.first_workspace_root().map(PathBuf::from))
    {
        Some(base) => xuanling_toolkit::path::PathContext::new(base),
        None => xuanling_toolkit::path::PathContext::default(),
    };
    if filesystem_scope.is_contained() {
        xuanling_toolkit::InvocationContext::new(path_context.clone())
            .with_filesystem_scope(filesystem_scope.clone())
            .resolve_path(
                &PathBuf::from("."),
                None,
                xuanling_toolkit::PathAccess::Read,
                "cli.base_dir",
            )
            .map_err(|error| anyhow::anyhow!("--base-dir is outside --workspace-root: {error}"))?;
    }

    // The stdio server owns a lazy memory capability. A bad or unavailable
    // database is reported when a memory tool is requested; unrelated tools
    // remain usable and startup has no durable memory side effect.
    let server = XuanlingServer::with_lazy_memory(
        memory_db_arg,
        cli.sqlite_busy_timeout_ms,
        path_context,
        filesystem_scope,
        default_namespace,
        tool_profiles,
    )
    .with_compat_lenient_object_params(cli.compat_lenient_object_params);

    let service = server.serve(rmcp::transport::stdio()).await?;
    let _ = service.waiting().await;
    Ok(())
}

/// Execute a `memory` maintenance subcommand: single-line JSON summary on
/// stdout, diagnostics on stderr, nonzero exit on failure (plan §6).
async fn run_memory_command(
    command: MemoryCommand,
    memory_db: &Path,
    busy_timeout_ms: u32,
) -> anyhow::Result<()> {
    let store = xuanling_memory::MemoryStore::open(memory_db, busy_timeout_ms)
        .await
        .map_err(|e| anyhow::anyhow!("memory store: {e}"))?;
    let summary = match command {
        MemoryCommand::Export { output } => {
            let lines = xuanling_memory::jsonl::export(&store, &output)
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            serde_json::json!({
                "command": "memory_export",
                "output": output.display().to_string(),
                "entity_lines": lines,
                "format_version": xuanling_memory::jsonl::FORMAT_VERSION,
                "schema_version": xuanling_memory::jsonl::SCHEMA_VERSION,
            })
        }
        MemoryCommand::Import { input } => {
            let lines = xuanling_memory::jsonl::import(&store, &input)
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            serde_json::json!({
                "command": "memory_import",
                "input": input.display().to_string(),
                "entity_lines": lines,
            })
        }
        MemoryCommand::RebuildIndex => {
            let rebuilt = store
                .rebuild_projection()
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            serde_json::json!({
                "command": "memory_rebuild_index",
                "active_records_indexed": rebuilt,
            })
        }
    };
    println!("{summary}");
    Ok(())
}
