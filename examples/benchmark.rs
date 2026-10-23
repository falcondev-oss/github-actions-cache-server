//! Benchmarks cache server images side by side: startup, memory, CPU time, transfer speed and
//! lookup latency, measured from the host through each container's cgroup.
//!
//! ```sh
//! cargo run --release --example benchmark -- \
//!     node=ghcr.io/falcondev-oss/github-actions-cache-server:9.8.0 \
//!     rust=github-actions-cache-server:local
//! ```
//!
//! Needs Docker with cgroup v2 and the systemd cgroup driver (`/sys/fs/cgroup/system.slice`).
#![expect(
    unused_crate_dependencies,
    reason = "examples link the server's whole dependency list"
)]
#![expect(
    clippy::arithmetic_side_effects,
    clippy::as_conversions,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::float_arithmetic,
    clippy::integer_division,
    clippy::print_stdout,
    reason = "a measurement tool: statistics are floats and the report goes to stdout"
)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::{StreamExt as _, TryStreamExt as _, stream};
use serde_json::{Value, json};

const MIB: u64 = 1024 * 1024;
/// Large entries, uploaded and downloaded in parallel like a build matrix does.
const LARGE_ENTRIES: u64 = 8;
const LARGE_ENTRY_BYTES: u64 = 128 * MIB;
/// `@actions/cache` uploads in 32 MiB blocks.
const BLOCK_BYTES: u64 = 32 * MIB;
const LOOKUPS: usize = 5_000;
const LOOKUP_CONCURRENCY: usize = 64;
const SMALL_ENTRIES: usize = 300;
const SMALL_ENTRY_BYTES: u64 = 256 * 1024;
const SMALL_CONCURRENCY: usize = 32;
const CACHE_SERVICE: &str = "twirp/github.actions.results.api.v1.CacheService";

type Error = Box<dyn std::error::Error + Send + Sync>;
type Result<T, E = Error> = std::result::Result<T, E>;

/// A running server container, observed through its cgroup.
struct Server {
    id: String,
    volume: String,
    base_url: String,
    cgroup: PathBuf,
}

