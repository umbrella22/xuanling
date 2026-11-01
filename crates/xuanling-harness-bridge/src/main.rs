//! Stdio entry point. Only MCP framing reaches stdout; diagnostics go to stderr
//! and never include worker output, environment values or secret material.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::Parser;
use rmcp::ServiceExt;

use xuanling_harness_bridge::config::RuntimeConfig;
use xuanling_harness_bridge::jobs::Registry;
use xuanling_harness_bridge::mcp::BridgeServer;

#[derive(Debug, Parser)]
#[command(
    name = "harness-bridge",
    version,
    about = "Result-only MCP bridge that runs a configured native worker harness"
)]
struct Cli {
    /// Trusted bridge configuration (JSON). Omit for an adapter-less instance.
    #[arg(long, value_name = "PATH")]
    config: Option<PathBuf>,
}

fn main() -> ExitCode {
    let filter = std::env::var("HARNESS_BRIDGE_LOG").unwrap_or_else(|_| "warn".to_string());
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
        .init();

    let cli = Cli::parse();
    let config = match RuntimeConfig::load(cli.config.as_deref()) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("harness-bridge: {error}");
            return ExitCode::from(2);
        }
    };

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("harness-bridge: runtime: {error}");
            return ExitCode::from(2);
        }
    };

    let code = runtime.block_on(async move {
        let registry = Arc::new(Registry::new(Arc::new(config)));
        let server = BridgeServer::new(registry.clone());
        let service = match server.serve(rmcp::transport::stdio()).await {
            Ok(service) => service,
            Err(error) => {
                tracing::error!("stdio transport failed: {error}");
                registry.shutdown().await;
                return 1;
            }
        };
        tokio::select! {
            result = service.waiting() => {
                if let Err(error) = result {
                    tracing::warn!("server task ended with an error: {error}");
                }
            }
            _ = shutdown_signal() => {
                tracing::info!("shutdown signal received");
            }
        }
        registry.shutdown().await;
        0
    });
    ExitCode::from(code)
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};

    match signal(SignalKind::terminate()) {
        Ok(mut terminate) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
        }
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
