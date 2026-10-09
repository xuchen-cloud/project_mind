//! Exact source-byte patches; no extraction, HTML projection or normalization.
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::ObjectRef,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextEdit {
    pub old_text: String,
    pub new_text: String,
    /// One-based occurrence, including overlapping candidate matches.
    pub occurrence: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileTextPatch {
    pub object: ObjectRef,
    pub expected_version_number: u32,
    pub expected_content_hash: String,
    pub edits: Option<Vec<TextEdit>>,
    pub append_text: Option<String>,
}
pub(crate) const MAX_FILE_BYTES: usize = 100 * 1024 * 1024;
const MAX_PATCH_BYTES: usize = 1024 * 1024;
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidPatch, message)
}
fn budget() -> AgentError {
    AgentError::new(
        ErrorCode::BudgetExceeded,
        "File patch exceeds its byte or edit budget",
    )
}
impl FileTextPatch {
    pub(crate) fn validate(&self) -> AgentResult<String> {
        self.object.key()?;
        if self.object.kind != crate::agent::models::ObjectKind::File
            || self.expected_version_number == 0
            || !crate::db::file_versions::valid_hash(&self.expected_content_hash)
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File patch baseline",
            ));
        }
        validate_edit_shape(self.edits.as_deref(), self.append_text.as_deref())?;
        // Bound before serialization/allocation; the digest keeps patch text out
        // of the durable journal and distinguishes different edits with equal output.
        let bytes = serde_json::to_vec(self).map_err(|_| invalid("Invalid File patch"))?;
        if bytes.len() > MAX_PATCH_BYTES {
            return Err(budget());
        }
        use sha2::{Digest, Sha256};
        Ok(format!("sha256:{:x}", Sha256::digest(&bytes)))
    }
}
fn validate_edit_shape(edits: Option<&[TextEdit]>, append: Option<&str>) -> AgentResult<()> {
    match (edits, append) {
        (Some(edits), None) if !edits.is_empty() => {
            if edits.len() > 100 {
                return Err(budget());
            }
            let mut length = 0usize;
            for edit in edits {
                if edit.old_text.is_empty() || edit.occurrence == Some(0) {
                    return Err(invalid("Invalid exact match target"));
                }
                length = length
                    .checked_add(edit.old_text.len())
                    .and_then(|n| n.checked_add(edit.new_text.len()))
                    .ok_or_else(budget)?;
                if length > MAX_PATCH_BYTES {
                    return Err(budget());
                }
            }
        }
        (None, Some(append)) => {
            if append.len() > MAX_PATCH_BYTES {
                return Err(budget());
            }
        }
        _ => return Err(invalid("Provide nonempty edits or appendText exclusively")),
    }
    Ok(())
}
pub(crate) fn apply(
    base: &[u8],
    edits: Option<&[TextEdit]>,
    append: Option<&str>,
) -> AgentResult<Vec<u8>> {
    validate_edit_shape(edits, append)?;
    if base.len() > MAX_FILE_BYTES {
        return Err(budget());
    }
    let text = std::str::from_utf8(base)
        .map_err(|_| invalid("File patch requires exact UTF-8 source bytes"))?;
    if let Some(append) = append {
        let size = base
            .len()
            .checked_add(append.len())
            .filter(|n| *n <= MAX_FILE_BYTES)
            .ok_or_else(budget)?;
        let mut result = Vec::with_capacity(size);
        result.extend_from_slice(base);
        result.extend_from_slice(append.as_bytes());
        return Ok(result);
    }
    let mut ranges = Vec::new();
    for edit in edits.unwrap() {
        let wanted = edit.occurrence.unwrap_or(1);
        let mut count = 0u32;
        let mut offset = 0usize;
        let mut selected = None;
        while let Some(found) = text[offset..].find(&edit.old_text) {
            let start = offset + found;
            count += 1;
            if count == wanted {
                selected = Some(start);
            }
            if edit.occurrence.is_some() && count == wanted {
                break;
            }
            if edit.occurrence.is_none() && count == 2 {
                return Err(AgentError::new(
                    ErrorCode::AmbiguousMatch,
                    "Exact match has multiple occurrences",
                ));
            }
            // str::match_indices skips overlaps. Advance one character after
            // the start to count every Unicode-safe candidate in the original.
            offset = start + text[start..].chars().next().unwrap().len_utf8();
        }
        let start = selected.ok_or_else(|| invalid("Exact match occurrence was not found"))?;
        ranges.push((start, start + edit.old_text.len(), edit.new_text.as_bytes()));
    }
    ranges.sort_by_key(|range| range.0);
    if ranges.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err(invalid("Selected edit ranges overlap"));
    }
    let mut size = base.len();
    for (start, end, replacement) in &ranges {
        size = size
            .checked_sub(end - start)
            .and_then(|n| n.checked_add(replacement.len()))
            .ok_or_else(budget)?;
    }
    if size > MAX_FILE_BYTES {
        return Err(budget());
    }
    let mut result = Vec::with_capacity(size);
    let mut offset = 0;
    for (start, end, replacement) in ranges {
        result.extend_from_slice(&base[offset..start]);
        result.extend_from_slice(replacement);
        offset = end;
    }
    result.extend_from_slice(&base[offset..]);
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn edit(old: &str, new: &str, occurrence: Option<u32>) -> TextEdit {
        TextEdit {
            old_text: old.into(),
            new_text: new.into(),
            occurrence,
        }
    }
    #[test]
    fn file_patch_preserves_bom_crlf_and_html_source() {
        let base = "\u{feff}<script>const 名称='old';\r\n</script>\r\n";
        assert_eq!(
            apply(base.as_bytes(), Some(&[edit("old", "新值", None)]), None).unwrap(),
            "\u{feff}<script>const 名称='新值';\r\n</script>\r\n".as_bytes()
        );
        assert_eq!(
            apply(base.as_bytes(), None, Some("tail\n")).unwrap(),
            format!("{base}tail\n").as_bytes()
        );
    }
    #[test]
    fn file_patch_resolves_all_edits_in_original_snapshot() {
        assert_eq!(
            apply(
                b"one two",
                Some(&[edit("two", "three", None), edit("one", "two", None)]),
                None
            )
            .unwrap(),
            b"two three"
        );
        assert_eq!(
            apply(
                "猫猫猫".as_bytes(),
                Some(&[edit("猫", "犬", Some(2))]),
                None
            )
            .unwrap(),
            "猫犬猫".as_bytes()
        );
    }
    #[test]
    fn file_patch_ambiguity_includes_overlapping_matches() {
        for (base, old) in [("aaa", "aa"), ("猫猫猫", "猫猫"), ("x x", "x")] {
            assert_eq!(
                apply(base.as_bytes(), Some(&[edit(old, "new", None)]), None)
                    .unwrap_err()
                    .code,
                ErrorCode::AmbiguousMatch
            );
        }
        assert_eq!(
            apply(b"aaa", Some(&[edit("aa", "x", Some(2))]), None).unwrap(),
            b"ax"
        );
    }
    #[test]
    fn file_patch_rejects_overlapping_selected_ranges_and_missing_targets() {
        for edits in [
            vec![edit("ab", "x", None), edit("bc", "y", None)],
            vec![edit("a", "x", None), edit("a", "y", None)],
            vec![edit("a", "x", Some(0))],
            vec![edit("missing", "x", None)],
            vec![edit("a", "x", Some(2))],
            vec![edit("", "x", None)],
        ] {
            assert_eq!(
                apply(b"abc", Some(&edits), None).unwrap_err().code,
                ErrorCode::InvalidPatch
            );
        }
        assert_eq!(
            apply(
                b"ab",
                Some(&[edit("a", "x", None), edit("b", "y", None)]),
                None
            )
            .unwrap(),
            b"xy"
        );
    }
    #[test]
    fn file_patch_requires_utf8_and_exclusive_edit_or_append() {
        assert_eq!(
            apply(&[0xff], None, Some("x")).unwrap_err().code,
            ErrorCode::InvalidPatch
        );
        for (edits, append) in [
            (None, None),
            (Some(vec![]), None),
            (Some(vec![edit("a", "b", None)]), Some("x")),
        ] {
            assert_eq!(
                apply(b"abc", edits.as_deref(), append).unwrap_err().code,
                ErrorCode::InvalidPatch
            );
        }
    }
    #[test]
    fn file_patch_duplicate_deletions_are_overlap_errors_before_size_arithmetic() {
        assert_eq!(
            apply(
                b"a",
                Some(&[edit("a", "", None), edit("a", "", None)]),
                None
            )
            .unwrap_err()
            .code,
            ErrorCode::InvalidPatch
        );
    }
    #[test]
    fn file_patch_bounds_edits_payload_and_result_before_allocation() {
        assert_eq!(
            apply(b"a", Some(&vec![edit("a", "", None); 101]), None)
                .unwrap_err()
                .code,
            ErrorCode::BudgetExceeded
        );
        assert_eq!(
            apply(b"a", None, Some(&"x".repeat(1024 * 1024 + 1)))
                .unwrap_err()
                .code,
            ErrorCode::BudgetExceeded
        );
        let mut oversized = vec![b'x'; MAX_FILE_BYTES];
        assert_eq!(
            apply(&oversized, None, Some("a")).unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        oversized.push(b'x');
        assert_eq!(
            apply(&oversized, None, Some("")).unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
    }
}
