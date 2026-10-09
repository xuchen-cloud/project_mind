//! Evidence receipts can only be minted by actual authorized source reads.
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, SourceRef, WorkspaceBinding},
    },
    db::Database,
    record_document_service::DocumentUtility,
    source_file_snapshot::{FileReadPlan, FileStamp, FileVerification},
    source_service::{
        BoundSourceStore, SourceReadInput, SourceReadPage, SourceReadTarget, SourceService,
        SourceUtility,
    },
    source_session_read::SessionHistoryUtility,
};
use std::sync::Mutex;

fn changed() -> AgentError {
    AgentError::new(ErrorCode::SourceChanged, "Overview evidence source changed")
}
fn not_ready() -> AgentError {
    AgentError::new(
        ErrorCode::SourceNotReady,
        "Session evidence is not available",
    )
}
fn stamp(plan: &FileReadPlan) -> AgentResult<FileStamp> {
    let file = crate::source_file_snapshot::open_regular(&plan.path)?;
    let metadata = file
        .metadata()
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot inspect evidence File"))?;
    Ok(FileStamp::from_metadata(&metadata))
}
fn target(reference: &SourceRef, exact: bool) -> SourceReadTarget {
    SourceReadTarget {
        object: reference.object.clone(),
        revision: exact.then(|| reference.revision.clone()),
        record_version: reference.record_version,
        file_version: reference.file_version,
    }
}
fn revision(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    source: &SourceReadTarget,
) -> AgentResult<String> {
    match source.object.kind {
        ObjectKind::Record => Ok(db
            .source_record_fingerprint(request, binding, source)?
            .revision),
        ObjectKind::File => Ok(db
            .source_file_plan(request, binding, source)?
            .registered_hash),
        ObjectKind::Project | ObjectKind::Todo | ObjectKind::QuickNote | ObjectKind::Transcript => {
            Ok(db
                .source_native_snapshot(request, binding, source)?
                .revision)
        }
        ObjectKind::SessionMessage => Ok(db.source_session_record(request,binding,source)?.text_hash),
        ObjectKind::SessionSummary => Err(not_ready()),
    }
}
struct FileEvidence {
    plan: FileReadPlan,
    receipt: FileVerification,
    prepared: Mutex<Option<FileStamp>>,
}
pub(crate) struct CapturedEvidence {
    binding: WorkspaceBinding,
    caller: String,
    reference: SourceRef,
    file: Option<FileEvidence>,
}
impl CapturedEvidence {
    pub(crate) fn reference(&self) -> &SourceRef {
        &self.reference
    }
    pub(crate) fn matches(&self, reference: &SourceRef) -> bool {
        serde_json::to_value(&self.reference)
            .ok()
            .zip(serde_json::to_value(reference).ok())
            .is_some_and(|(a, b)| a == b)
    }
    /// Hash/byte verification is deliberately outside the database callback.
    pub(crate) async fn verify_file(&self) -> AgentResult<()> {
        if let Some(file) = &self.file {
            let before = stamp(&file.plan)?;
            crate::source_file_snapshot::verify_file_receipt(&file.plan, &file.receipt).await?;
            if stamp(&file.plan)? != before {
                return Err(changed());
            }
            *file.prepared.lock().map_err(|_| changed())? = Some(before);
        }
        Ok(())
    }
    pub(crate) fn verify(
        &self,
        db: &Database,
        request: &RequestContext,
        binding: &WorkspaceBinding,
    ) -> AgentResult<()> {
        if binding != &self.binding || request.binding != self.binding {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Evidence binding changed",
            ));
        }
        if request.caller.key() != self.caller {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Evidence belongs to another caller",
            ));
        }
        let source = target(&self.reference, true);
        if let Some(file) = &self.file {
            if db.source_file_plan(request, binding, &source)? != file.plan {
                return Err(changed());
            }
            let prepared = file.prepared.lock().map_err(|_| changed())?;
            if prepared.as_ref() != Some(&stamp(&file.plan)?) {
                return Err(changed());
            }
        } else if revision(db, request, binding, &source)? != self.reference.revision {
            return Err(changed());
        }
        Ok(())
    }
}
pub(crate) async fn capture<S: BoundSourceStore, R: DocumentUtility, F: SourceUtility>(
    store: &S,
    request: &RequestContext,
    input: &SourceReadInput,
    record_utility: &R,
    file_utility: &F,
) -> AgentResult<(SourceReadPage, CapturedEvidence)> {
    let service = SourceService::new(store);
    let (page, file) = match input.source.object.kind {
        ObjectKind::Record => (
            service.read_record(request, input, record_utility).await?,
            None,
        ),
        ObjectKind::QuickNote => (
            service
                .read_quick_note(request, input, record_utility)
                .await?,
            None,
        ),
        ObjectKind::Project | ObjectKind::Todo | ObjectKind::Transcript => {
            (service.read_native(request, input)?, None)
        }
        ObjectKind::File => {
            let (page, plan, receipt) = service
                .read_file_verified(request, input, file_utility)
                .await?;
            (
                page,
                Some(FileEvidence {
                    plan,
                    receipt,
                    prepared: Mutex::new(None),
                }),
            )
        }
        ObjectKind::SessionSummary | ObjectKind::SessionMessage => return Err(not_ready()),
    };
    let evidence = CapturedEvidence {
        binding: request.binding.clone(),
        caller: request.caller.key(),
        reference: page.source_ref.clone(),
        file,
    };
    evidence.verify_file().await?;
    store.with_current(|binding, db| evidence.verify(db, request, binding))?;
    Ok((page, evidence))
}

