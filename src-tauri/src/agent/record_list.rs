//! Metadata-only native Record inventory; independent of search indexing.
use super::models::{ObjectRef, Scope};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordListInput {
    pub scope: Scope,
    /// metadata (default) omits full bodies; detail includes complete available content within the response budget.
    #[serde(default)]
    pub mode: crate::agent::listing::ListMode,
    /// Native object IDs. Empty means all. Filters combine with AND.
    #[serde(default)]
    #[schemars(length(max = 50))]
    pub ids: Vec<String>,
    /// Case-insensitive substring match; no wildcard syntax.
    #[schemars(length(min = 1, max = 256))]
    pub title_query: Option<String>,
    /// Case-insensitive substring match in committed content, before pagination.
    #[schemars(length(min = 1, max = 256))]
    pub content_query: Option<String>,

    /// Exact tag label using native SQLite NOCASE matching (ASCII case-insensitive). Combined with tagIds using AND.
    #[schemars(length(min = 1, max = 240))]
    pub tag: Option<String>,
    /// Require every tag ID in this scope. Empty means no tag restriction.
    #[serde(default)]
    #[schemars(length(max = 50))]
    pub tag_ids: Vec<i64>,
    #[schemars(length(max = 2048))]
    pub cursor: Option<String>,
    /// Defaults to 20. Zero returns counts only (no items or continuation).
    #[schemars(range(min = 0, max = 50))]
    pub limit: Option<usize>,
    /// Defaults to 4000; may shorten a page or return BUDGET_EXCEEDED.
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordListItem {
    pub object: ObjectRef,
    pub title: Option<String>,
    /// text or voice; distinct from ObjectRef.kind (record).
    pub record_type: &'static str,
    pub created_at: String,
    /// Native modification time, including metadata changes.
    pub updated_at: String,
    /// Current committed document head's edit time; null for legacy unversioned Records.
    pub last_edited_at: Option<String>,
    pub tags: Vec<crate::models::DocumentTagRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordListPage {
    pub scope: Scope,
    pub items: Vec<RecordListItem>,
    pub total_count: usize,
    /// Always zero: this inventory reads native metadata, not search snapshots.
    pub stale_count: usize,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}
