//! Internal deterministic lexical query planning for Memory v2.

use unicode_normalization::UnicodeNormalization;

use crate::{ToolError, ToolErrorCode};

/// Normalize without dropping query information: NFC plus Unicode-whitespace
/// segment folding. Retrieval operators are derived later and never parsed
/// from the user's punctuation.
pub(crate) fn normalize_query(query: &str) -> Result<String, ToolError> {
    let nfc: String = query.nfc().collect();
    let normalized = nfc.split_whitespace().collect::<Vec<_>>().join(" ");
    if !normalized
        .chars()
        .any(|character| character.is_alphanumeric() || character == '_')
    {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "memory.search",
            "query must contain at least one letter, number, or underscore",
        ));
    }
    Ok(normalized)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LexicalChannel {
    PhraseUnicode61,
    PhraseTrigram,
    TermsAndUnicode61,
    TermsOrUnicode61,
    TermsOrTrigram,
    ShortSubstring,
}

impl LexicalChannel {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::PhraseUnicode61 => "phrase_unicode61",
            Self::PhraseTrigram => "phrase_trigram",
            Self::TermsAndUnicode61 => "terms_and_unicode61",
            Self::TermsOrUnicode61 => "terms_or_unicode61",
            Self::TermsOrTrigram => "terms_or_trigram",
            Self::ShortSubstring => "short_substring",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct QueryPlan {
    pub(crate) normalized: String,
    pub(crate) and_terms: Vec<String>,
    pub(crate) or_terms: Vec<String>,
    pub(crate) trigram_terms: Vec<String>,
    pub(crate) channels: Vec<LexicalChannel>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FusedCandidate {
    pub(crate) record_id: String,
    pub(crate) score: f64,
    pub(crate) reasons: Vec<String>,
}

pub(crate) fn fuse_candidates(
    candidates: std::collections::BTreeMap<String, (f64, Vec<String>)>,
    candidate_limit: usize,
) -> Result<Vec<FusedCandidate>, ToolError> {
    let mut fused = Vec::with_capacity(candidates.len());
    for (record_id, (score, reasons)) in candidates {
        if !score.is_finite() || score < 0.0 {
            return Err(ToolError::new(
                ToolErrorCode::IntegrityError,
                "memory.search",
                "lexical fusion produced an invalid score",
            ));
        }
        fused.push(FusedCandidate {
            record_id,
            score,
            reasons,
        });
    }
    fused.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .expect("finite scores are comparable")
            .then(left.record_id.cmp(&right.record_id))
    });
    fused.truncate(candidate_limit);
    Ok(fused)
}

pub(crate) fn reciprocal_rank(rank_zero_based: usize) -> Result<f64, ToolError> {
    let rank_one_based = rank_zero_based.checked_add(1).ok_or_else(|| {
        ToolError::new(
            ToolErrorCode::IntegrityError,
            "memory.search",
            "lexical channel produced an invalid rank",
        )
    })?;
    let score = 1.0 / (60.0 + rank_one_based as f64);
    if !score.is_finite() || score <= 0.0 {
        return Err(ToolError::new(
            ToolErrorCode::IntegrityError,
            "memory.search",
            "lexical channel produced an invalid reciprocal rank score",
        ));
    }
    Ok(score)
}

