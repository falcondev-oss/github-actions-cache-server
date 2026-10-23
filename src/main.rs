//! Self-hosted drop-in replacement for the GitHub Actions cache server.

mod cleanup;
mod config;
mod db;
mod error;
mod http;
mod metrics;
mod routes;
mod scope;
mod storage;
#[cfg(test)]
mod tests;
mod twirp;

use std::io::IsTerminal as _;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::process::ExitCode;
use std::sync::Arc;

use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::cleanup::Cleanup;
use crate::config::Config;
use crate::db::Db;
use crate::error::Result;
use crate::metrics::Metrics;
use crate::routes::{AppState, router};
use crate::scope::TokenVerifier;
use crate::storage::{Adapter, Storage};

fn version() -> String {
    let version = env!("CARGO_PKG_VERSION");
    option_env!("BUILD_HASH").map_or_else(
        || format!("v{version}"),
        |hash| format!("v{version} [{hash}]"),
    )
}

/// Wires every component from configuration and a storage adapter; shared by `main` and the
/// tests, which isolate storage per test.
async fn build_state(config: Config, adapter: Adapter) -> Result<AppState> {
    let config = Arc::new(config);
    let (db, requires_storage_clear) = Db::connect(&config.db).await?;
    // Clear before `Storage::new` reconciles sizes against what is stored.
    if requires_storage_clear {
        adapter.clear().await?;
    }
    let storage = Arc::new(Storage::new(db, adapter, Arc::clone(&config)).await?);
    Ok(AppState {
        verifier: Arc::new(TokenVerifier::new(&config)?),
        metrics: Arc::new(Metrics::new()?),
        cleanup: Arc::new(Cleanup::new(Arc::clone(&storage), &config)),
        storage,
        // Results Passthrough relays redirects instead of following them.
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        config,
    })
}

async fn shutdown_signal() {
    let interrupt = tokio::signal::ctrl_c();
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => drop(terminate.recv().await),
            Err(error) => {
                tracing::warn!(%error, "cannot listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        result = interrupt => {
            if let Err(error) = result {
                tracing::warn!(%error, "cannot listen for SIGINT");
            }
        }
        () = terminate => {}
    }
}

async fn serve(config: Config) -> Result<()> {
    tracing::info!("🚀 Starting GitHub Actions Cache Server ({})", version());
    let (host, port) = (config.host.clone(), config.port);
    let adapter = Adapter::from_config(&config.storage).await?;
    let state = build_state(config, adapter).await?;
    let listener = match host {
        Some(host) => TcpListener::bind((host.as_str(), port)).await?,
        None => match TcpListener::bind((Ipv6Addr::UNSPECIFIED, port)).await {
            Ok(listener) => listener,
            // Hosts without IPv6 cannot bind the default dual-stack address.
            Err(error) => {
                tracing::debug!(%error, "IPv6 unavailable, listening on IPv4");
                TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await?
            }
        },
    };
    state.cleanup.spawn_schedules();
    let storage = Arc::clone(&state.storage);
    tracing::info!(address = %listener.local_addr()?, "listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("waiting for ongoing merges");
    storage.wait_for_ongoing_merges().await;
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            tracing_subscriber::fmt().init();
            tracing::error!(%error, "failed to start");
            return ExitCode::FAILURE;
        }
    };
    let filter = EnvFilter::new(if config.debug { "debug" } else { "info" })
        .add_directive("sqlx=warn".parse().unwrap_or_default())
        .add_directive("hyper=info".parse().unwrap_or_default());
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        // Container log collectors would store colour codes verbatim.
        .with_ansi(std::io::stdout().is_terminal())
        .init();
    match serve(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "server stopped");
            ExitCode::FAILURE
        }
    }
}
