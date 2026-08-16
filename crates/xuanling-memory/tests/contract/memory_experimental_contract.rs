//! W6 experimental-embeddings isolation contract tests (plan W6, C-07).
//!
//! The default build must carry no model runtime, downloader, or network
//! stack, and the MCP catalog must expose no semantic tool. The non-default
//! `experimental-embeddings` feature only exposes the protocol-neutral trait
//! and deterministic test doubles; embedder failure must leave lexical recall
//! untouched.

use std::process::Command;

/// Crates that would indicate a model runtime, downloader, or network stack
/// leaking into the default build. Blocked crates are matched as `name v…`
/// dependency-tree lines.
const FORBIDDEN: &[&str] = &[
    "fastembed",
    "tokenizers",
    "candle-core",
    "candle",
    "ort",
    "tract",
    "onnxruntime",
    "hf-hub",
    "reqwest",
    "hyper",
    "ureq",
    "openai",
    "ollama",
    "rust-bert",
    "burn",
];

fn dependency_tree(features: &[&str]) -> String {
    let mut cmd = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string()));
    cmd.args(["tree", "-p", "xuanling-memory", "-e", "normal"]);
    for feature in features {
        cmd.args(["--features", feature]);
    }
    let output = cmd
        .output()
        .unwrap_or_else(|e| panic!("failed to run cargo tree: {e}"));
    assert!(
        output.status.success(),
        "cargo tree failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// C-07: the default dependency tree contains no model runtime, downloader,
/// or HTTP/network crate.
#[test]
fn default_build_has_no_model_runtime_or_downloader() {
    let tree = dependency_tree(&[]);
    let violations: Vec<String> = tree
        .lines()
        .filter(|line| FORBIDDEN.iter().any(|f| line.contains(&format!("{f} v"))))
        .map(str::to_owned)
        .collect();
    assert!(
        violations.is_empty(),
        "default build pulls in model-runtime/downloader/network crates:\n{}\nFull tree:\n{tree}",
        violations.join("\n")
    );
}

/// C-07: the default build exposes no embedder API surface — the module must
/// not even compile (checked by the absence of the symbol at link time is not
/// observable here; instead the catalog-side test asserts the tool surface).
#[test]
fn experimental_feature_tree_stays_within_the_same_dependency_island() {
    // With the feature enabled the island must not grow a model runtime or a
    // network stack either: the feature only unlocks local, protocol-neutral
    // code (no real adapter ships).
    let tree = dependency_tree(&["experimental-embeddings"]);
    let violations: Vec<String> = tree
        .lines()
        .filter(|line| FORBIDDEN.iter().any(|f| line.contains(&format!("{f} v"))))
        .map(str::to_owned)
        .collect();
    assert!(
        violations.is_empty(),
        "experimental-embeddings must not add model/downloader crates:\n{}\nFull tree:\n{tree}",
        violations.join("\n")
    );
}

/// C-07 path scan: no network, downloader, or model-cache path may exist in
/// this crate's source — the default build must stay offline-capable.
#[test]
fn default_source_has_no_network_or_model_cache_paths() {
    let markers = [
        "https://",
        "http://",
        "std::net",
        "TcpStream",
        "TcpListener",
        "UdpSocket",
        "reqwest",
        "ureq",
        "curl",
        "wget",
        "hf_hub",
        "HF_HOME",
    ];
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut hits = Vec::new();
    for entry in walk(&src) {
        let text = std::fs::read_to_string(&entry).expect("read source");
        for (line_number, line) in text.lines().enumerate() {
            for marker in markers {
                if line.contains(marker) {
                    hits.push(format!("{}:{}: {marker}", entry.display(), line_number + 1));
                }
            }
        }
    }
    assert!(
        hits.is_empty(),
        "network/downloader paths found in memory crate source:\n{}",
        hits.join("\n")
    );
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).expect("read src dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    out
}

/// Deterministic fake embedder: identical inputs produce identical vectors,
/// and different inputs stay dissimilar (cosine < 1 after L2 normalization).
#[cfg(feature = "experimental-embeddings")]
#[test]
fn fake_embedder_is_deterministic_and_discriminates() {
    use xuanling_memory::embedder::{Embedder, FakeEmbedder, cosine};

    let embedder = FakeEmbedder::new(16);
    let a1 = embedder.embed(&["cargo build".to_string()]).unwrap();
    let a2 = embedder.embed(&["cargo build".to_string()]).unwrap();
    let b = embedder.embed(&["npm install".to_string()]).unwrap();
    assert_eq!(a1[0], a2[0], "same input must produce identical vectors");
    let similarity = cosine(&a1[0], &b[0]);
    assert!(similarity < 1.0, "different inputs must not be identical");
    assert_eq!(embedder.model_id(), "fake");
    assert_eq!(embedder.dimensions(), 16);
}

/// The stale-configuration mechanism (plan §8.3) survives at the trait level:
/// a different configuration must yield a different digest, the same
/// configuration must be stable. (No embedding rows exist in the v2 schema,
/// so there is no persistence-side stale-revision path to test.)
#[cfg(feature = "experimental-embeddings")]
#[test]
fn fake_embedder_config_digest_is_stable_per_configuration() {
    use xuanling_memory::embedder::{Embedder, FakeEmbedder};

    let digest = FakeEmbedder::new(8).config_digest();
    assert_eq!(FakeEmbedder::new(8).config_digest(), digest);
    assert_ne!(
        FakeEmbedder::new(9).config_digest(),
        digest,
        "dimension change must invalidate the digest"
    );
}

/// Semantic failure must preserve lexical results: the no-op embedder returns
/// a typed `unsupported` error and an identical lexical search still returns
/// the same items.
#[cfg(feature = "experimental-embeddings")]
#[tokio::test]
async fn experimental_failure_preserves_lexical_results() {
    use xuanling_memory::embedder::{Embedder, NoopEmbedder};
    use xuanling_memory::proposal::{
        CandidateCreateRequest, MemoryPayload, ReviewDecision, ReviewRequest, ScopeMode,
        SearchRequestV2,
    };
    use xuanling_memory::scope::MemoryScope;
    use xuanling_memory::{MemoryKind, MemoryStore, ToolErrorCode};

    let store = MemoryStore::open_in_memory().await.unwrap();
    let payload = MemoryPayload {
        kind: MemoryKind::Fact,
        title: Some("title".to_string()),
        content: "cargo build caches artifacts".to_string(),
        summary: None,
        tags: vec![],
        applicability: Default::default(),
        pinned: false,
    };
    store
        .candidate_create(&CandidateCreateRequest {
            proposal_id: "p1".to_string(),
            idempotency_key: "idem-1".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: MemoryScope::Global,
            payload,
        })
        .await
        .unwrap();
    store
        .review(&ReviewRequest {
            idempotency_key: "review-1".to_string(),
            reviewer_id: "reviewer".to_string(),
            namespace: "ns".to_string(),
            scope: MemoryScope::Global,
            proposal_id: "p1".to_string(),
            expected_proposal_revision: 1,
            decision: ReviewDecision::Approve,
            comment: None,
        })
        .await
        .unwrap();

    let request = SearchRequestV2 {
        namespace: "ns".to_string(),
        scope: MemoryScope::Global,
        scope_mode: ScopeMode::Exact,
        query: "cargo build".to_string(),
        applicability: None,
        candidate_limit: 10,
        limit: 5,
    };
    let before = store.search_v2(&request).await.unwrap();

    // The semantic path fails with a typed, non-fatal error…
    let error = NoopEmbedder
        .embed(&["cargo build".to_string()])
        .unwrap_err();
    assert_eq!(error.code, ToolErrorCode::Unsupported);
    assert_eq!(error.operation, "memory.embed");

    // …and lexical recall is byte-identical afterwards.
    let after = store.search_v2(&request).await.unwrap();
    assert_eq!(
        serde_json::to_string(&before).unwrap(),
        serde_json::to_string(&after).unwrap(),
        "semantic failure must not disturb lexical results"
    );
}
