//! Memory uses the same private, lifecycle-bound bridge as native File reads.
//! Semantic intent is interpreted in the actual user turn by DSH; no keyword
//! classifier or model-supplied confirmation flag can mint a native identity.
use super::*;
use crate::db::memory_facts::{MemoryAccess, MemoryOrigin, MemoryRequest, MemoryScope};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserMessage {
    id: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemoryFrame {
    operation: String,
    session_id: String,
    request: MemoryRequest,
    origin: String,
    mode: String,
    user_message: Option<UserMessage>,
    #[serde(default)]
    source_refs: Vec<crate::agent::models::SourceRef>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BehaviorFrame {
    operation: String,
    session_id: String,
    action: String,
    origin: String,
    mode: String,
    user_message: Option<UserMessage>,
    expected_revision: Option<String>,
    content: Option<String>,
}

fn validate_behavior(frame: &BehaviorFrame) -> Result<(), String> {
    if frame.operation != "memoryBehavior"
        || !valid_identity(&frame.session_id)
        || !matches!(frame.action.as_str(), "read" | "write")
        || frame.origin != "user"
    {
        return Err("无效记忆行为请求".into());
    }
    validate_evidence(&frame.mode, &frame.user_message, frame.action == "write")?;
    if frame.action == "write"
        && (frame.expected_revision.as_deref().is_none_or(str::is_empty) || frame.content.is_none())
    {
        return Err("修改记忆行为需要当前版本和完整内容".into());
    }
    Ok(())
}

fn validate_evidence(
    mode: &str,
    message: &Option<UserMessage>,
    mutation: bool,
) -> Result<(), String> {
    if !matches!(mode, "read-only" | "workspace-write" | "danger-full-access") {
        return Err("无法核验记忆操作的执行模式".into());
    }
    if mutation && mode == "read-only" {
        return Err("只读模式不能修改记忆".into());
    }
    if let Some(message) = message {
        if !valid_identity(&message.id) || message.text.trim().is_empty() {
            return Err("记忆操作缺少真实用户消息".into());
        }
    } else if mutation {
        return Err("记忆修改必须绑定真实用户消息".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryFrame {
    operation: String,
    session_id: String,
    origin: String,
    mode: String,
    user_message: Option<UserMessage>,
    #[serde(default)]
    query: String,
    cursor: Option<String>,
    limit: usize,
    budget_chars: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduleFrame {
    operation: String,
    session_id: String,
    origin: String,
    mode: String,
    user_message: Option<UserMessage>,
    action: String,
    input: Option<crate::memory_maintenance::MemoryScheduleUpdate>,
}

enum BridgeFrame {
    Memory(MemoryFrame),
    Adoption(AdoptionFrame),
    Behavior(BehaviorFrame),
    History(HistoryFrame),
    Schedule(ScheduleFrame),
}
impl BridgeFrame {
    fn parse(payload: serde_json::Value) -> Result<Self, String> {
        match payload["operation"].as_str() {
            Some("memory") => serde_json::from_value(payload).map(Self::Memory),
            Some("memoryAdoption") => serde_json::from_value(payload).map(Self::Adoption),
            Some("memoryBehavior") => serde_json::from_value(payload).map(Self::Behavior),
            Some("projectHistory") => serde_json::from_value(payload).map(Self::History),
            _ => serde_json::from_value(payload).map(Self::Schedule),
        }
        .map_err(|_| "无效记忆服务请求".into())
    }
    fn session_id(&self) -> &str {
        match self {
            Self::Memory(f) => &f.session_id,
            Self::Adoption(f) => &f.session_id,
            Self::Behavior(f) => &f.session_id,
            Self::History(f) => &f.session_id,
            Self::Schedule(f) => &f.session_id,
        }
    }
    fn validate(&mut self, identity: &Identity) -> Result<Option<MemoryAccess>, String> {
        if !valid_identity(self.session_id()) {
            return Err("无效记忆会话".into());
        }
        match self {
            Self::Memory(frame) => return prepare(identity, frame).map(Some),
            Self::Adoption(frame) => {
                if frame.operation != "memoryAdoption"
                    || !valid_identity(&frame.request_id)
                    || frame.strategy != "snapshot"
                    || frame.facts.len() > 10000
                    || frame.omitted_ids.len() > 10000
                    || frame
                        .facts
                        .iter()
                        .any(|f| !valid_identity(&f.id) || f.revision == 0)
                {
                    return Err("无效记忆采用记录".into());
                }
            }
            Self::Behavior(frame) => validate_behavior(frame)?,
            Self::History(frame) => {
                if frame.operation != "projectHistory" || frame.origin != "user" {
                    return Err("无效项目历史请求".into());
                }
                validate_evidence(&frame.mode, &frame.user_message, false)?;
            }
            Self::Schedule(frame) => {
                if frame.operation != "memorySchedule"
                    || frame.origin != "user"
                    || !matches!(frame.action.as_str(), "read" | "write")
                {
                    return Err("无效记忆调度请求".into());
                }
                validate_evidence(&frame.mode, &frame.user_message, frame.action == "write")?;
                if frame.action == "write" && frame.input.is_none() {
                    return Err("缺少记忆调度设置".into());
                }
            }
        }
        Ok(None)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdoptedFact {
    id: String,
    revision: u64,
    condition: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdoptionFrame {
    operation: String,
    turn: u32,
    step: u32,
    session_id: String,
    request_id: String,
    facts: Vec<AdoptedFact>,
    omitted_ids: Vec<String>,
    strategy: String,
    budget_chars: usize,
}

fn scope(identity: &Identity) -> MemoryScope {
    match identity.project_id() {
        Some(project_id) => MemoryScope::Project { project_id },
        None => MemoryScope::Workspace,
    }
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

fn prepare(identity: &Identity, frame: &mut MemoryFrame) -> Result<MemoryAccess, String> {
    if frame.operation != "memory" || !valid_identity(&frame.session_id) {
        return Err("无效记忆会话请求".into());
    }
    let mutation = !matches!(
        frame.request,
        MemoryRequest::List { .. } | MemoryRequest::Context { .. }
    );
    validate_evidence(&frame.mode, &frame.user_message, mutation)?;
    let origin = match frame.origin.as_str() {
        "user" => MemoryOrigin::User,
        "organization" => MemoryOrigin::Organization,
        _ => return Err("无效记忆操作来源".into()),
    };
    let source_scope = scope(identity);
    let mut sources = Vec::new();
    if let Some(message) = &frame.user_message {
        sources.push(
            serde_json::from_value(serde_json::json!({
                "kind":"message", "id":message.id, "scope":source_scope,
                "label":"用户会话", "excerpt":message.text.chars().take(2000).collect::<String>(),
                "sessionId":frame.session_id, "messageId":message.id
            }))
            .map_err(|_| "无效记忆来源")?,
        );
    }
    // Request IDs from different Sessions must never alias a committed receipt.
    let request_id = match &mut frame.request {
        MemoryRequest::Apply { request_id, .. }
        | MemoryRequest::Rollback { request_id, .. }
        | MemoryRequest::Approve { request_id, .. }
        | MemoryRequest::Reject { request_id, .. } => Some(request_id),
        _ => None,
    };
    if let Some(id) = request_id {
        if !valid_identity(id) {
            return Err("无效记忆操作身份".into());
        }
        *id = format!(
            "dsh:{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    &frame.session_id,
                    frame.user_message.as_ref().map(|m| &m.id),
                    &*id,
                ))
                .map_err(|_| "无效记忆操作身份")?
            )
        );
    }
    Ok(MemoryAccess {
        scope: source_scope,
        origin,
        sources,
    })
}

// The caller first validates the frame and authenticates its actual Session,
// Workspace lifecycle, and execution mode. This shared dispatch owns native
// operations, so deterministic runtime tests exercise exactly the shipping path.
fn execute_frame(
    db: &crate::db::Database,
    identity: &Identity,
    binding: &crate::agent::models::WorkspaceBinding,
    root: &Path,
    frame: BridgeFrame,
    mut access: Option<MemoryAccess>,
) -> Result<serde_json::Value, String> {
    match frame {
        BridgeFrame::Adoption(frame) => {
            db.memory_adoption_record(
                &scope(identity),
                &frame.session_id,
                &frame.request_id,
                &serde_json::to_value(&frame).map_err(|_| "无效记忆采用记录")?,
            )?;
            Ok(serde_json::Value::Null)
        }
        BridgeFrame::Behavior(frame) => {
            let result = if frame.action == "write" {
                crate::memory_behavior::save(
                    root,
                    frame
                        .expected_revision
                        .as_deref()
                        .ok_or("缺少记忆行为版本")?,
                    frame.content.as_deref().ok_or("缺少记忆行为内容")?,
                )?
            } else {
                crate::memory_behavior::read(root)?
            };
            let mut value = serde_json::to_value(result).map_err(|e| e.to_string())?;
            if frame.action == "write" {
                value["receipt"] =
                    serde_json::json!("已保存记忆行为，新规则从下一次模型请求生效。");
            }
            Ok(value)
        }
        BridgeFrame::History(frame) => db.memory_project_history(
            &MemoryAccess {
                scope: scope(identity),
                origin: MemoryOrigin::User,
                sources: vec![],
            },
            &frame.query,
            frame.cursor.as_deref(),
            frame.limit,
            frame.budget_chars,
        ),
        BridgeFrame::Schedule(frame) => {
            let native_scope = match identity.project_id() {
                Some(project_id) => crate::agent::models::Scope::Project { project_id },
                None => crate::agent::models::Scope::Workspace,
            };
            let result = if frame.action == "write" {
                crate::memory_maintenance::save_schedule(
                    db,
                    binding,
                    &native_scope,
                    frame.input.ok_or("缺少调度设置")?,
                )
            } else {
                crate::memory_maintenance::read_schedule(db, binding, &native_scope)
            }
            .map_err(|e| e.message)?;
            let mut value = serde_json::to_value(result).map_err(|e| e.to_string())?;
            if frame.action == "write" {
                value["receipt"] = serde_json::json!("记忆整理时间已保存。");
            }
            Ok(value)
        }
        BridgeFrame::Memory(frame) => {
            let access = access.as_mut().ok_or("缺少记忆授权")?;
            if !frame.source_refs.is_empty() {
                access.sources.extend(db.memory_verified_sources(
                    binding,
                    &access.scope,
                    &frame.session_id,
                    &frame.source_refs,
                )?);
            }
            let context = matches!(frame.request, MemoryRequest::Context { .. });
            let list = matches!(frame.request, MemoryRequest::List { .. });
            let mut result = db.memory_execute(access, frame.request)?;
            if list {
                for fact in result["facts"].as_array_mut().ok_or("无效记忆列表")? {
                    for source in fact["sources"].as_array_mut().ok_or("无效记忆来源列表")?
                    {
                        let typed: crate::db::memory_facts::MemorySource =
                            serde_json::from_value(source.clone()).map_err(|_| "无效记忆来源")?;
                        source["availability"] =
                            serde_json::json!(db.memory_source_availability(binding, &typed)?);
                    }
                }
            }
            if context {
                result["behavior"] = serde_json::to_value(crate::memory_behavior::read(root)?)
                    .map_err(|e| e.to_string())?;
            }
            Ok(result)
        }
    }
}

pub(super) fn with_memory(
    app: tauri::AppHandle,
    identity: Identity,
    source: SourceHandler,
) -> SourceHandler {
    Arc::new(move |payload, revoked, url, frame_id, alive| {
        if !matches!(
            payload["operation"].as_str(),
            Some(
                "memory"
                    | "memoryAdoption"
                    | "memoryBehavior"
                    | "projectHistory"
                    | "memorySchedule"
            )
        ) {
            return source(payload, revoked, url, frame_id, alive);
        }
        if revoked.load(Ordering::SeqCst) || !alive.load(Ordering::SeqCst) {
            return Err("记忆助手已停止".into());
        }
        let mut frame = BridgeFrame::parse(payload)?;
        let access = frame.validate(&identity)?;
        // Resolve actual Session ownership outside Workspace/database locks.
        let client = session_http_client()?;
        let value = tokio::runtime::Handle::current().block_on(session_request(
            url,
            &client,
            &mut None,
            SessionRequest::List,
        ))?;
        let list: SessionListValue =
            serde_json::from_value(value).map_err(|_| "无法核验记忆会话")?;
        if !list.items.iter().any(|item| {
            item.id == frame.session_id()
                && item
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| Path::new(cwd) == identity.directory())
        }) {
            return Err("记忆会话不属于当前范围".into());
        }
        let state = app.state::<crate::AppState>();
        let current = crate::lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or("记忆工作区已关闭")?;
        if !identity.matches_workspace(&runtime.agent_binding, &runtime.paths.root_path)
            || !runtime.ai_secrets_unlocked()
        {
            return Err("记忆工作区绑定已失效".into());
        }
        let mut db = crate::lock_mutex(&runtime.db);
        identity.validate_context(&mut db, &runtime.paths.root_path)?;
        if revoked.load(Ordering::SeqCst) || !alive.load(Ordering::SeqCst) {
            return Err("记忆助手已停止".into());
        }
        execute_frame(
            &db,
            &identity,
            &runtime.agent_binding,
            &runtime.paths.root_path,
            frame,
            access,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity() -> Identity {
        Identity {
            workspace_id: "workspace".into(),
            workspace_generation: "generation".into(),
            root: PathBuf::from("/workspace"),
            fingerprint: String::new(),
            context: AssistantContext::Workspace {
                directory: PathBuf::from("/workspace"),
            },
        }
    }
    fn frame(session: &str) -> MemoryFrame {
        serde_json::from_value(serde_json::json!({"operation":"memory","sessionId":session,
            "mode":"workspace-write","origin":"user","userMessage":{"id":"message-1","text":"记住我喜欢中文"},
            "request":{"operation":"apply","requestId":"call-1","changes":[]}})).unwrap()
    }
    #[test]
    fn memory_writes_require_real_user_context_and_writable_mode() {
        let mut input = frame("session-1");
        input.user_message = None;
        assert!(prepare(&identity(), &mut input).is_err());
        let mut input = frame("session-1");
        input.mode = "read-only".into();
        assert!(prepare(&identity(), &mut input).is_err());
    }
    #[test]
    fn memory_receipts_are_session_bound_and_evidence_uses_host_message() {
        let mut a = frame("session-a");
        let mut b = frame("session-b");
        let access = prepare(&identity(), &mut a).unwrap();
        prepare(&identity(), &mut b).unwrap();
        assert_ne!(
            serde_json::to_value(a.request).unwrap()["requestId"],
            serde_json::to_value(b.request).unwrap()["requestId"]
        );
        assert_eq!(access.sources[0].message_id.as_deref(), Some("message-1"));
        assert_eq!(access.sources[0].excerpt, "记住我喜欢中文");
        assert_eq!(access.scope, MemoryScope::Workspace);
    }
}

#[cfg(test)]
#[path = "dsh_memory_integration_tests.rs"]
pub(super) mod integration_tests;

#[cfg(test)]
mod frame_tests {
    use super::*;
    use serde_json::{json, Value};

    fn invoke(
        db: &crate::db::Database,
        identity: &Identity,
        payload: Value,
    ) -> Result<Value, String> {
        let mut frame = BridgeFrame::parse(payload)?;
        let access = frame.validate(identity)?;
        execute_frame(
            db,
            identity,
            &crate::agent::models::WorkspaceBinding {
                workspace_id: identity.workspace_id.clone(),
                generation: identity.workspace_generation.clone(),
            },
            &identity.root,
            frame,
            access,
        )
    }
    fn fixture() -> (tempfile::TempDir, crate::db::Database, Identity, Identity) {
        let root = tempfile::tempdir().unwrap();
        let mut db =
            crate::db::Database::open(&root.path().join("frames.sqlite"), root.path(), None)
                .unwrap();
        db.bind_native_workspace("frames").unwrap();
        let mut identities = Vec::new();
        for name in ["Current", "Other"] {
            let project = db
                .project_create(crate::models::ProjectCreateInput {
                    name: name.into(),
                    summary: None,
                    status: None,
                })
                .unwrap();
            identities.push(Identity {
                workspace_id: "frames".into(),
                workspace_generation: "open-one".into(),
                root: root.path().into(),
                fingerprint: String::new(),
                context: AssistantContext::Project(
                    ProjectContext::resolve(&mut db, root.path(), project.id).unwrap(),
                ),
            });
        }
        let other = identities.pop().unwrap();
        let current = identities.pop().unwrap();
        (root, db, current, other)
    }
    fn envelope(operation: &str) -> Value {
        json!({"operation":operation,"sessionId":"real-test-session","mode":"workspace-write","origin":"user","userMessage":{"id":"human-request","text":"查看项目历史并修改整理时间"}})
    }
    #[test]
    fn schedule_dispatch_uses_native_settings_cas_and_refuses_readonly_or_nonhuman_writes() {
        let (_root, db, current, _other) = fixture();
        let mut read = envelope("memorySchedule");
        read["action"] = json!("read");
        let before = invoke(&db, &current, read.clone()).unwrap();
        assert!(before.get("receipt").is_none());
        let mut write = envelope("memorySchedule");
        write["action"] = json!("write");
        write["input"] = json!({"enabled":true,"intervalHours":48,"localTime":"07:45","timezone":"Asia/Shanghai","expectedRevision":before["revision"]});
        for (field, value) in [
            ("mode", json!("read-only")),
            ("userMessage", Value::Null),
            ("origin", json!("organization")),
        ] {
            let mut refused = write.clone();
            refused[field] = value;
            assert!(invoke(&db, &current, refused).is_err());
            assert_eq!(invoke(&db, &current, read.clone()).unwrap(), before);
        }
        let saved = invoke(&db, &current, write.clone()).unwrap();
        assert_eq!(saved["localTime"], "07:45");
        assert_eq!(saved["revision"], before["revision"].as_u64().unwrap() + 1);
        assert_eq!(saved["receipt"], "记忆整理时间已保存。");
        assert!(invoke(&db, &current, write)
            .unwrap_err()
            .contains("重新读取"));
        let after = invoke(&db, &current, read).unwrap();
        assert_eq!(after["revision"], saved["revision"]);
        assert_eq!(after["localTime"], "07:45");
    }
    #[test]
    fn project_history_dispatch_is_project_bound_and_keeps_history_out_of_current_facts() {
        let (_root, db, current, other) = fixture();
        for (identity, text) in [
            (&current, "old agreement"),
            (&other, "FOREIGN_PRIVATE_HISTORY"),
        ] {
            let access = MemoryAccess {
                scope: scope(identity),
                origin: MemoryOrigin::User,
                sources: vec![],
            };
            let added=db.memory_execute(&access,MemoryRequest::Apply {request_id:text.into(),changes:vec![json!({"action":"add","scope":scope(identity),"category":"agreement","content":text})]}).unwrap();
            if identity.project_id() == current.project_id() {
                db.memory_execute(&access,MemoryRequest::Apply {request_id:"correct".into(),changes:vec![json!({"action":"patch","scope":scope(identity),"id":added["facts"][0]["id"],"expectedRevision":1,"content":"current agreement"})]}).unwrap();
            }
        }
        let mut history = envelope("projectHistory");
        history["query"] = json!("");
        history["cursor"] = Value::Null;
        history["limit"] = json!(20);
        history["budgetChars"] = json!(8000);
        let result = invoke(&db, &current, history.clone()).unwrap();
        assert_eq!(result["historical"], true);
        assert_eq!(result["events"].as_array().unwrap().len(), 2);
        assert!(result.to_string().contains("old agreement"));
        assert!(!result.to_string().contains("FOREIGN_PRIVATE_HISTORY"));
        let current_facts = db
            .memory_execute(
                &MemoryAccess {
                    scope: scope(&current),
                    origin: MemoryOrigin::User,
                    sources: vec![],
                },
                MemoryRequest::Context {
                    scope: scope(&current),
                    query: String::new(),
                    budget_chars: 6000,
                    strategy: "snapshot".into(),
                },
            )
            .unwrap();
        assert!(!current_facts.to_string().contains("old agreement"));
        assert!(current_facts.to_string().contains("current agreement"));
        let mut forged = history.clone();
        forged["projectId"] = json!(other.project_id().unwrap());
        assert!(invoke(&db, &current, forged).is_err());
        let workspace = Identity {
            context: AssistantContext::Workspace {
                directory: current.root.clone(),
            },
            ..current
        };
        assert!(invoke(&db, &workspace, history)
            .unwrap_err()
            .contains("Project access"));
    }
    #[test]
    fn list_dispatch_reports_removed_original_without_erasing_conclusion_or_reference() {
        let (_root, mut db, current, _other) = fixture();
        let project = current.project_id().unwrap();
        std::fs::write(
            current.directory().join("source.txt"),
            "actual source bytes",
        )
        .unwrap();
        let file = db
            .project_file_register("frames", project, "source.txt")
            .unwrap();
        let reference = crate::agent::models::SourceRef {
            object: file.object,
            revision: file.content_hash.unwrap(),
            file_version: Some(file.version_number),
            record_version: None,
            block_id: None,
            locator: None,
            title: "source.txt".into(),
            excerpt: "actual source bytes".into(),
        };
        let source=serde_json::from_value(json!({"kind":"file","id":reference.object.id,"scope":scope(&current),"label":"source.txt","excerpt":"actual source bytes","reference":reference})).unwrap();
        db.memory_execute(&MemoryAccess {scope:scope(&current),origin:MemoryOrigin::User,sources:vec![source]},MemoryRequest::Apply {request_id:"source-conclusion".into(),changes:vec![json!({"action":"add","scope":scope(&current),"category":"agreement","content":"retained conclusion"})]}).unwrap();
        let mut list = envelope("memory");
        list["request"] = json!({"operation":"list","scope":scope(&current)});
        let available = invoke(&db, &current, list.clone()).unwrap();
        assert_eq!(
            available["facts"][0]["sources"][0]["availability"],
            "available"
        );
        db.document_delete(crate::models::DocumentDeleteInput {
            document_id: reference.object.id.parse().unwrap(),
        })
        .unwrap();
        let removed = invoke(&db, &current, list).unwrap();
        assert_eq!(removed["facts"][0]["content"], "retained conclusion");
        assert_eq!(
            removed["facts"][0]["sources"][0]["availability"],
            "source_removed"
        );
        assert_eq!(
            removed["facts"][0]["sources"][0]["reference"],
            serde_json::to_value(reference).unwrap()
        );
    }
}
