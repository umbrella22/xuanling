//! Secret redaction for worker text and failure diagnostics.
//!
//! The redactor receives only environment *values* whose names the trusted
//! configuration marks as secret. It never reads a credential file and never
//! persists or logs the original value; callers only see the boolean that says
//! whether something was replaced.

use regex::Regex;

const MASK: &str = "[REDACTED]";

/// Replaces configured secret values and a small set of well-known token
/// shapes with [`MASK`].
pub struct Redactor {
    secrets: Vec<String>,
    patterns: Vec<Regex>,
}

impl Redactor {
    /// Build a redactor from environment variable names marked secret.
    ///
    /// Empty and very short values are ignored so that a misconfigured name
    /// cannot rewrite ordinary prose.
    pub fn from_env_names(names: &[String]) -> Self {
        let mut secrets = Vec::new();
        for name in names {
            if let Ok(value) = std::env::var(name)
                && value.len() >= 8
                && !secrets.iter().any(|existing| existing == &value)
            {
                secrets.push(value);
            }
        }
        // Longest first so an overlapping shorter value cannot mask part of a
        // longer configured secret.
        secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));

        let patterns = [
            r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{16,}",
            r"\bsk-[A-Za-z0-9_-]{16,}",
            r#"(?i)\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{16,}"#,
        ]
        .iter()
        .filter_map(|pattern| Regex::new(pattern).ok())
        .collect();

        Self { secrets, patterns }
    }

    /// Return the redacted text and whether any replacement happened.
    pub fn redact(&self, input: &str) -> (String, bool) {
        self.redact_with_prefix(input, 0)
    }

    /// Merge masks against the original text. Replacing one secret first must
    /// not split another known secret or a token pattern that overlaps it.
    fn redact_with_prefix(&self, input: &str, masked_prefix: usize) -> (String, bool) {
        let mut ranges = Vec::new();
        if masked_prefix > 0 {
            ranges.push((0, masked_prefix));
        }
        for secret in &self.secrets {
            let mut offset = 0;
            while let Some(found) = input[offset..].find(secret) {
                let start = offset + found;
                ranges.push((start, start + secret.len()));
                // Include overlapping occurrences of the same secret.
                offset = start + input[start..].chars().next().unwrap().len_utf8();
            }
        }
        for pattern in &self.patterns {
            ranges.extend(
                pattern
                    .find_iter(input)
                    .map(|found| (found.start(), found.end())),
            );
        }
        if ranges.is_empty() {
            return (input.to_string(), false);
        }
        ranges.sort_unstable();
        let mut output = String::new();
        let mut copied = 0;
        let (mut start, mut end) = ranges[0];
        for (next_start, next_end) in ranges.into_iter().skip(1) {
            if next_start <= end {
                end = end.max(next_end);
            } else {
                output.push_str(&input[copied..start]);
                output.push_str(MASK);
                copied = end;
                (start, end) = (next_start, next_end);
            }
        }
        output.push_str(&input[copied..start]);
        output.push_str(MASK);
        output.push_str(&input[end..]);
        (output, true)
    }

    /// Redact a bounded raw stderr tail, including a configured secret whose
    /// beginning was discarded. Work on bytes before UTF-8 decoding so a cut
    /// through a multibyte secret cannot hide its retained suffix.
    pub(crate) fn redact_tail(&self, input: &[u8], clipped_start: bool) -> (String, bool) {
        let overlap = if clipped_start {
            self.secrets
                .iter()
                .map(|secret| suffix_prefix_overlap(secret.as_bytes(), input))
                .max()
                .unwrap_or(0)
        } else {
            0
        };
        let text = String::from_utf8_lossy(input);
        let mut masked_prefix = String::from_utf8_lossy(&input[..overlap]).len();
        if clipped_start && !self.patterns.is_empty() {
            // A discarded marker (`sk-`, `Bearer`, `api_key=`, etc.) cannot
            // be reconstructed from its token suffix. Omit the ambiguous
            // leading span, including whitespace/quotes that can occur inside
            // these patterns; preserve text after the first clear delimiter.
            let pattern_prefix = text
                .char_indices()
                .find_map(|(index, ch)| {
                    let may_continue_pattern = ch.is_ascii_alphanumeric()
                        || ch.is_whitespace()
                        || "._~+/-:='\"".contains(ch)
                        || ch == char::REPLACEMENT_CHARACTER;
                    (!may_continue_pattern).then_some(index)
                })
                .unwrap_or(text.len());
            masked_prefix = masked_prefix.max(pattern_prefix);
        }
        self.redact_with_prefix(&text, masked_prefix)
    }
}