/// Capture a message only after an authorized read of its original Pi JSONL.
pub(crate) async fn capture_session<S:BoundSourceStore,U:SessionHistoryUtility>(store:&S,request:&RequestContext,input:&SourceReadInput,utility:&U)->AgentResult<(SourceReadPage,CapturedEvidence)> {
    if input.source.object.kind!=ObjectKind::SessionMessage {return Err(not_ready());}
    let page=SourceService::new(store).read_session(request,input,utility).await?;
    let evidence=CapturedEvidence {binding:request.binding.clone(),caller:request.caller.key(),reference:page.source_ref.clone(),file:None};
    store.with_current(|binding,db|evidence.verify(db,request,binding))?;
    Ok((page,evidence))
}
/// Authorize the retained version first; compare with the current semantic head.
/// File bytes require an external FileReferenceProof before releasing body.
pub(crate) fn reference_state(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    reference: &SourceRef,
) -> AgentResult<bool> {
    let retained = revision(db, request, binding, &target(reference, false))?;
    let mut current = target(reference, false);
    current.record_version = None;
    current.file_version = None;
    let current_revision = revision(db, request, binding, &current)?;
    let different_file_version = if reference.object.kind == ObjectKind::File {
        db.source_file_plan(request, binding, &current)?
            .file_version
            != reference.file_version.unwrap_or(0)
    } else {
        false
    };
    Ok(retained != reference.revision
        || current_revision != reference.revision
        || different_file_version)
}
pub(crate) fn reference_file_plan(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    reference: &SourceRef,
) -> AgentResult<Option<FileReadPlan>> {
    if reference.object.kind != ObjectKind::File {
        return Ok(None);
    }
    Ok(Some(db.source_file_plan(
        request,
        binding,
        &target(reference, false),
    )?))
}
/// A read-side byte proof retains no source text, and is checked again at release.
pub(crate) struct FileReferenceProof {
    plan: FileReadPlan,
    stamp: FileStamp,
}
impl FileReferenceProof {
    pub(crate) async fn prepare(plan: FileReadPlan) -> AgentResult<Self> {
        let before = stamp(&plan)?;
        crate::source_file_snapshot::capture_file(&plan).await?;
        if stamp(&plan)? != before {
            return Err(changed());
        }
        Ok(Self {
            plan,
            stamp: before,
        })
    }
    pub(crate) fn verify(
        &self,
        db: &Database,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        reference: &SourceRef,
    ) -> AgentResult<()> {
        if reference_file_plan(db, request, binding, reference)?.as_ref() != Some(&self.plan)
            || stamp(&self.plan)? != self.stamp
        {
            return Err(changed());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            models::{ObjectRef, Scope},
        },
        models::{TodoCreateInput, TodoScope, TodoUpdateContentInput},
        source_service::SourceReadView,
    };
    struct Store {
        binding: WorkspaceBinding,
        db: Mutex<Database>,
    }
    impl crate::committed_changes::CommittedChangePublisher for Store {
        fn publish_committed(&self, _: crate::committed_changes::CommittedChanges) {}
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding, &self.db.lock().unwrap())
        }
    }
    struct UnusedUtility;
    impl DocumentUtility for UnusedUtility {
        async fn request(
            &self,
            _: &str,
            _: &str,
            _: serde_json::Value,
        ) -> AgentResult<serde_json::Value> {
            panic!("native evidence does not invoke a converter")
        }
    }
    impl SourceUtility for UnusedUtility {
        async fn request(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &[u8],
        ) -> AgentResult<serde_json::Value> {
            panic!("native evidence does not invoke a file worker")
        }
    }
    #[tokio::test]
    async fn overview_evidence_native_receipt_rejects_forgery_changes_and_wrong_scope() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("evidence.sqlite"), root.path(), None).unwrap();
        let todo = db
            .todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                content: "实际待办交付证据".into(),
                priority: "high".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "evidence-workspace".into(),
            generation: "one".into(),
        };
        let store = Store {
            binding: binding.clone(),
            db: Mutex::new(db),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::BuiltinRun {
                run_id: "run-one".into(),
            },
            request_id: "capture".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["source.read".into()],
            },
        };
        let mut input = SourceReadInput {
            source: SourceReadTarget {
                object: ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: Scope::Workspace,
                    kind: ObjectKind::Todo,
                    id: todo.id.to_string(),
                },
                revision: None,
                record_version: None,
                file_version: None,
            },
            view: SourceReadView::Full,
            selection: None,
            cursor: None,
            budget_chars: None,
        };
        let (page, evidence) = capture(&store, &request, &input, &UnusedUtility, &UnusedUtility)
            .await
            .unwrap();
        assert!(page.text.contains("实际待办交付证据"));
        assert!(evidence.matches(&page.source_ref));
        let mut forged = page.source_ref.clone();
        forged.excerpt = "模型杜撰证据".into();
        assert!(!evidence.matches(&forged));
        store
            .with_current(|binding, db| evidence.verify(db, &request, binding))
            .unwrap();
        input.source.object.scope = Scope::Project { project_id: 99 };
        assert!(
            capture(&store, &request, &input, &UnusedUtility, &UnusedUtility)
                .await
                .is_err()
        );
        store
            .db
            .lock()
            .unwrap()
            .todo_update_content(TodoUpdateContentInput { expected_revision: todo.revision,
                todo_id: todo.id,
                content: "修改后的实际内容".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap();
        assert_eq!(
            store
                .with_current(|binding, db| evidence.verify(db, &request, binding))
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
        assert!(store
            .with_current(|binding, db| reference_state(
                db,
                &request,
                binding,
                evidence.reference()
            ))
            .unwrap());
        let mut denied = request.clone();
        denied.scope_grant.workspace_content = false;
        assert_eq!(
            store
                .with_current(|binding, db| reference_state(
                    db,
                    &denied,
                    binding,
                    evidence.reference()
                ))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
}
