//! Text editing intent. Stable block identities remain an implementation detail.
use super::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef},
    outputs::RecordPatch,
};
use crate::record_documents::{RecordDocumentHead, RecordTarget};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum RecordTextEdit {
    Replace {
        old_text: String,
        new_text: String,
    },
    Append {
        markdown: String,
    },
    Markdown {
        before_markdown: String,
        after_markdown: String,
    },
}

impl RecordTextEdit {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        let (before, after) = match self {
            Self::Replace { old_text, new_text } => {
                if old_text.is_empty() {
                    return Err(AgentError::new(
                        ErrorCode::InvalidArgument,
                        "Replacement requires nonempty oldText",
                    ));
                }
                (old_text.as_str(), new_text.as_str())
            }
            Self::Append { markdown } => ("", markdown.as_str()),
            Self::Markdown {
                before_markdown,
                after_markdown,
            } => (before_markdown.as_str(), after_markdown.as_str()),
        };
        if before.len() > 1024 * 1024 || after.len() > 1024 * 1024 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Each Record text input is limited to 1 MiB of UTF-8",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordTextPatch {
    pub record: ObjectRef,
    #[schemars(range(min = 1, max = 9007199254740991_u64))]
    pub base_revision: u64,
    #[schemars(length(min = 1, max = 128))]
    pub request_id: String,
    pub edit: RecordTextEdit,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordTextPreview {
    pub record: ObjectRef,
    #[schemars(range(min = 1, max = 9007199254740991_u64))]
    pub base_revision: u64,
    pub edit: RecordTextEdit,
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: Option<usize>,
}

// Both public edit forms use the same native patch transaction and receipt.
// Untagged serialization preserves existing block-patch receipt hashes exactly;
// text receipts retain the original intent rather than randomly allocated IDs.
#[derive(Clone, Copy, Serialize)]
#[serde(untagged)]
pub(crate) enum RecordMutation<'a> {
    Blocks(&'a RecordPatch),
    Text(&'a RecordTextPatch),
}

impl RecordMutation<'_> {
    pub(crate) fn record(&self) -> &ObjectRef {
        match self {
            Self::Blocks(v) => &v.record,
            Self::Text(v) => &v.record,
        }
    }
    pub(crate) fn revision(&self) -> u64 {
        match self {
            Self::Blocks(v) => v.base_revision,
            Self::Text(v) => v.base_revision,
        }
    }
    pub(crate) fn request_id(&self) -> &str {
        match self {
            Self::Blocks(v) => &v.request_id,
            Self::Text(v) => &v.request_id,
        }
    }
    pub(crate) fn target(&self) -> AgentResult<RecordTarget> {
        self.record().key()?;
        if self.record().kind != ObjectKind::Record
            || self.revision() == 0
            || self.revision() > 9007199254740991
            || self.request_id().is_empty()
            || self.request_id().len() > 128
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid Record edit identity or baseRevision",
            ));
        }
        Ok(RecordTarget {
            scope: self.record().scope.clone(),
            record_id: self
                .record()
                .id
                .parse()
                .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid Record ID"))?,
        })
    }
    pub(crate) fn validate_base(&self, head: &RecordDocumentHead) -> AgentResult<()> {
        match self {
            Self::Blocks(patch) => crate::record_documents::validate_record_patch(patch, head),
            Self::Text(patch) => {
                patch.edit.validate()?;
                head.projection.validate().map(|_| ())
            }
        }
    }
}