async fn docker(args: &[&str]) -> Result<String> {
    let output = tokio::process::Command::new("docker")
        .args(args)
        .output()
        .await?;
    if !output.status.success() {
        return Err(format!(
            "docker {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

impl Server {
    /// Starts the image and returns once `/health` answers, with the time that took.
    async fn start(
        label: &str,
        image: &str,
        port: u16,
        http: &reqwest::Client,
    ) -> Result<(Self, Duration)> {
        let volume = format!("gha-bench-{label}-{}", uuid::Uuid::new_v4());
        let base_url = format!("http://127.0.0.1:{port}");
        let started = Instant::now();
        let id = docker(&[
            "run",
            "-d",
            "-p",
            &format!("127.0.0.1:{port}:3000"),
            "-v",
            &format!("{volume}:/data"),
            "-e",
            &format!("API_BASE_URL={base_url}"),
            "-e",
            "PORT=3000",
            "-e",
            "SKIP_TOKEN_VALIDATION=true",
            "-e",
            "DISABLE_CLEANUP_JOBS=true",
            "-e",
            "STORAGE_DRIVER=filesystem",
            "-e",
            "STORAGE_FILESYSTEM_PATH=/data/storage",
            "-e",
            "DB_DRIVER=sqlite",
            "-e",
            "DB_SQLITE_PATH=/data/db.sqlite",
            image,
        ])
        .await?;
        loop {
            if http
                .get(format!("{base_url}/health"))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                break;
            }
            if started.elapsed() > Duration::from_secs(60) {
                return Err(format!("{label} did not become healthy").into());
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let startup = started.elapsed();
        let cgroup = PathBuf::from(format!("/sys/fs/cgroup/system.slice/docker-{id}.scope"));
        Ok((
            Self {
                id,
                volume,
                base_url,
                cgroup,
            },
            startup,
        ))
    }

    async fn stat(&self, file: &str, field: &str) -> Result<u64> {
        let stat = tokio::fs::read_to_string(self.cgroup.join(file)).await?;
        stat.lines()
            .find_map(|line| line.strip_prefix(field)?.strip_prefix(' ')?.parse().ok())
            .ok_or_else(|| format!("{field} missing in {file}").into())
    }

    /// CPU time of every process in the container, user and system.
    async fn cpu(&self) -> Result<Duration> {
        Ok(Duration::from_micros(
            self.stat("cpu.stat", "usage_usec").await?,
        ))
    }

    /// Anonymous memory: heaps and stacks, without the page cache of the data being written.
    async fn memory(&self) -> Result<u64> {
        self.stat("memory.stat", "anon").await
    }

    async fn stop(self) -> Result<()> {
        docker(&["rm", "-f", &self.id]).await?;
        docker(&["volume", "rm", &self.volume]).await?;
        Ok(())
    }
}

/// A protocol client doing what `@actions/cache` does.
#[derive(Clone)]
struct Client {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

impl Client {
    async fn twirp(&self, method: &str, body: Value) -> Result<Value> {
        let response = self
            .http
            .post(format!("{}/{CACHE_SERVICE}/{method}", self.base_url))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await?
            .error_for_status()?;
        Ok(response.json().await?)
    }

    async fn save(&self, key: &str, block: &Bytes, size: u64) -> Result<()> {
        let created = self
            .twirp("CreateCacheEntry", json!({ "key": key, "version": "v1" }))
            .await?;
        let url = created
            .get("signed_upload_url")
            .and_then(Value::as_str)
            .ok_or("no upload url")?;
        let mut index = 0_u64;
        let mut remaining = size;
        while remaining > 0 {
            let len = remaining.min(BLOCK_BYTES);
            let block_id = BASE64.encode(format!("{}{index:012}", uuid::Uuid::new_v4()));
            self.http
                .put(format!("{url}?comp=block&blockid={}", urlencode(&block_id)))
                .body(block.slice(..len as usize))
                .send()
                .await?
                .error_for_status()?;
            remaining -= len;
            index += 1;
        }
        self.http
            .put(format!("{url}?comp=blocklist"))
            .body("")
            .send()
            .await?
            .error_for_status()?;
        self.twirp(
            "FinalizeCacheEntryUpload",
            json!({ "key": key, "version": "v1", "size_bytes": size }),
        )
        .await?;
        Ok(())
    }

    async fn lookup(&self, key: &str, restore_keys: &[&str]) -> Result<Option<String>> {
        let found = self
            .twirp(
                "GetCacheEntryDownloadURL",
                json!({ "key": key, "restore_keys": restore_keys, "version": "v1" }),
            )
            .await?;
        Ok(found
            .get("signed_download_url")
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    /// Downloads an entry and returns its size.
    async fn restore(&self, key: &str) -> Result<u64> {
        let url = self
            .lookup(key, &[])
            .await?
            .ok_or_else(|| format!("cache miss for {key}"))?;
        let body = self
            .http
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .bytes_stream();
        Ok(body
            .try_fold(0_u64, |total, chunk| async move {
                Ok(total + chunk.len() as u64)
            })
            .await?)
    }
}

fn urlencode(value: &str) -> String {
    value
        .replace('+', "%2B")
        .replace('/', "%2F")
        .replace('=', "%3D")
}

fn token() -> Result<String> {
    let claims = json!({
        "ac": json!([{ "Scope": "refs/heads/main", "Permission": 3 }]).to_string(),
        "repository_id": "123",
    });
    Ok(jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(b"benchmark"),
    )?)
}

/// Incompressible bytes, so no layer can shortcut the transfer.
fn random_block() -> Bytes {
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    let mut block = Vec::with_capacity(BLOCK_BYTES as usize);
    while (block.len() as u64) < BLOCK_BYTES {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        block.extend_from_slice(&state.to_le_bytes());
    }
    Bytes::from(block)
}

/// Resource use while a phase ran.
#[derive(Clone, Copy, Default)]
struct Usage {
    wall: Duration,
    cpu: Duration,
    peak_memory: u64,
}

/// Runs `work` while sampling the container's memory every few milliseconds.
async fn measure<T>(server: &Server, work: impl Future<Output = Result<T>>) -> Result<(T, Usage)> {
    let peak = Arc::new(AtomicU64::new(server.memory().await?));
    let done = Arc::new(AtomicBool::new(false));
    let sampler = {
        let (peak, done, cgroup) = (Arc::clone(&peak), Arc::clone(&done), server.cgroup.clone());
        tokio::spawn(async move {
            let probe = Server {
                id: String::new(),
                volume: String::new(),
                base_url: String::new(),
                cgroup,
            };
            while !done.load(Ordering::Relaxed) {
                if let Ok(memory) = probe.memory().await {
                    peak.fetch_max(memory, Ordering::Relaxed);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
    };
    let (cpu_before, started) = (server.cpu().await?, Instant::now());
    let result = work.await;
    let wall = started.elapsed();
    let cpu = server.cpu().await?.saturating_sub(cpu_before);
    done.store(true, Ordering::Relaxed);
    sampler.await?;
    Ok((
        result?,
        Usage {
            wall,
            cpu,
            peak_memory: peak.load(Ordering::Relaxed),
        },
    ))
}

/// Every number reported for one image.
#[derive(Default)]
struct Report {
    image_bytes: u64,
    startup: Duration,
    idle_memory: u64,
    upload: Usage,
    cold_download: Usage,
    warm_download: Usage,
    lookup: Usage,
    lookup_p50: Duration,
    lookup_p99: Duration,
    small: Usage,
    total_cpu: Duration,
    peak_memory: u64,
}

async fn run(label: &str, image: &str, port: u16) -> Result<Report> {
    let http = reqwest::Client::builder()
        .pool_max_idle_per_host(256)
        .build()?;
    let image_bytes = docker(&["image", "inspect", "--format", "{{.Size}}", image])
        .await?
        .parse()?;
    let (server, startup) = Server::start(label, image, port, &http).await?;
    let report = exercise(&server, http, image_bytes, startup).await;
    server.stop().await?;
    report
}

/// Restore-key lookups that each miss the primary key and match by prefix.
async fn lookups(client: &Client) -> Result<Vec<Duration>> {
    let client = &client;
    stream::iter(0..LOOKUPS)
        .map(|index| async move {
            let started = Instant::now();
            let found = client
                .lookup(&format!("missing-{index}"), &["large-"])
                .await?;
            found.ok_or("restore key did not match")?;
            Ok::<_, Error>(started.elapsed())
        })
        .buffer_unordered(LOOKUP_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await
}

async fn exercise(
    server: &Server,
    http: reqwest::Client,
    image_bytes: u64,
    startup: Duration,
) -> Result<Report> {
    let client = Client {
        http,
        base_url: server.base_url.clone(),
        token: token()?,
    };
    let block = random_block();
    let cpu_at_start = server.cpu().await?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let idle_memory = server.memory().await?;

    let large_keys: Vec<String> = (0..LARGE_ENTRIES)
        .map(|index| format!("large-{index}"))
        .collect();
    let ((), upload) = measure(server, async {
        stream::iter(&large_keys)
            .map(|key| client.save(key, &block, LARGE_ENTRY_BYTES))
            .buffer_unordered(large_keys.len())
            .try_collect()
            .await
    })
    .await?;

    let download_all = || async {
        let sizes: Vec<u64> = stream::iter(&large_keys)
            .map(|key| client.restore(key))
            .buffer_unordered(large_keys.len())
            .try_collect()
            .await?;
        if sizes.iter().any(|&size| size != LARGE_ENTRY_BYTES) {
            return Err::<(), Error>(format!("short download: {sizes:?}").into());
        }
        Ok(())
    };
    // The first download of an entry concatenates its parts and merges them in the background.
    let ((), cold_download) = measure(server, download_all()).await?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let ((), warm_download) = measure(server, download_all()).await?;

    let (mut latencies, lookup) = measure(server, lookups(&client)).await?;
    latencies.sort_unstable();
    let percentile = |p: usize| {
        latencies
            .get(latencies.len() * p / 100)
            .copied()
            .unwrap_or_default()
    };

    let ((), small) = measure(server, async {
        stream::iter(0..SMALL_ENTRIES)
            .map(|index| {
                let (client, block) = (&client, &block);
                async move {
                    let key = format!("small-{index}");
                    client.save(&key, block, SMALL_ENTRY_BYTES).await?;
                    client.restore(&key).await?;
                    Ok::<_, Error>(())
                }
            })
            .buffer_unordered(SMALL_CONCURRENCY)
            .try_collect()
            .await
    })
    .await?;

    Ok(Report {
        image_bytes,
        startup,
        idle_memory,
        upload,
        cold_download,
        warm_download,
        lookup,
        lookup_p50: percentile(50),
        lookup_p99: percentile(99),
        small,
        total_cpu: server.cpu().await?.saturating_sub(cpu_at_start),
        peak_memory: server
            .stat("memory.stat", "anon")
            .await
            .ok()
            .into_iter()
            .chain([
                upload.peak_memory,
                cold_download.peak_memory,
                warm_download.peak_memory,
                lookup.peak_memory,
                small.peak_memory,
            ])
            .max()
            .unwrap_or_default(),
    })
}

fn mib(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / MIB as f64)
}

fn ms(duration: Duration) -> String {
    format!("{:.1} ms", duration.as_secs_f64() * 1000.0)
}

fn rate(bytes: u64, usage: Usage) -> String {
    format!(
        "{:.0} MiB/s",
        bytes as f64 / MIB as f64 / usage.wall.as_secs_f64()
    )
}

/// A report line: its label and how to render one image's value.
type Row = (&'static str, Box<dyn Fn(&Report) -> String>);

fn print_report(reports: &[(String, Report)]) {
    let large = LARGE_ENTRIES * LARGE_ENTRY_BYTES;
    let rows: [Row; 18] = [
        ("Image size", Box::new(|r| mib(r.image_bytes))),
        ("Startup to healthy", Box::new(|r| ms(r.startup))),
        ("Idle memory", Box::new(|r| mib(r.idle_memory))),
        ("Peak memory", Box::new(|r| mib(r.peak_memory))),
        (
            "Total CPU time",
            Box::new(|r| format!("{:.2} s", r.total_cpu.as_secs_f64())),
        ),
        (
            "Upload (8 × 128 MiB, parallel)",
            Box::new(move |r| rate(large, r.upload)),
        ),
        (
            "Upload CPU time",
            Box::new(|r| format!("{:.2} s", r.upload.cpu.as_secs_f64())),
        ),
        (
            "Upload peak memory",
            Box::new(|r| mib(r.upload.peak_memory)),
        ),
        (
            "First download (merge on read)",
            Box::new(move |r| rate(large, r.cold_download)),
        ),
        (
            "First download CPU time",
            Box::new(|r| format!("{:.2} s", r.cold_download.cpu.as_secs_f64())),
        ),
        (
            "First download peak memory",
            Box::new(|r| mib(r.cold_download.peak_memory)),
        ),
        (
            "Later download (merged)",
            Box::new(move |r| rate(large, r.warm_download)),
        ),
        (
            "Later download CPU time",
            Box::new(|r| format!("{:.2} s", r.warm_download.cpu.as_secs_f64())),
        ),
        (
            "Lookups per second (64 concurrent)",
            Box::new(|r| format!("{:.0}", LOOKUPS as f64 / r.lookup.wall.as_secs_f64())),
        ),
        ("Lookup p50", Box::new(|r| ms(r.lookup_p50))),
        ("Lookup p99", Box::new(|r| ms(r.lookup_p99))),
        (
            "Small save+restore per second (256 KiB, 32 concurrent)",
            Box::new(|r| format!("{:.0}", SMALL_ENTRIES as f64 / r.small.wall.as_secs_f64())),
        ),
        (
            "Small save+restore CPU time",
            Box::new(|r| format!("{:.2} s", r.small.cpu.as_secs_f64())),
        ),
    ];
    let labels: Vec<&str> = reports.iter().map(|(label, _)| label.as_str()).collect();
    println!("| Metric | {} |", labels.join(" | "));
    println!("|---|{}", "---|".repeat(labels.len()));
    for (name, value) in &rows {
        let cells: Vec<String> = reports.iter().map(|(_, report)| value(report)).collect();
        println!("| {name} | {} |", cells.join(" | "));
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let images: Vec<(String, String)> = std::env::args()
        .skip(1)
        .map(|arg| {
            arg.split_once('=')
                .map(|(label, image)| (label.to_owned(), image.to_owned()))
                .ok_or_else(|| format!("expected label=image, got {arg}"))
        })
        .collect::<Result<_, _>>()?;
    if images.is_empty() {
        return Err("usage: benchmark label=image [label=image ...]".into());
    }
    let mut reports = Vec::new();
    for (index, (label, image)) in images.iter().enumerate() {
        println!("benchmarking {label} ({image})");
        let port = 3990 + u16::try_from(index)?;
        reports.push((label.clone(), run(label, image, port).await?));
    }
    print_report(&reports);
    Ok(())
}