pub(crate) fn rerank_lexical_candidate(
    base_score: f64,
    channel_reasons: &[String],
    plan: &QueryPlan,
    title: Option<&str>,
    tags: &[String],
    summary: Option<&str>,
    content: &str,
) -> Result<(f64, Vec<String>), ToolError> {
    if !base_score.is_finite() || base_score < 0.0 {
        return Err(invalid_lexical_score());
    }

    let fields = [
        (
            "title",
            normalize_match_text(title.unwrap_or_default()),
            0.40,
        ),
        ("tags", normalize_match_text(&tags.join(" ")), 0.35),
        (
            "summary",
            normalize_match_text(summary.unwrap_or_default()),
            0.20,
        ),
        ("content", normalize_match_text(content), 0.10),
    ];
    let terms: Vec<String> = plan
        .and_terms
        .iter()
        .map(|term| normalize_match_text(term))
        .collect();
    if terms.is_empty() {
        return Err(ToolError::new(
            ToolErrorCode::IntegrityError,
            "memory.search",
            "query plan has no lexical terms",
        ));
    }

    let combined = fields
        .iter()
        .map(|(_, text, _)| text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let matched_terms = terms
        .iter()
        .filter(|term| combined.contains(term.as_str()))
        .count();
    let coverage = matched_terms as f64 / terms.len() as f64;

    let mut score = base_score + coverage;
    let mut reasons = channel_reasons.to_vec();
    if matched_terms == terms.len() {
        reasons.push("coverage_full".to_string());
    } else if matched_terms > 0 {
        reasons.push("coverage_partial".to_string());
    }

    let phrase = normalize_match_text(&plan.normalized);
    for (field, text, _) in &fields {
        if !phrase.is_empty() && text.contains(&phrase) {
            let bonus = match *field {
                "title" => 0.80,
                "tags" => 0.70,
                "summary" => 0.50,
                "content" => 0.30,
                _ => unreachable!("fixed lexical field"),
            };
            score += bonus;
            reasons.push(format!("phrase_{field}"));
            break;
        }
    }

    let mut best_field: Option<(&str, f64)> = None;
    for (field, text, weight) in &fields {
        let hits = terms
            .iter()
            .filter(|term| text.contains(term.as_str()))
            .count();
        if hits == 0 {
            continue;
        }
        let field_score = hits as f64 / terms.len() as f64 * weight;
        if best_field.is_none_or(|(_, current)| field_score > current) {
            best_field = Some((field, field_score));
        }
    }
    if let Some((field, field_score)) = best_field {
        score += field_score;
        reasons.push(format!("field_{field}"));
    }

    let exact_tokens: std::collections::BTreeSet<String> = fields
        .iter()
        .flat_map(|(_, text, _)| lexical_segments(text))
        .collect();
    let exact_count = terms
        .iter()
        .filter(|term| exact_tokens.contains(term.as_str()))
        .count();
    if exact_count > 0 {
        score += exact_count as f64 / terms.len() as f64 * 0.25;
        reasons.push(
            if exact_count == terms.len() {
                "exact_token_full"
            } else {
                "exact_token_partial"
            }
            .to_string(),
        );
    }

    if !score.is_finite() || score < 0.0 {
        return Err(invalid_lexical_score());
    }
    Ok((score, reasons))
}

fn invalid_lexical_score() -> ToolError {
    ToolError::new(
        ToolErrorCode::IntegrityError,
        "memory.search",
        "lexical rerank produced an invalid score",
    )
}

fn normalize_match_text(value: &str) -> String {
    let nfc: String = value.nfc().collect();
    nfc.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .flat_map(char::to_lowercase)
        .collect()
}

impl QueryPlan {
    pub(crate) fn build(query: &str) -> Result<Self, ToolError> {
        let normalized = normalize_query(query)?;
        if normalized.chars().count() <= 2 {
            return Ok(Self {
                and_terms: vec![normalized.clone()],
                or_terms: vec![normalized.clone()],
                trigram_terms: Vec::new(),
                normalized,
                channels: vec![LexicalChannel::ShortSubstring],
            });
        }

        let and_terms = lexical_segments(&normalized);
        let mut or_terms = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for segment in &and_terms {
            push_unique(&mut or_terms, &mut seen, segment.clone());
            for piece in segment.split(['_', '-']).filter(|piece| !piece.is_empty()) {
                for subterm in split_identifier(piece) {
                    push_unique(&mut or_terms, &mut seen, subterm.clone());
                    if subterm.chars().all(is_cjk) && subterm.chars().count() > 3 {
                        let characters: Vec<char> = subterm.chars().collect();
                        for window in characters.windows(3) {
                            push_unique(
                                &mut or_terms,
                                &mut seen,
                                window.iter().collect::<String>(),
                            );
                        }
                    }
                }
            }
        }
        let trigram_terms: Vec<String> = or_terms
            .iter()
            .filter(|term| term.chars().count() >= 3)
            .cloned()
            .collect();
        let single_compound_identifier = and_terms.len() == 1
            && and_terms
                .first()
                .is_some_and(|term| is_compound_identifier(term));
        let mut channels = vec![
            LexicalChannel::PhraseUnicode61,
            LexicalChannel::PhraseTrigram,
        ];
        if and_terms.len() > 1 {
            channels.push(LexicalChannel::TermsAndUnicode61);
        }
        // A single compound identifier must not degrade to a match on one
        // generic sub-token (for example OLD_TOKEN matching NEW_TOKEN). The
        // expanded terms remain available when another query segment supplies
        // context, while phrase channels preserve exact single-identifier recall.
        if !single_compound_identifier {
            channels.push(LexicalChannel::TermsOrUnicode61);
            if !trigram_terms.is_empty() {
                channels.push(LexicalChannel::TermsOrTrigram);
            }
        }
        Ok(Self {
            normalized,
            and_terms,
            or_terms,
            trigram_terms,
            channels,
        })
    }

    pub(crate) fn match_expression(&self, channel: LexicalChannel) -> Option<String> {
        match channel {
            LexicalChannel::PhraseUnicode61 | LexicalChannel::PhraseTrigram => {
                Some(fts_literal(&self.normalized))
            }
            LexicalChannel::TermsAndUnicode61 => join_literal_terms(&self.and_terms, " AND "),
            LexicalChannel::TermsOrUnicode61 => join_literal_terms(&self.or_terms, " OR "),
            LexicalChannel::TermsOrTrigram => join_literal_terms(&self.trigram_terms, " OR "),
            LexicalChannel::ShortSubstring => None,
        }
    }
}

fn join_literal_terms(terms: &[String], operator: &str) -> Option<String> {
    if terms.is_empty() {
        return None;
    }
    Some(
        terms
            .iter()
            .map(|term| fts_literal(term))
            .collect::<Vec<_>>()
            .join(operator),
    )
}

fn fts_literal(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn lexical_segments(query: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    for character in query.chars() {
        if character.is_alphanumeric() || character == '_' || character == '-' {
            current.push(character);
        } else if !current.is_empty() {
            segments.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        segments.push(current);
    }
    segments
}

fn split_identifier(identifier: &str) -> Vec<String> {
    let characters: Vec<char> = identifier.chars().collect();
    if characters.is_empty() {
        return Vec::new();
    }
    let mut parts = Vec::new();
    let mut start = 0;
    for index in 1..characters.len() {
        let previous = characters[index - 1];
        let current = characters[index];
        let next = characters.get(index + 1).copied();
        let cjk_boundary = is_cjk(previous) != is_cjk(current);
        let lower_to_upper = previous.is_lowercase() && current.is_uppercase();
        let acronym_to_word = previous.is_uppercase()
            && current.is_uppercase()
            && next.is_some_and(char::is_lowercase);
        if cjk_boundary || lower_to_upper || acronym_to_word {
            parts.push(characters[start..index].iter().collect());
            start = index;
        }
    }
    parts.push(characters[start..].iter().collect());
    parts
}

fn is_compound_identifier(value: &str) -> bool {
    value.contains(['_', '-']) || split_identifier(value).len() > 1
}

fn push_unique(
    values: &mut Vec<String>,
    seen: &mut std::collections::BTreeSet<String>,
    value: String,
) {
    if !value.is_empty() && seen.insert(value.clone()) {
        values.push(value);
    }
}

fn is_cjk(character: char) -> bool {
    matches!(
        character,
        '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_is_nfc_and_folds_only_whitespace() {
        let normalized = normalize_query("  Cafe\u{301}\t rust\n工作区  ").unwrap();
        assert_eq!(normalized, "Café rust 工作区");
    }

    #[test]
    fn normalization_rejects_queries_without_terms() {
        for query in ["", "   ", "***", "\"\" -- / "] {
            let error = normalize_query(query).unwrap_err();
            assert_eq!(error.code, ToolErrorCode::InvalidInput);
        }
    }

    #[test]
    fn normalization_does_not_truncate_or_interpret_operator_text() {
        let query = format!("AND OR NEAR {}", "identifier_123 ".repeat(128));
        let normalized = normalize_query(&query).unwrap();
        assert!(normalized.starts_with("AND OR NEAR identifier_123"));
        assert_eq!(normalized.matches("identifier_123").count(), 128);
    }

    #[test]
    fn query_plan_expands_identifiers_and_cjk_in_stable_order() {
        let plan = QueryPlan::build(" SearchRequestV2 expected_sha256 xuanling-memory 工作区缓存 ")
            .unwrap();
        assert_eq!(
            plan.and_terms,
            [
                "SearchRequestV2",
                "expected_sha256",
                "xuanling-memory",
                "工作区缓存"
            ]
        );
        assert_eq!(
            plan.or_terms,
            [
                "SearchRequestV2",
                "Search",
                "Request",
                "V2",
                "expected_sha256",
                "expected",
                "sha256",
                "xuanling-memory",
                "xuanling",
                "memory",
                "工作区缓存",
                "工作区",
                "作区缓",
                "区缓存",
            ]
        );
        assert_eq!(
            plan.channels
                .iter()
                .map(|channel| channel.reason())
                .collect::<Vec<_>>(),
            [
                "phrase_unicode61",
                "phrase_trigram",
                "terms_and_unicode61",
                "terms_or_unicode61",
                "terms_or_trigram",
            ]
        );
        assert!(
            plan.trigram_terms
                .iter()
                .all(|term| term.chars().count() >= 3)
        );
        assert_eq!(plan, QueryPlan::build(&plan.normalized).unwrap());
    }

    #[test]
    fn short_query_uses_only_the_substring_channel() {
        let plan = QueryPlan::build(" 编译 ").unwrap();
        assert_eq!(plan.normalized, "编译");
        assert_eq!(plan.channels, [LexicalChannel::ShortSubstring]);
        assert!(plan.trigram_terms.is_empty());
    }

    #[test]
    fn single_compound_identifier_does_not_run_subtoken_or_channels() {
        let plan = QueryPlan::build("OLD_TOKEN").unwrap();
        assert_eq!(plan.or_terms, ["OLD_TOKEN", "OLD", "TOKEN"]);
        assert_eq!(
            plan.channels,
            [
                LexicalChannel::PhraseUnicode61,
                LexicalChannel::PhraseTrigram,
            ]
        );
    }

    #[test]
    fn single_cjk_segment_keeps_or_trigram_recall() {
        let plan = QueryPlan::build("正式记忆写入前审核候选").unwrap();
        assert!(plan.channels.contains(&LexicalChannel::TermsOrUnicode61));
        assert!(plan.channels.contains(&LexicalChannel::TermsOrTrigram));
    }

    #[test]
    fn fts_expressions_quote_every_user_term() {
        let plan = QueryPlan::build("alpha AND beta OR \"quoted\" NEAR gamma* ^delta").unwrap();
        assert_eq!(
            plan.match_expression(LexicalChannel::PhraseUnicode61),
            Some("\"alpha AND beta OR \"\"quoted\"\" NEAR gamma* ^delta\"".to_string())
        );
        assert_eq!(
            plan.match_expression(LexicalChannel::TermsAndUnicode61),
            Some(
                [
                    "alpha", "AND", "beta", "OR", "quoted", "NEAR", "gamma", "delta"
                ]
                .map(fts_literal)
                .join(" AND ")
            )
        );
        assert_eq!(
            plan.match_expression(LexicalChannel::TermsOrUnicode61),
            Some(
                [
                    "alpha", "AND", "beta", "OR", "quoted", "NEAR", "gamma", "delta"
                ]
                .map(fts_literal)
                .join(" OR ")
            )
        );
    }

    #[test]
    fn embedded_quotes_are_doubled_and_short_queries_have_no_match_expression() {
        assert_eq!(fts_literal("a\"b"), "\"a\"\"b\"");
        let short = QueryPlan::build("OR").unwrap();
        assert_eq!(short.match_expression(LexicalChannel::ShortSubstring), None);
    }

    #[test]
    fn fused_candidates_sort_by_score_then_id_before_applying_the_cap() {
        let candidates = std::collections::BTreeMap::from([
            (
                "candidate-b".to_string(),
                (1.0, vec!["terms_or_unicode61".to_string()]),
            ),
            (
                "candidate-c".to_string(),
                (2.0, vec!["phrase_unicode61".to_string()]),
            ),
            (
                "candidate-a".to_string(),
                (1.0, vec!["phrase_trigram".to_string()]),
            ),
        ]);

        let fused = fuse_candidates(candidates, 2).unwrap();

        assert_eq!(
            fused
                .iter()
                .map(|candidate| candidate.record_id.as_str())
                .collect::<Vec<_>>(),
            ["candidate-c", "candidate-a"]
        );
        assert_eq!(fused[0].score, 2.0);
        assert_eq!(fused[0].reasons, ["phrase_unicode61"]);
    }

    #[test]
    fn fused_candidates_fail_closed_on_invalid_scores() {
        for score in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.01] {
            let candidates = std::collections::BTreeMap::from([(
                "candidate".to_string(),
                (score, vec!["test".to_string()]),
            )]);

            let error = fuse_candidates(candidates, 1).unwrap_err();
            assert_eq!(error.code, ToolErrorCode::IntegrityError);
        }
    }

    #[test]
    fn reciprocal_rank_is_one_based_and_fails_on_rank_overflow() {
        assert_eq!(reciprocal_rank(0).unwrap(), 1.0 / 61.0);
        assert_eq!(reciprocal_rank(1).unwrap(), 1.0 / 62.0);
        let error = reciprocal_rank(usize::MAX).unwrap_err();
        assert_eq!(error.code, ToolErrorCode::IntegrityError);
    }

    #[test]
    fn lexical_rerank_rewards_coverage_and_higher_value_fields() {
        let plan = QueryPlan::build("priority signal phrase").unwrap();
        let channels = vec!["terms_or_unicode61".to_string()];
        let (title_score, title_reasons) = rerank_lexical_candidate(
            0.1,
            &channels,
            &plan,
            Some("priority signal phrase"),
            &[],
            None,
            "unrelated content",
        )
        .unwrap();
        let (content_score, content_reasons) = rerank_lexical_candidate(
            0.1,
            &channels,
            &plan,
            Some("generic title"),
            &[],
            None,
            "priority signal phrase",
        )
        .unwrap();

        assert!(title_score > content_score);
        assert_eq!(
            title_reasons,
            [
                "terms_or_unicode61",
                "coverage_full",
                "phrase_title",
                "field_title",
                "exact_token_full",
            ]
        );
        assert!(content_reasons.contains(&"phrase_content".to_string()));
        assert!(content_reasons.contains(&"field_content".to_string()));
    }

    #[test]
    fn lexical_rerank_is_case_and_nfc_stable_and_rejects_invalid_base_scores() {
        let plan = QueryPlan::build("CAFÉ build").unwrap();
        let channels = vec!["test".to_string()];
        let composed = rerank_lexical_candidate(
            0.25,
            &channels,
            &plan,
            Some("Café Build"),
            &[],
            None,
            "content",
        )
        .unwrap();
        let decomposed = rerank_lexical_candidate(
            0.25,
            &channels,
            &plan,
            Some("CAFE\u{301} BUILD"),
            &[],
            None,
            "content",
        )
        .unwrap();
        assert_eq!(composed, decomposed);

        let error =
            rerank_lexical_candidate(f64::NAN, &channels, &plan, None, &[], None, "content")
                .unwrap_err();
        assert_eq!(error.code, ToolErrorCode::IntegrityError);
    }
}