/// Longest prefix of `tail` that is a suffix of `secret`. The prefix table
/// keeps this linear even for long, repetitive configured secrets.
fn suffix_prefix_overlap(secret: &[u8], tail: &[u8]) -> usize {
    let prefix = &tail[..tail.len().min(secret.len())];
    if prefix.is_empty() {
        return 0;
    }
    let mut fallback = vec![0; prefix.len()];
    let mut matched = 0;
    for index in 1..prefix.len() {
        while matched > 0 && prefix[index] != prefix[matched] {
            matched = fallback[matched - 1];
        }
        if prefix[index] == prefix[matched] {
            matched += 1;
        }
        fallback[index] = matched;
    }
    matched = 0;
    for &byte in secret {
        while matched > 0 && (matched == prefix.len() || byte != prefix[matched]) {
            matched = fallback[matched - 1];
        }
        if byte == prefix[matched] {
            matched += 1;
        }
    }
    matched
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_configured_secret_and_known_shapes() {
        let redactor = Redactor {
            secrets: vec!["super-secret-value".to_string()],
            patterns: vec![Regex::new(r"\bsk-[A-Za-z0-9_-]{16,}").unwrap()],
        };
        let (text, changed) =
            redactor.redact("key=super-secret-value token sk-abcdefghijklmnopqrstuvwxyz");
        assert!(changed);
        assert!(!text.contains("super-secret-value"));
        assert!(!text.contains("sk-abcdefghijklmnopqrstuvwxyz"));
        assert_eq!(text.matches(MASK).count(), 2);
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        let redactor = Redactor {
            secrets: Vec::new(),
            patterns: vec![Regex::new(r"\bsk-[A-Za-z0-9_-]{16,}").unwrap()],
        };
        let (text, changed) = redactor.redact("tests passed: 12 assertions");
        assert!(!changed);
        assert_eq!(text, "tests passed: 12 assertions");
    }

    #[test]
    fn stderr_tail_masks_every_secret_cut_and_chunk_boundary() {
        use crate::collector::TailBuffer;
        for secret in [
            "SyntheticCredential0123456789ABCDEF",
            "密钥-🔑-abcdef-凭据",
            "abababababababab",
        ] {
            let redactor = Redactor {
                secrets: vec![secret.to_string()],
                patterns: vec![],
            };
            let trailing = " ordinary diagnostic";
            let stream = format!("discarded-prefix:{secret}{trailing}");
            for cut in 0..secret.len() {
                for chunk_size in [1, 7, stream.len()] {
                    let mut tail = TailBuffer::new(secret.len() - cut + trailing.len());
                    for chunk in stream.as_bytes().chunks(chunk_size) {
                        tail.push(chunk);
                    }
                    let (text, redacted) = tail.redacted_text(&redactor);
                    assert!(redacted, "cut={cut} chunk_size={chunk_size}");
                    assert_eq!(text.as_deref(), Some(format!("{MASK}{trailing}").as_str()));
                }
            }
            let (unchanged, changed) = redactor.redact_tail(b"ordinary diagnostic", false);
            assert_eq!(unchanged, "ordinary diagnostic");
            assert!(!changed);
        }
    }

    #[test]
    fn clipped_secret_cannot_split_an_overlapping_known_secret() {
        let redactor = Redactor {
            secrets: vec![
                "discarded-prefix-ABCD".into(),
                "CD-second-credential".into(),
            ],
            patterns: vec![],
        };
        let (text, changed) = redactor.redact_tail(b"ABCD-second-credential end", true);
        assert!(changed);
        assert_eq!(text, "[REDACTED] end");
    }

    #[test]
    fn clipped_token_patterns_cannot_lose_their_markers() {
        let redactor = Redactor::from_env_names(&[]);
        for original in [
            "sk-SyntheticUnconfiguredToken0123456789",
            "Bearer SyntheticUnconfiguredToken0123456789",
            "api_key = 'SyntheticUnconfiguredToken0123456789",
            "client-secret\n=\n\"SyntheticUnconfiguredToken0123456789",
            "Bearer\u{2003}SyntheticUnconfiguredToken0123456789",
        ] {
            assert!(
                redactor.redact(original).1,
                "fixture must match an existing pattern"
            );
            let raw = format!("{original}| diagnostic preserved");
            for cut in 0..original.len() {
                let (text, changed) = redactor.redact_tail(&raw.as_bytes()[cut..], true);
                assert!(changed, "cut={cut}");
                assert_eq!(text, "[REDACTED]| diagnostic preserved", "cut={cut}");
            }
        }
    }

    #[test]
    fn all_native_collectors_redact_before_diagnostic_limits() {
        use crate::adapters::{
            claude::ClaudeCollector, codex::CodexCollector, dsh::DshCollector,
            zcode::ZcodeCollector,
        };
        use crate::collector::{Collector, Limits, RunOutcome};
        let secret = "SyntheticCredential0123456789ABCDEF";
        let redactor = Redactor {
            secrets: vec![secret.to_string()],
            patterns: vec![],
        };
        let limits = Limits {
            max_final_bytes: 1024,
            max_diagnostic_bytes: 64,
            max_protocol_line_bytes: 4096,
            max_protocol_bytes: 4096,
        };
        let message = format!("{}{secret} end", "x".repeat(48));
        let cases: Vec<(Box<dyn Collector>, serde_json::Value)> = vec![
            (
                Box::new(CodexCollector::new(limits)),
                serde_json::json!({"type":"turn.failed","error":{"message":message}}),
            ),
            (
                Box::new(ClaudeCollector::new(limits)),
                serde_json::json!({"type":"result","subtype":"error","is_error":true,"result":message}),
            ),
            (
                Box::new(DshCollector::new(limits)),
                serde_json::json!({"type":"error","message":message}),
            ),
            (
                Box::new(ZcodeCollector::new(limits)),
                serde_json::json!({"type":"error","message":message}),
            ),
        ];
        for (mut collector, value) in cases {
            collector.on_stdout(value.to_string().as_bytes());
            let collected = collector.finish_redacted(Some(1), &redactor);
            let RunOutcome::Failed { message, .. } = collected.outcome else {
                panic!("native failure expected")
            };
            assert!(collected.redacted);
            assert!(message.len() <= limits.max_diagnostic_bytes);
            assert!(!message.contains(&secret[..16]));
            assert!(message.contains(MASK));
        }
    }
}
