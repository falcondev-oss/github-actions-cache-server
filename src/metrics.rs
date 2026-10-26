//! Prometheus metrics (ADR-0007, ADR-0008).

use prometheus::{IntCounter, IntCounterVec, IntGauge, Opts, Registry, TextEncoder};

use crate::db::Db;
use crate::error::Result;

/// Process-wide registry; scale with replicas and aggregate in `PromQL`.
#[derive(Debug)]
pub(crate) struct Metrics {
    registry: Registry,
    requests: IntCounterVec,
    uploads: IntCounter,
    storage_bytes: IntGauge,
}

/// Outcome of a download-URL lookup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LookupResult {
    Hit,
    Miss,
}

impl Metrics {
    pub(crate) fn new() -> Result<Self, prometheus::Error> {
        let registry = Registry::new();
        registry.register(Box::new(
            prometheus::process_collector::ProcessCollector::for_self(),
        ))?;
        let requests = IntCounterVec::new(
            Opts::new(
                "cache_requests_total",
                "Cache download-URL lookups by result. A restore-key prefix match counts as a hit.",
            ),
            &["result"],
        )?;
        // Materialise both series at 0 so dashboards see them before the first event.
        for result in ["hit", "miss"] {
            drop(requests.with_label_values(&[result]));
        }
        let uploads = IntCounter::new(
            "cache_uploads_total",
            "Cache uploads finalized into cache entries.",
        )?;
        let storage_bytes = IntGauge::new(
            "cache_storage_bytes",
            "Total bytes of finalized cache payloads tracked across storage locations.",
        )?;
        registry.register(Box::new(requests.clone()))?;
        registry.register(Box::new(uploads.clone()))?;
        registry.register(Box::new(storage_bytes.clone()))?;
        Ok(Self {
            registry,
            requests,
            uploads,
            storage_bytes,
        })
    }

    pub(crate) fn record_lookup(&self, result: LookupResult) {
        let label = match result {
            LookupResult::Hit => "hit",
            LookupResult::Miss => "miss",
        };
        self.requests.with_label_values(&[label]).inc();
    }

    pub(crate) fn record_upload(&self) {
        self.uploads.inc();
    }

    /// Renders the text exposition, computing storage bytes from the recorded payload sizes;
    /// rows predating size tracking read as 0 until reconciled on the next startup.
    pub(crate) async fn render(&self, db: &Db) -> Result<String> {
        self.storage_bytes.set(db.stored_bytes().await?);
        Ok(TextEncoder::new().encode_to_string(&self.registry.gather())?)
    }
}
