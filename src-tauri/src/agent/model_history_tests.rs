use super::*;
use crate::agent::models::{ObjectKind, ObjectRef, Scope, SourceLocator};

fn fixture(text: &str, start: u32, total: u32, partial: bool) -> ModelHistoryReadPage {
    let id = "a".repeat(32);
    let branch = "old-branch";
    let end = start + text.chars().count() as u32;
    ModelHistoryReadPage {
        source_ref: SourceRef {
            object: ObjectRef {
                workspace_id: "w".into(),
                scope: Scope::Workspace,
                kind: ObjectKind::SessionMessage,
                id: id.clone(),
            },
            revision: format!("sha256:{}", "b".repeat(64)),
            file_version: None,
            record_version: None,
            block_id: None,
            locator: Some(SourceLocator::Messages {
                session_id: "c".repeat(32),
                branch_id: branch.into(),
                start_message_id: id.clone(),
                end_message_id: id.clone(),
            }),
            title: "历史讨论".into(),
            excerpt: String::new(),
        },
        text: text.into(),
        char_start: start,
        char_end: end,
        total_chars: total,
        next_cursor: partial.then(|| read_cursor(branch, &id, end)),
    }
}

#[test]
fn exact_serialized_budget_preserves_unicode_slice_and_old_branch_cursor() {
    let text = "a\"\n中🙂".repeat(20);
    let full = fixture(&text, 7, 17 + text.chars().count() as u32, true);
    let size = serde_json::to_string(&full).unwrap().chars().count();
    let result = fit_read_page(full, size - 15, "old-branch", &"a".repeat(32)).unwrap();
    assert!(result.text.chars().count() < text.chars().count());
    assert!(text.starts_with(&result.text));
    assert_eq!(result.char_start, 7);
    assert_eq!(result.char_end, 7 + result.text.chars().count() as u32);
    let cursor = result.next_cursor.as_ref().unwrap();
    assert_eq!(cursor.branch_id, "old-branch");
    assert_eq!(cursor.char_offset, result.char_end);
    assert!(serde_json::to_string(&result).unwrap().chars().count() <= size - 15);
}

#[test]
fn complete_page_has_no_cursor_and_tiny_budget_fails() {
    let full = fixture("终页🙂", 0, 3, false);
    let size = serde_json::to_string(&full).unwrap().chars().count();
    let result = fit_read_page(full, size, "old-branch", &"a".repeat(32)).unwrap();
    assert!(result.next_cursor.is_none());
    assert_eq!(result.text, "终页🙂");
    assert_eq!(
        fit_read_page(fixture("🙂", 2, 5, true), 1, "old-branch", &"a".repeat(32))
            .unwrap_err()
            .code,
        ErrorCode::BudgetExceeded
    );
    assert_eq!(
        fit_read_page(
            fixture("", 0, 0, false),
            12000,
            "old-branch",
            &"a".repeat(32)
        )
        .unwrap_err()
        .code,
        ErrorCode::BudgetExceeded
    );
}
