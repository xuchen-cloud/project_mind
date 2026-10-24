//! Window-owned live selections. No document bytes or persistence live here.
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    },
    db::Database,
    file_office::gui_request,
    source_service::BoundSourceStore,
    AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{State, WebviewWindow};
use tokio::sync::oneshot;

pub(crate) const EDIT_TIMEOUT: Duration = Duration::from_secs(30);
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn expired() -> AgentError {
    AgentError::new(
        ErrorCode::ScopeDenied,
        "Office 选区已失效或不属于当前会话，请重新引用",
    )
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Registration {
    pub object: ObjectRef,
    pub editor_id: String,
    pub selection_id: String,
    pub format: String,
    pub text: String,
    pub label: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Bind {
    selection_id: String,
    session_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Editor {
    editor_id: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditRequest {
    pub binding: WorkspaceBinding,
    pub editor_id: String,
    pub selection_id: String,
    pub request_id: String,
    pub change: Value,
    #[serde(skip)]
    pub window: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Reply {
    editor_id: String,
    selection_id: String,
    request_id: String,
    text: Option<String>,
    error: Option<String>,
}
type Receiver = oneshot::Receiver<AgentResult<Value>>;
struct Attempt {
    id: String,
    change: Value,
    claimed: bool,
    result: Option<AgentResult<Value>>,
    waiters: Vec<oneshot::Sender<AgentResult<Value>>>,
    deadline: Instant,
    alive: Arc<AtomicBool>,
}
impl Attempt {
    fn finish(&mut self, result: AgentResult<Value>) {
        if self.result.is_some() {
            return;
        }
        self.result = Some(result.clone());
        for waiter in self.waiters.drain(..) {
            let _ = waiter.send(result.clone());
        }
    }
    fn active(&mut self) -> AgentResult<()> {
        if !self.alive.load(Ordering::SeqCst) || Instant::now() >= self.deadline {
            self.finish(Err(expired()));
            return Err(expired());
        }
        if self.result.is_some() {
            return Err(expired());
        }
        Ok(())
    }
}
struct Selection {
    binding: WorkspaceBinding,
    window: String,
    registration: Registration,
    session_id: Option<String>,
    attempt: Option<Attempt>,
}
#[derive(Default)]
pub(crate) struct Selections {
    entries: Mutex<HashMap<String, Selection>>,
}
pub(crate) enum Dispatch {
    Cached(Value),
    Waiting(Receiver),
    Pending(EditRequest, Receiver),
}
impl Selections {
    fn remove_where(&self, matches: impl Fn(&Selection) -> bool) {
        crate::lock_mutex(&self.entries).retain(|_, s| {
            if !matches(s) {
                return true;
            }
            if let Some(attempt) = s.attempt.as_mut() {
                attempt.finish(Err(expired()));
            }
            false
        });
    }
    pub(crate) fn clear(&self) {
        self.remove_where(|_| true);
    }
    pub(crate) fn close_window(&self, window: &str) {
        self.remove_where(|s| s.window == window);
    }
    pub(crate) fn register(
        &self,
        binding: &WorkspaceBinding,
        window: &str,
        input: Registration,
    ) -> AgentResult<()> {
        if input.object.kind != ObjectKind::File
            || input.object.workspace_id != binding.workspace_id
            || !["docx", "xlsx", "pptx"].contains(&input.format.as_str())
            || input.text.len() > 128 * 1024
            || input.text.trim().is_empty()
            || input.label.len() > 1024
            || [&input.editor_id, &input.selection_id].iter().any(|id| {
                id.is_empty()
                    || id.len() > 128
                    || !id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
            })
        {
            return Err(invalid("无效的 Office 选区"));
        }
        let mut entries = crate::lock_mutex(&self.entries);
        if entries.contains_key(&input.selection_id) {
            return Err(invalid("Office 选区身份已使用"));
        }
        // Replacement cancels pending requests with an explicit result.
        entries.retain(|_, s| {
            if s.binding == *binding
                && !(s.window == window && s.registration.editor_id == input.editor_id)
            {
                return true;
            }
            if let Some(a) = s.attempt.as_mut() {
                a.finish(Err(expired()));
            }
            false
        });
        if entries.len() >= 128 {
            return Err(invalid("Office 选区数量已达上限，请关闭不用的编辑器"));
        }
        entries.insert(
            input.selection_id.clone(),
            Selection {
                binding: binding.clone(),
                window: window.into(),
                registration: input,
                session_id: None,
                attempt: None,
            },
        );
        Ok(())
    }
    pub(crate) fn bind(
        &self,
        binding: &WorkspaceBinding,
        window: &str,
        input: &Bind,
    ) -> AgentResult<()> {
        if input.session_id.is_empty()
            || input.session_id.len() > 512
            || input.session_id.chars().any(char::is_control)
        {
            return Err(invalid("无效会话"));
        }
        let mut entries = crate::lock_mutex(&self.entries);
        let s = entries.get_mut(&input.selection_id).ok_or_else(expired)?;
        if s.binding != *binding
            || s.window != window
            || s.session_id
                .as_ref()
                .is_some_and(|id| id != &input.session_id)
        {
            return Err(expired());
        }
        s.session_id = Some(input.session_id.clone());
        Ok(())
    }
    pub(crate) fn read(
        &self,
        binding: &WorkspaceBinding,
        project_id: impl Into<Option<i64>>,
        session_id: &str,
        id: &str,
    ) -> AgentResult<(ObjectRef, Value)> {
        let project_id = project_id.into();
        let entries = crate::lock_mutex(&self.entries);
        let s = entries.get(id).ok_or_else(expired)?;
        Self::owned(s, binding, project_id, session_id)?;
        Ok((
            s.registration.object.clone(),
            json!({"selectionId":id,"format":s.registration.format,"label":s.registration.label,"text":s.registration.text,"saved":false,"used":s.attempt.is_some()}),
        ))
    }
    fn owned(
        s: &Selection,
        binding: &WorkspaceBinding,
        project_id: impl Into<Option<i64>>,
        session_id: &str,
    ) -> AgentResult<()> {
        let project_id = project_id.into();
        if s.binding != *binding
            || s.registration.object.scope != crate::db::file_scope::scope(project_id)
            || s.session_id.as_deref() != Some(session_id)
        {
            return Err(expired());
        }
        Ok(())
    }
    pub(crate) fn begin(
        &self,
        binding: &WorkspaceBinding,
        project_id: impl Into<Option<i64>>,
        session_id: &str,
        id: &str,
        request_id: &str,
        change: Value,
        alive: Arc<AtomicBool>,
    ) -> AgentResult<Dispatch> {
        let project_id = project_id.into();
        if request_id.is_empty()
            || request_id.len() > 128
            || !change.is_object()
            || change.to_string().len() > 128 * 1024
        {
            return Err(invalid("无效的 Office 修改"));
        }
        let mut entries = crate::lock_mutex(&self.entries);
        let s = entries.get_mut(id).ok_or_else(expired)?;
        Self::owned(s, binding, project_id, session_id)?;
        if let Some(attempt) = s.attempt.as_mut() {
            if attempt.id != request_id || attempt.change != change {
                return Err(AgentError::new(
                    ErrorCode::IdempotencyConflict,
                    "此选区已处理，请重新引用后修改",
                ));
            }
            if let Some(result) = &attempt.result {
                return result.clone().map(Dispatch::Cached);
            }
            attempt.active()?;
            let (sender, receiver) = oneshot::channel();
            attempt.waiters.push(sender);
            return Ok(Dispatch::Waiting(receiver));
        }
        if !alive.load(Ordering::SeqCst) {
            return Err(expired());
        }
        let (sender, receiver) = oneshot::channel();
        let request = EditRequest {
            binding: binding.clone(),
            editor_id: s.registration.editor_id.clone(),
            selection_id: id.into(),
            request_id: request_id.into(),
            change: change.clone(),
            window: s.window.clone(),
        };
        s.attempt = Some(Attempt {
            id: request_id.into(),
            change,
            claimed: false,
            result: None,
            waiters: vec![sender],
            deadline: Instant::now() + EDIT_TIMEOUT,
            alive,
        });
        Ok(Dispatch::Pending(request, receiver))
    }
    fn window_object(
        &self,
        binding: &WorkspaceBinding,
        window: &str,
        editor_id: &str,
        selection_id: &str,
    ) -> AgentResult<ObjectRef> {
        let entries = crate::lock_mutex(&self.entries);
        let s = entries.get(selection_id).ok_or_else(expired)?;
        if s.binding != *binding || s.window != window || s.registration.editor_id != editor_id {
            return Err(expired());
        }
        Ok(s.registration.object.clone())
    }
    pub(crate) fn claim(
        &self,
        binding: &WorkspaceBinding,
        window: &str,
        reply: &Reply,
    ) -> AgentResult<()> {
        let mut entries = crate::lock_mutex(&self.entries);
        let s = entries.get_mut(&reply.selection_id).ok_or_else(expired)?;
        if s.binding != *binding
            || s.window != window
            || s.registration.editor_id != reply.editor_id
        {
            return Err(expired());
        }
        let a = s.attempt.as_mut().ok_or_else(expired)?;
        if a.id != reply.request_id || a.claimed {
            return Err(expired());
        }
        a.active()?;
        a.claimed = true;
        Ok(())
    }
    pub(crate) fn reply(
        &self,
        binding: &WorkspaceBinding,
        window: &str,
        reply: Reply,
    ) -> AgentResult<()> {
        let mut entries = crate::lock_mutex(&self.entries);
        let s = entries.get_mut(&reply.selection_id).ok_or_else(expired)?;
        if s.binding != *binding
            || s.window != window
            || s.registration.editor_id != reply.editor_id
        {
            return Err(expired());
        }
        let a = s.attempt.as_mut().ok_or_else(expired)?;
        if a.id != reply.request_id || !a.claimed {
            return Err(expired());
        }
        a.active()?;
        let result = match (reply.text, reply.error) {
            (Some(text), None) if text.len() <= 128 * 1024 => Ok(
                json!({"selectionId":reply.selection_id,"format":s.registration.format,"text":text,"saved":false,"status":"editor_draft","tracked":s.registration.format=="docx"}),
            ),
            (None, Some(error)) if error.len() <= 4096 => Err(invalid(&error)),
            _ => return Err(invalid("无效的编辑器回执")),
        };
        a.finish(result);
        Ok(())
    }
    pub(crate) fn fail(&self, id: &str, request_id: &str, error: AgentError) {
        let mut entries = crate::lock_mutex(&self.entries);
        if let Some(a) = entries
            .get_mut(id)
            .and_then(|s| s.attempt.as_mut())
            .filter(|a| a.id == request_id)
        {
            a.finish(Err(error));
        }
    }
    fn unregister(&self, binding: &WorkspaceBinding, window: &str, editor_id: &str) {
        self.remove_where(|s| {
            s.binding == *binding && s.window == window && s.registration.editor_id == editor_id
        });
    }
}

// Reuse gui_request while the caller already holds the authoritative Workspace
// and DB locks. This adapter never reacquires those locks.
struct Current<'a>(&'a WorkspaceBinding, &'a Database);
impl crate::committed_changes::CommittedChangePublisher for Current<'_> {
    fn publish_committed(&self, _: crate::committed_changes::CommittedChanges) {
        unreachable!("gui_request only authorizes; it cannot commit");
    }
}
impl BoundSourceStore for Current<'_> {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(self.0, self.1)
    }
}
pub(crate) fn authorize_file(
    binding: &WorkspaceBinding,
    db: &Database,
    id: &str,
    object: &ObjectRef,
    write: bool,
) -> AgentResult<()> {
    gui_request(&Current(binding, db), binding, id, object, write).map(|_| ())
}
#[tauri::command]
pub(crate) fn office_selection_register(
    state: State<'_, AppState>,
    window: WebviewWindow,
    input: Input<Registration>,
) -> ApiResponse<()> {
    let result = state.with_current(|binding, db| {
        crate::file_version_service::validate_binding(&input.binding, binding)?;
        authorize_file(binding, db, &input.request_id, &input.data.object, false)?;
        state
            .office_selections
            .register(binding, window.label(), input.data)
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn office_selection_bind(
    state: State<'_, AppState>,
    window: WebviewWindow,
    input: Input<Bind>,
) -> ApiResponse<()> {
    let result = state.with_current(|binding, _| {
        crate::file_version_service::validate_binding(&input.binding, binding)?;
        state
            .office_selections
            .bind(binding, window.label(), &input.data)
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn office_selection_claim(
    state: State<'_, AppState>,
    window: WebviewWindow,
    input: Input<Reply>,
) -> ApiResponse<()> {
    let result = state.with_current(|binding, db| {
        crate::file_version_service::validate_binding(&input.binding, binding)?;
        let object = state.office_selections.window_object(
            binding,
            window.label(),
            &input.data.editor_id,
            &input.data.selection_id,
        )?;
        authorize_file(binding, db, &input.request_id, &object, true)?;
        state
            .office_selections
            .claim(binding, window.label(), &input.data)
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn office_selection_reply(
    state: State<'_, AppState>,
    window: WebviewWindow,
    input: Input<Reply>,
) -> ApiResponse<()> {
    let result = state.with_current(|binding, db| {
        crate::file_version_service::validate_binding(&input.binding, binding)?;
        let object = state.office_selections.window_object(
            binding,
            window.label(),
            &input.data.editor_id,
            &input.data.selection_id,
        )?;
        authorize_file(binding, db, &input.request_id, &object, true)?;
        state
            .office_selections
            .reply(binding, window.label(), input.data)
    });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn office_selection_unregister(
    state: State<'_, AppState>,
    window: WebviewWindow,
    input: Input<Editor>,
) -> ApiResponse<()> {
    // Teardown may arrive after Workspace close/switch. It only removes the
    // exact old registration and never needs access to the current database.
    state
        .office_selections
        .unregister(&input.binding, window.label(), &input.data.editor_id);
    ApiResponse::from_result(input.request_id, Ok(()))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Selections, WorkspaceBinding) {
        let service = Selections::default();
        let binding = WorkspaceBinding {
            workspace_id: "ws".into(),
            generation: "generation".into(),
        };
        service
            .register(
                &binding,
                "main",
                Registration {
                    object: ObjectRef {
                        workspace_id: "ws".into(),
                        scope: Scope::Project { project_id: 7 },
                        kind: ObjectKind::File,
                        id: "1".into(),
                    },
                    editor_id: "editor".into(),
                    selection_id: "selection".into(),
                    format: "docx".into(),
                    text: "原文".into(),
                    label: "a.docx".into(),
                },
            )
            .unwrap();
        service
            .bind(
                &binding,
                "main",
                &Bind {
                    selection_id: "selection".into(),
                    session_id: "session".into(),
                },
            )
            .unwrap();
        (service, binding)
    }
    #[test]
    fn selection_is_bound_to_window_workspace_project_and_session() {
        let (s, b) = fixture();
        assert_eq!(
            s.read(&b, 7, "session", "selection").unwrap().1["text"],
            "原文"
        );
        assert!(s.read(&b, 8, "session", "selection").is_err());
        assert!(s.read(&b, 7, "other", "selection").is_err());
        let mut changed = b.clone();
        changed.generation = "new".into();
        assert!(s.read(&changed, 7, "session", "selection").is_err());
        assert!(s
            .bind(
                &b,
                "other-window",
                &Bind {
                    selection_id: "selection".into(),
                    session_id: "session".into()
                }
            )
            .is_err());
        assert!(s
            .bind(
                &b,
                "main",
                &Bind {
                    selection_id: "selection".into(),
                    session_id: "other".into()
                }
            )
            .is_err());
    }
    #[tokio::test]
    async fn edit_is_claimed_once_and_retries_return_the_real_draft_receipt() {
        let (s, b) = fixture();
        let change = json!({"text":"润色"});
        let Dispatch::Pending(request, receiver) = s
            .begin(
                &b,
                7,
                "session",
                "selection",
                "call",
                change.clone(),
                Arc::new(AtomicBool::new(true)),
            )
            .unwrap()
        else {
            panic!()
        };
        let reply = || Reply {
            editor_id: "editor".into(),
            selection_id: "selection".into(),
            request_id: "call".into(),
            text: Some("润色".into()),
            error: None,
        };
        assert!(s.reply(&b, "main", reply()).is_err());
        s.claim(&b, "main", &reply()).unwrap();
        assert!(s.claim(&b, "main", &reply()).is_err());
        assert_eq!(request.window, "main");
        s.reply(&b, "main", reply()).unwrap();
        let value = receiver.await.unwrap().unwrap();
        assert_eq!(value["saved"], false);
        let Dispatch::Cached(again) = s
            .begin(
                &b,
                7,
                "session",
                "selection",
                "call",
                change,
                Arc::new(AtomicBool::new(true)),
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(value, again);
        assert!(s
            .begin(
                &b,
                7,
                "session",
                "selection",
                "other",
                json!({"text":"new"}),
                Arc::new(AtomicBool::new(true))
            )
            .is_err());
        s.unregister(&b, "main", "editor");
        assert!(s.read(&b, 7, "session", "selection").is_err());
    }
    #[tokio::test]
    async fn unregister_resolves_waiter_with_explicit_expiry() {
        let (s, b) = fixture();
        let Dispatch::Pending(_, receiver) = s
            .begin(
                &b,
                7,
                "session",
                "selection",
                "call",
                json!({"text":"new"}),
                Arc::new(AtomicBool::new(true)),
            )
            .unwrap()
        else {
            panic!()
        };
        s.unregister(&b, "main", "editor");
        assert!(
            matches!(receiver.await, Ok(Err(_))),
            "unregister must send an expiry result instead of dropping the reply channel"
        );
    }
    #[test]
    fn timed_out_request_cannot_be_claimed_later() {
        let (s, b) = fixture();
        s.begin(
            &b,
            7,
            "session",
            "selection",
            "call",
            json!({"text":"new"}),
            Arc::new(AtomicBool::new(true)),
        )
        .unwrap();
        s.fail("selection", "call", invalid("expired"));
        assert!(s
            .claim(
                &b,
                "main",
                &Reply {
                    editor_id: "editor".into(),
                    selection_id: "selection".into(),
                    request_id: "call".into(),
                    text: None,
                    error: None
                }
            )
            .is_err());
    }
    fn reply_input() -> Reply {
        serde_json::from_value(
            json!({"editorId":"editor","selectionId":"selection","requestId":"call","text":"润色"}),
        )
        .unwrap()
    }
    #[tokio::test]
    async fn concurrent_retries_share_one_actual_editor_result() {
        let (s, b) = fixture();
        let lease = Arc::new(AtomicBool::new(true));
        let change = json!({"text":"润色"});
        let Dispatch::Pending(_, first) = s
            .begin(
                &b,
                7,
                "session",
                "selection",
                "call",
                change.clone(),
                lease.clone(),
            )
            .unwrap()
        else {
            panic!()
        };
        let Dispatch::Waiting(second) = s
            .begin(&b, 7, "session", "selection", "call", change.clone(), lease)
            .unwrap()
        else {
            panic!("duplicate must not dispatch twice")
        };
        assert_eq!(
            s.begin(
                &b,
                7,
                "session",
                "selection",
                "call",
                json!({"text":"other"}),
                Arc::new(AtomicBool::new(true))
            )
            .err()
            .unwrap()
            .code,
            ErrorCode::IdempotencyConflict
        );
        assert!(s.claim(&b, "other-window", &reply_input()).is_err());
        s.claim(&b, "main", &reply_input()).unwrap();
        s.reply(&b, "main", reply_input()).unwrap();
        let result = first.await.unwrap().unwrap();
        assert_eq!(second.await.unwrap().unwrap(), result);
        assert_eq!(result["status"], "editor_draft");
        assert_eq!(result["saved"], false);
    }
    #[tokio::test]
    async fn runtime_revocation_blocks_late_claim_without_waiting_for_monitor() {
        let (s, b) = fixture();
        let lease = Arc::new(AtomicBool::new(true));
        let Dispatch::Pending(_, receiver) = s
            .begin(
                &b,
                7,
                "session",
                "selection",
                "call",
                json!({"text":"new"}),
                lease.clone(),
            )
            .unwrap()
        else {
            panic!()
        };
        lease.store(false, Ordering::SeqCst);
        assert!(s.claim(&b, "main", &reply_input()).is_err());
        assert!(receiver.await.unwrap().is_err());
    }
    #[tokio::test]
    async fn workspace_or_window_invalidation_resolves_waiters_and_prevents_claim() {
        for window in [false, true] {
            let (s, b) = fixture();
            let Dispatch::Pending(_, receiver) = s
                .begin(
                    &b,
                    7,
                    "session",
                    "selection",
                    "call",
                    json!({"text":"new"}),
                    Arc::new(AtomicBool::new(true)),
                )
                .unwrap()
            else {
                panic!()
            };
            if window {
                s.close_window("main");
            } else {
                s.clear();
            }
            assert!(receiver.await.unwrap().is_err());
            assert!(s.claim(&b, "main", &reply_input()).is_err());
        }
    }
    #[tokio::test]
    async fn deadline_blocks_claim_even_without_the_dsh_timeout_task() {
        let (s, b) = fixture();
        let Dispatch::Pending(_, receiver) = s
            .begin(
                &b,
                7,
                "session",
                "selection",
                "call",
                json!({"text":"new"}),
                Arc::new(AtomicBool::new(true)),
            )
            .unwrap()
        else {
            panic!()
        };
        tokio::time::sleep(EDIT_TIMEOUT + Duration::from_millis(10)).await;
        assert!(s.claim(&b, "main", &reply_input()).is_err());
        assert!(receiver.await.unwrap().is_err());
    }
    #[tokio::test]
    async fn runtime_revocation_rejects_a_late_success_reply_after_claim() {
        let (s, b) = fixture();
        let alive = Arc::new(AtomicBool::new(true));
        let Dispatch::Pending(_, receiver) = s
            .begin(
                &b,
                7,
                "session",
                "selection",
                "call",
                json!({"text":"new"}),
                alive.clone(),
            )
            .unwrap()
        else {
            panic!()
        };
        s.claim(&b, "main", &reply_input()).unwrap();
        alive.store(false, Ordering::SeqCst);
        assert!(s.reply(&b, "main", reply_input()).is_err());
        assert!(receiver.await.unwrap().is_err());
        assert!(s
            .begin(
                &b,
                7,
                "session",
                "selection",
                "call",
                json!({"text":"new"}),
                Arc::new(AtomicBool::new(true))
            )
            .is_err());
    }
    #[test]
    fn unregister_old_binding_is_idempotent_and_preserves_new_generation_and_other_windows() {
        let (s, old) = fixture();
        let mut current = old.clone();
        current.generation = "new-generation".into();
        for (window, id) in [("main", "new-main"), ("other-window", "new-other")] {
            s.register(
                &current,
                window,
                Registration {
                    object: ObjectRef {
                        workspace_id: current.workspace_id.clone(),
                        scope: Scope::Project { project_id: 7 },
                        kind: ObjectKind::File,
                        id: "1".into(),
                    },
                    editor_id: "editor".into(),
                    selection_id: id.into(),
                    format: "docx".into(),
                    text: "新选区".into(),
                    label: "a.docx".into(),
                },
            )
            .unwrap();
            s.bind(
                &current,
                window,
                &Bind {
                    selection_id: id.into(),
                    session_id: "session".into(),
                },
            )
            .unwrap();
        }
        s.unregister(&old, "main", "editor");
        s.unregister(&old, "main", "editor");
        assert_eq!(
            s.read(&current, 7, "session", "new-main").unwrap().1["text"],
            "新选区"
        );
        assert!(s.read(&current, 7, "session", "new-other").is_ok());
        s.unregister(&current, "other-window", "editor");
        s.unregister(&current, "other-window", "editor");
        assert!(s.read(&current, 7, "session", "new-main").is_ok());
        assert!(s.read(&current, 7, "session", "new-other").is_err());
        s.unregister(&current, "main", "editor");
        s.unregister(&current, "main", "editor");
        assert!(s.read(&current, 7, "session", "new-main").is_err());
    }
}
