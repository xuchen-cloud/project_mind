//! Trusted GUI navigation for cited Record and Transcript sources. This is not
//! a model tool and supplies no file paths or write capabilities.
use super::{
    access::{Caller, RequestContext, ScopeGrant},
    errors::{AgentResult, ApiResponse},
    models::{ObjectRef, Scope, SourceLocator, SourceRef, WorkspaceBinding},
};
use crate::{record_documents::RecordTarget, source_service::BoundSourceStore};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceNavigationStatus {
    Current,
    Changed,
    Historical,
    NotFound,
    NotReady,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceLocationStatus {
    NotRequested,
    Available,
    Missing,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceNavigation {
    pub object: ObjectRef,
    pub status: SourceNavigationStatus,
    pub record_target: Option<RecordTarget>,
    /// Actual semantic revision of the selected head or historical snapshot.
    pub current_revision: Option<String>,
    pub revision_matches: Option<bool>,
    pub record_version: Option<u32>,
    pub record_version_id: Option<String>,
    /// Numeric revision of the selected head/snapshot, never the latest head
    /// when the citation explicitly selects a historical Record Version.
    pub head_revision: Option<u64>,
    pub block_id: Option<String>,
    pub block_status: SourceLocationStatus,
    pub voice_record_id: Option<i64>,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub time_status: SourceLocationStatus,
}
impl SourceNavigation {
    pub(crate) fn unavailable(source: &SourceRef, status: SourceNavigationStatus) -> Self {
        Self {
            object: source.object.clone(),
            status,
            record_target: None,
            current_revision: None,
            revision_matches: None,
            record_version: source.record_version,
            record_version_id: None,
            head_revision: None,
            block_id: None,
            block_status: if source.block_id.is_some() {
                SourceLocationStatus::Missing
            } else {
                SourceLocationStatus::NotRequested
            },
            voice_record_id: None,
            start_ms: None,
            end_ms: None,
            time_status: if matches!(source.locator, Some(SourceLocator::Time { .. })) {
                SourceLocationStatus::Missing
            } else {
                SourceLocationStatus::NotRequested
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceResolveInput {
    binding: WorkspaceBinding,
    request_id: String,
    #[serde(deserialize_with = "strict_source_ref")]
    data: SourceRef,
}
fn strict_source_ref<'de, D: Deserializer<'de>>(deserializer: D) -> Result<SourceRef, D::Error> {
    let value = Value::deserialize(deserializer)?;
    let fields = value
        .as_object()
        .ok_or_else(|| serde::de::Error::custom("SourceRef must be an object"))?;
    if fields.keys().any(|key| {
        ![
            "object",
            "revision",
            "fileVersion",
            "recordVersion",
            "blockId",
            "locator",
            "title",
            "excerpt",
        ]
        .contains(&key.as_str())
    }) {
        return Err(serde::de::Error::custom("Unknown SourceRef field"));
    }
    if let Some(locator) = fields.get("locator").filter(|value| !value.is_null()) {
        let locator = locator
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("Invalid source locator"))?;
        let allowed: &[&str] = match locator.get("kind").and_then(Value::as_str) {
            Some("paragraph") => &["kind", "start", "end"],
            Some("time") => &["kind", "startMs", "endMs"],
            _ => return Err(serde::de::Error::custom("Unsupported navigation locator")),
        };
        if locator.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(serde::de::Error::custom("Unknown navigation locator field"));
        }
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

#[tauri::command]
pub(crate) fn agent_source_resolve(
    state: tauri::State<'_, crate::AppState>,
    input: SourceResolveInput,
) -> ApiResponse<SourceNavigation> {
    let started = std::time::Instant::now();
    let request = RequestContext {
        binding: input.binding,
        request_id: input.request_id.clone(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            object_keys: None,
            workspace_id: input.data.object.workspace_id.clone(),
            workspace_content: input.data.object.scope == Scope::Workspace,
            project_ids: match input.data.object.scope {
                Scope::Project { project_id } => vec![project_id],
                _ => vec![],
            },
            operations: vec!["source.read".into()],
        },
    };
    let result: AgentResult<_> =
        state.with_current(|binding, db| db.agent_source_resolve(&request, binding, &input.data));
    let paths = crate::lock_mutex(&state.current_workspace).as_ref().filter(|runtime| runtime.agent_binding == request.binding).map(|runtime| runtime.paths.clone());
    if let Some(paths) = paths {
        let unavailable = result.as_ref().is_ok_and(|navigation| !matches!(navigation.status, SourceNavigationStatus::Current | SourceNavigationStatus::Historical));
        super::local_metrics::record_outcome(&paths, "source.resolve", started,
            result.as_ref().err().map(|error| error.code).or(if unavailable { Some(super::errors::ErrorCode::NotFound) } else { None }), 1);
    }
    ApiResponse::from_result(input.request_id, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn source_navigation_command_rejects_authority_and_unknown_nested_fields() {
        let source = json!({"object":{"workspaceId":"w","scope":{"kind":"workspace"},"kind":"record","id":"1"},"revision":format!("sha256:{}", "a".repeat(64)),"title":"Record","excerpt":""});
        let mut input = json!({"binding":{"workspaceId":"w","generation":"g"},"requestId":"read","data":source});
        assert!(serde_json::from_value::<SourceResolveInput>(input.clone()).is_ok());
        input["caller"] = json!("gui");
        assert!(serde_json::from_value::<SourceResolveInput>(input.clone()).is_err());
        input.as_object_mut().unwrap().remove("caller");
        input["data"]["scopeGrant"] = json!({"workspaceContent":true});
        assert!(serde_json::from_value::<SourceResolveInput>(input.clone()).is_err());
        input["data"].as_object_mut().unwrap().remove("scopeGrant");
        input["data"]["locator"] = json!({"kind":"paragraph","start":1,"end":1,"path":"/tmp/file"});
        assert!(serde_json::from_value::<SourceResolveInput>(input).is_err());
    }
}
