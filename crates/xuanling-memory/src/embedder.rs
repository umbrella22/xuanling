//! Protocol-neutral `Embedder` trait (plan §8.3, W6 C-07).
//!
//! This module exists only under the non-default `experimental-embeddings`
//! feature. It exposes no real model adapter and no downloader: the default
//! build carries no model runtime or network stack, and no model installation
//! flow is provided. [`NoopEmbedder`] always reports `unavailable` so semantic
//! recall is skipped and lexical results stand (plan §8.3, §13); tests use the
//! deterministic [`FakeEmbedder`].

use crate::error::{ToolError, ToolErrorCode};

/// A neutral embedder: maps texts to dense vectors.
pub trait Embedder: Send + Sync {
    /// Stable model id (e.g. `fastembed:BAAI/bge-small-en`).
    fn model_id(&self) -> &str;
    /// Configuration digest capturing model + dim + normalization; embedding
    /// rows whose digest differs are treated as stale (plan §8.3).
    fn config_digest(&self) -> String;
    /// Vector dimensionality.
    fn dimensions(&self) -> usize;
    /// Embed a batch of texts. On failure, the caller keeps lexical results.
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, ToolError>;
}

/// Default no-op embedder. Always reports `unavailable`; semantic recall is
/// skipped and lexical results stand. Used when no embedder feature is enabled.
#[derive(Debug, Default, Clone)]
pub struct NoopEmbedder;

impl Embedder for NoopEmbedder {
    fn model_id(&self) -> &str {
        "noop"
    }
    fn config_digest(&self) -> String {
        "noop:v1:0".to_string()
    }
    fn dimensions(&self) -> usize {
        0
    }
    fn embed(&self, _texts: &[String]) -> Result<Vec<Vec<f32>>, ToolError> {
        Err(ToolError::new(
            ToolErrorCode::Unsupported,
            "memory.embed",
            "no embedder configured (default build does not download models)",
        ))
    }
}

/// Deterministic embedder for tests. Hashes each text into a fixed-dimension
/// vector so results are reproducible without a real model. NOT for production.
#[derive(Debug, Clone)]
pub struct FakeEmbedder {
    dims: usize,
}

impl FakeEmbedder {
    pub fn new(dims: usize) -> Self {
        Self { dims: dims.max(1) }
    }
}

impl Embedder for FakeEmbedder {
    fn model_id(&self) -> &str {
        "fake"
    }
    fn config_digest(&self) -> String {
        format!("fake:v1:{}", self.dims)
    }
    fn dimensions(&self) -> usize {
        self.dims
    }
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, ToolError> {
        use sha2::{Digest, Sha256};
        Ok(texts
            .iter()
            .map(|t| {
                // Deterministic: hash the text, expand into `dims` floats in
                // [-1, 1], then L2-normalize so cosine is meaningful.
                let mut hasher = Sha256::new();
                hasher.update(t.as_bytes());
                // Stretch the 32-byte digest to `dims` by re-hashing.
                let mut bytes = hasher.finalize().to_vec();
                while bytes.len() < self.dims * 4 {
                    let mut h = Sha256::new();
                    h.update(&bytes);
                    bytes.extend_from_slice(&h.finalize());
                }
                let mut v: Vec<f32> = bytes
                    .chunks_exact(4)
                    .take(self.dims)
                    .map(|c| {
                        let n = u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
                        // Map to [-1, 1].
                        ((n as f64 / u32::MAX as f64) * 2.0 - 1.0) as f32
                    })
                    .collect();
                normalize(&mut v);
                v
            })
            .collect())
    }
}

/// Cosine similarity for normalized vectors; falls back to full cosine if not
/// normalized.
pub fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len().min(b.len());
    if n == 0 {
        return 0.0;
    }
    let dot: f64 = (0..n).map(|i| a[i] as f64 * b[i] as f64).sum();
    let na: f64 = (0..n).map(|i| (a[i] as f64).powi(2)).sum::<f64>().sqrt();
    let nb: f64 = (0..n).map(|i| (b[i] as f64).powi(2)).sum::<f64>().sqrt();
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na * nb)
}

fn normalize(v: &mut [f32]) {
    let norm: f64 = v.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x = (*x as f64 / norm) as f32;
        }
    }
}
