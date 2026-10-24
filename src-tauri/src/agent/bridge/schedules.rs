//! Workspace task management shared by the installed CLI and embedded shells.
use super::{connection_store::ConnectionStore, protocol::CallInput, registry};
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{Scope, WorkspaceBinding},
    },
    AppState,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{atomic::AtomicBool, Arc};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleRule {
    pub kind: ScheduleKind,
    pub start_date: String,
    pub time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekdays: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day_of_month: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleKind {
    Hours,
    Days,
    Weekdays,
    Weeks,
    Monthly,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledTaskInput {
    pub title: String,
    pub prompt: String,
    pub session_id: String,
    pub enabled: bool,
    pub rule: ScheduleRule,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScheduleListInput {}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleCreateInput {
    pub request_id: String,
    pub input: ScheduledTaskInput,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScheduleUpdate {
    pub id: String,
    pub task: ScheduledTaskInput,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScheduleIdentity {
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleUpdateInput {
    pub request_id: String,
    pub input: ScheduleUpdate,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDeleteInput {
    pub request_id: String,
    pub input: ScheduleIdentity,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleRunInput {
    pub request_id: String,
    pub input: ScheduleIdentity,
}

fn invalid() -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, "Invalid scheduled task input")
}

fn authorize(
    request: &RequestContext,
    binding: &WorkspaceBinding,
    method: &str,
) -> AgentResult<()> {
    request.authorize(
        binding,
        &Scope::Workspace,
        if method == "schedule.list" {
            "schedule.read"
        } else {
            "schedule.manage"
        },
    )?;
    if request.scope_grant.object_keys.is_some() {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Scheduled tasks require an unrestricted Workspace grant",
        ));
    }
    Ok(())
}

fn runtime_request(method: &str, params: &Value) -> AgentResult<Value> {
    registry::validate(method, params)?;
    match method {
        "schedule.list" => Ok(json!({"operation":"list"})),
        "schedule.create" => {
            let value: ScheduleCreateInput =
                serde_json::from_value(params.clone()).map_err(|_| invalid())?;
            Ok(json!({"operation":"create","requestId":value.request_id,"task":value.input}))
        }
        "schedule.update" => {
            let value: ScheduleUpdateInput =
                serde_json::from_value(params.clone()).map_err(|_| invalid())?;
            Ok(
                json!({"operation":"update","requestId":value.request_id,"id":value.input.id,"task":value.input.task}),
            )
        }
        "schedule.run" => {
            let value: ScheduleRunInput =
                serde_json::from_value(params.clone()).map_err(|_| invalid())?;
            Ok(json!({"operation":"run","requestId":value.request_id,"id":value.input.id}))
        }
        "schedule.delete" => {
            let value: ScheduleDeleteInput =
                serde_json::from_value(params.clone()).map_err(|_| invalid())?;
            Ok(json!({"operation":"delete","requestId":value.request_id,"id":value.input.id}))
        }
        _ => Err(invalid()),
    }
}

pub(crate) async fn execute(
    app: &tauri::AppHandle,
    enabled: &Arc<AtomicBool>,
    token: &str,
    input: CallInput,
) -> AgentResult<Value> {
    let request = runtime_request(&input.method, &input.params)?;
    if input.method != "schedule.list"
        && input.params["requestId"].as_str() != Some(input.request_id.as_str())
    {
        return Err(invalid());
    }
    let state = app.state::<AppState>();
    let connection = ConnectionStore {
        inner: &*state,
        enabled,
        token,
        input: &input,
    };
    let check = || {
        connection.with_authenticated(|binding, _, _, request| {
            authorize(&request, binding, &input.method)
        })
    };
    check()?;
    let result = crate::dsh_assistant::scheduled_request_with_admission(
        app,
        &input.binding,
        request,
        || check().map_err(|error| error.message),
    )
    .await;
    check()?;
    result.map_err(|error| AgentError::new(ErrorCode::RuntimeUnavailable, error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::access::{Caller, ScopeGrant};

    #[test]
    fn schedule_management_requires_explicit_workspace_authority() {
        let binding = WorkspaceBinding {
            workspace_id: "workspace".into(),
            generation: "generation".into(),
        };
        let mut request = RequestContext {
            binding: binding.clone(),
            request_id: "request".into(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![1],
                operations: vec!["source.read".into()],
                object_keys: None,
            },
        };
        assert!(authorize(&request, &binding, "schedule.create").is_err());
        request.scope_grant.operations = vec!["schedule.read".into()];
        assert!(authorize(&request, &binding, "schedule.list").is_ok());
        assert!(authorize(&request, &binding, "schedule.create").is_err());
        assert!(authorize(&request, &binding, "schedule.run").is_err());
        request
            .scope_grant
            .operations
            .push("schedule.manage".into());
        assert!(authorize(&request, &binding, "schedule.create").is_ok());
        assert!(authorize(&request, &binding, "schedule.run").is_ok());
        request.scope_grant.workspace_content = false;
        assert!(authorize(&request, &binding, "schedule.run").is_err());
        assert!(authorize(&request, &binding, "schedule.create").is_err());
        request.scope_grant.workspace_content = true;
        request.scope_grant.object_keys = Some(vec![]);
        assert!(authorize(&request, &binding, "schedule.list").is_err());
        request.scope_grant.object_keys = None;
        let other = WorkspaceBinding {
            generation: "reopened".into(),
            ..binding
        };
        assert!(authorize(&request, &other, "schedule.create").is_err());
    }

    #[test]
    fn cli_schedule_mutations_keep_request_identity_and_reject_forged_fields() {
        let task = json!({"title":"日报","prompt":"总结所有项目","sessionId":"session","enabled":true,
            "rule":{"kind":"weekdays","startDate":"2026-10-26","time":"09:00"}});
        let input = json!({"requestId":"stable","input":task});
        assert_eq!(
            runtime_request("schedule.create", &input).unwrap(),
            json!({"operation":"create","requestId":"stable","task":task})
        );
        let mut forged = input.clone();
        forged["input"]["timeZone"] = json!("UTC");
        assert!(runtime_request("schedule.create", &forged).is_err());
        assert!(runtime_request("schedule.create", &json!({"input":task})).is_err());
        assert!(runtime_request("schedule.list", &json!({"workspaceId":"other"})).is_err());
        assert_eq!(
            runtime_request(
                "schedule.delete",
                &json!({"requestId":"delete","input":{"id":"task"}})
            )
            .unwrap(),
            json!({"operation":"delete","requestId":"delete","id":"task"})
        );
    }
}
