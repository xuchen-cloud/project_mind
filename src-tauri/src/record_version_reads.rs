//! Bounded, source-authorized reads of retained Record versions.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef},
    },
    record_document_service::{DocumentUtility, RecordVersionDifference},
    record_documents::{RecordTarget, RecordVersion, RecordVersionPage, RecordVersionSummary},
    source_service::{BoundSourceStore, SourceReadTarget},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn too_small() -> AgentError {
    AgentError::new(
        ErrorCode::BudgetExceeded,
        "Record version response cannot fit budget",
    )
}
fn budget(value: Option<usize>) -> AgentResult<usize> {
    let value = value.unwrap_or(4000);
    if !(1..=12000).contains(&value) {
        return Err(invalid("Invalid Record version budget"));
    }
    Ok(value)
}
fn size(value: &impl Serialize) -> AgentResult<usize> {
    Ok(serde_json::to_string(value)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode Record version response"))?
        .chars()
        .count())
}
fn target(object: &ObjectRef) -> AgentResult<RecordTarget> {
    if object.kind != ObjectKind::Record {
        return Err(invalid("Expected a Record target"));
    }
    Ok(RecordTarget {
        scope: object.scope.clone(),
        record_id: object
            .id
            .parse()
            .map_err(|_| invalid("Invalid Record identity"))?,
    })
}
fn summary(version: &RecordVersion) -> RecordVersionSummary {
    RecordVersionSummary {
        id: version.id.clone(),
        version_number: version.version_number,
        head_revision: version.head_revision,
        title_snapshot: version.title_snapshot.clone(),
        body_hash: version.projection.body_hash.clone(),
        origin: version.origin.clone(),
        created_at: version.created_at.clone(),
    }
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordVersionsListInput {
    pub record: ObjectRef,
    pub cursor: Option<u64>,
    #[schemars(range(min = 1, max = 100))]
    pub limit: Option<u32>,
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: Option<usize>,
}
#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordVersionsGetInput {
    pub record: ObjectRef,
    #[schemars(length(min = 32, max = 32))]
    pub version_id: String,
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: Option<usize>,
}
#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordVersionsCompareInput {
    pub record: ObjectRef,
    #[schemars(length(min = 32, max = 32))]
    pub before_version_id: String,
    #[schemars(length(min = 32, max = 32))]
    pub after_version_id: String,
    #[schemars(length(max = 2048))]
    pub cursor: Option<String>,
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordVersionsListPage {
    pub object: ObjectRef,
    pub versions: Vec<RecordVersionSummary>,
    pub next_before: Option<u64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordVersionsGetPage {
    pub object: ObjectRef,
    pub version: RecordVersionSummary,
    pub source: SourceReadTarget,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordVersionChange {
    pub kind: &'static str,
    pub block_id: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordVersionChangeCounts {
    pub added: usize,
    pub deleted: usize,
    pub modified: usize,
    pub moved: usize,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordVersionsComparePage {
    pub object: ObjectRef,
    pub before_version_id: String,
    pub after_version_id: String,
    pub counts: RecordVersionChangeCounts,
    pub changes: Vec<RecordVersionChange>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompareCursor {
    object_key: String,
    before_version_id: String,
    after_version_id: String,
    before_hash: String,
    after_hash: String,
    offset: usize,
}
fn cursor_encode(cursor: &CompareCursor) -> AgentResult<String> {
    Ok(URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(cursor).map_err(|_| invalid("Invalid comparison cursor"))?))
}
fn cursor_decode(value: &str) -> AgentResult<CompareCursor> {
    if value.len() > 2048 {
        return Err(invalid("Invalid comparison cursor"));
    }
    serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| invalid("Invalid comparison cursor"))?,
    )
    .map_err(|_| invalid("Invalid comparison cursor"))
}
fn change_at(
    difference: &RecordVersionDifference,
    mut index: usize,
) -> Option<RecordVersionChange> {
    for (kind, ids) in [
        ("added", &difference.added),
        ("deleted", &difference.deleted),
        ("modified", &difference.modified),
        ("moved", &difference.moved),
    ] {
        if index < ids.len() {
            return Some(RecordVersionChange {
                kind,
                block_id: ids[index].clone(),
            });
        }
        index -= ids.len();
    }
    None
}

pub(crate) struct RecordVersionReadService<'a, S, W> {
    store: &'a S,
    utility: &'a W,
}
impl<'a, S: BoundSourceStore, W: DocumentUtility> RecordVersionReadService<'a, S, W> {
    pub(crate) fn new(store: &'a S, utility: &'a W) -> Self {
        Self { store, utility }
    }

    pub(crate) fn list(
        &self,
        request: &RequestContext,
        input: &RecordVersionsListInput,
    ) -> AgentResult<RecordVersionsListPage> {
        let max_chars = budget(input.budget_chars)?;
        let limit = input.limit.unwrap_or(8);
        if !(1..=100).contains(&limit) {
            return Err(invalid("Invalid Record version limit"));
        }
        let (object, page): (ObjectRef, RecordVersionPage) =
            self.store.with_current(|binding, db| {
                let object = db.source_read_object(request, binding, &input.record)?;
                let target = target(&object)?;
                Ok((
                    object,
                    db.record_versions_list(&target, input.cursor, limit)?,
                ))
            })?;
        let had_versions = !page.versions.is_empty();
        let mut result = RecordVersionsListPage {
            object,
            versions: page.versions,
            next_before: page.next_before,
        };
        while size(&result)? > max_chars {
            result.versions.pop().ok_or_else(too_small)?;
            result.next_before = result.versions.last().map(|version| version.version_number);
        }
        if had_versions && result.versions.is_empty() {
            return Err(too_small());
        }
        Ok(result)
    }

    pub(crate) fn get(
        &self,
        request: &RequestContext,
        input: &RecordVersionsGetInput,
    ) -> AgentResult<RecordVersionsGetPage> {
        let max_chars = budget(input.budget_chars)?;
        let result = self.store.with_current(|binding, db| {
            let object = db.source_read_object(request, binding, &input.record)?;
            let target = target(&object)?;
            let version = db.record_version_get(&target, &input.version_id)?;
            let source = SourceReadTarget {
                object: object.clone(),
                revision: None,
                record_version: Some(
                    version
                        .version_number
                        .try_into()
                        .map_err(|_| invalid("Record version number is too large"))?,
                ),
                file_version: None,
            };
            let fingerprint = db.source_record_fingerprint(request, binding, &source)?;
            Ok(RecordVersionsGetPage {
                object,
                version: summary(&version),
                source: SourceReadTarget {
                    revision: Some(fingerprint.revision),
                    ..source
                },
            })
        })?;
        if size(&result)? > max_chars {
            return Err(too_small());
        }
        Ok(result)
    }

    pub(crate) async fn compare(
        &self,
        request: &RequestContext,
        input: &RecordVersionsCompareInput,
    ) -> AgentResult<RecordVersionsComparePage> {
        let max_chars = budget(input.budget_chars)?;
        let (object, before, after) = self.store.with_current(|binding, db| {
            let object = db.source_read_object(request, binding, &input.record)?;
            let target = target(&object)?;
            Ok((
                object,
                db.record_version_get(&target, &input.before_version_id)?,
                db.record_version_get(&target, &input.after_version_id)?,
            ))
        })?;
        let key = object.key()?;
        let mut cursor = CompareCursor {
            object_key: key,
            before_version_id: before.id.clone(),
            after_version_id: after.id.clone(),
            before_hash: before.projection.body_hash.clone(),
            after_hash: after.projection.body_hash.clone(),
            offset: 0,
        };
        if let Some(encoded) = &input.cursor {
            let decoded = cursor_decode(encoded)?;
            if decoded.object_key != cursor.object_key
                || decoded.before_version_id != cursor.before_version_id
                || decoded.after_version_id != cursor.after_version_id
                || decoded.before_hash != cursor.before_hash
                || decoded.after_hash != cursor.after_hash
            {
                return Err(invalid("Comparison cursor does not match versions"));
            }
            cursor.offset = decoded.offset;
        }
        let converted = self.utility.request(&request.request_id, "record.compare", json!({
            "document": before.projection.document, "otherDocument": after.projection.document,
        })).await?;
        let difference: RecordVersionDifference =
            serde_json::from_value(converted).map_err(|_| {
                AgentError::new(
                    ErrorCode::RuntimeIncompatible,
                    "Invalid document utility comparison",
                )
            })?;
        self.store.with_current(|binding, db| {
            let current = db.source_read_object(request, binding, &input.record)?;
            if current != object {
                return Err(AgentError::new(
                    ErrorCode::WorkspaceChanged,
                    "Record binding changed",
                ));
            }
            let target = target(&current)?;
            let latest_before = db.record_version_get(&target, &input.before_version_id)?;
            let latest_after = db.record_version_get(&target, &input.after_version_id)?;
            if latest_before.projection.body_hash != cursor.before_hash
                || latest_after.projection.body_hash != cursor.after_hash
            {
                return Err(AgentError::new(
                    ErrorCode::SourceChanged,
                    "Record versions changed during comparison",
                ));
            }
            Ok(())
        })?;
        let counts = RecordVersionChangeCounts {
            added: difference.added.len(),
            deleted: difference.deleted.len(),
            modified: difference.modified.len(),
            moved: difference.moved.len(),
        };
        let total = counts.added + counts.deleted + counts.modified + counts.moved;
        if cursor.offset > total {
            return Err(invalid("Comparison cursor is beyond the result"));
        }
        let mut result = RecordVersionsComparePage {
            object,
            before_version_id: input.before_version_id.clone(),
            after_version_id: input.after_version_id.clone(),
            counts,
            changes: Vec::new(),
            next_cursor: None,
        };
        if size(&result)? > max_chars {
            return Err(too_small());
        }
        // A complete suffix omits the opaque cursor. Try it first so an
        // exactly fitting complete response never fails due to cursor cost.
        let mut complete_fits = true;
        for index in cursor.offset..total {
            result.changes.push(change_at(&difference, index).expect("bounded comparison index"));
            if size(&result)? > max_chars {
                complete_fits = false;
                break;
            }
        }
        if complete_fits {
            return Ok(result);
        }
        result.changes.clear();
        for index in cursor.offset..total {
            let change = change_at(&difference, index).expect("bounded comparison index");
            result.changes.push(change);
            result.next_cursor = (index + 1 < total).then(|| {
                cursor.offset = index + 1;
                cursor_encode(&cursor).expect("comparison cursor JSON")
            });
            if size(&result)? > max_chars {
                result.changes.pop();
                if result.changes.is_empty() {
                    return Err(too_small());
                }
                cursor.offset = index;
                result.next_cursor = Some(cursor_encode(&cursor)?);
                break;
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
#[path = "record_version_reads_tests.rs"]
mod tests;
