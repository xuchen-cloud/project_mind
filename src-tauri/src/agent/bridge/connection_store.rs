//! Recheck the live connection at every storage phase of a shared async read.
use super::protocol::CallInput;
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
        tools::BoundReadContextStore,
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    source_service::BoundSourceStore,
};
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) struct ConnectionStore<'a, S> {
    pub inner: &'a S,
    pub enabled: &'a AtomicBool,
    pub token: &'a str,
    pub input: &'a CallInput,
}

impl<S: BoundReadContextStore> ConnectionStore<'_, S> {
    pub fn with_authenticated<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database, &str, RequestContext) -> AgentResult<T>,
    ) -> AgentResult<T> {
        self.inner.with_current_context(|binding, db, name| {
            if !self.enabled.load(Ordering::Acquire) {
                return Err(AgentError::new(
                    ErrorCode::RuntimeUnavailable,
                    "External connections are disabled",
                ));
            }
            if binding != &self.input.binding {
                return Err(AgentError::new(
                    ErrorCode::WorkspaceChanged,
                    "Workspace changed; reconnect explicitly",
                ));
            }
            let request = db.agent_connection_authenticate(
                binding,
                &self.input.grant_id,
                self.token,
                &self.input.request_id,
            )?;
            action(binding, db, name, request)
        })
    }
}

impl<S: BoundReadContextStore> BoundReadContextStore for ConnectionStore<'_, S> {
    fn with_current_context<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database, &str) -> AgentResult<T>,
    ) -> AgentResult<T> {
        self.with_authenticated(|binding, db, name, _| action(binding, db, name))
    }
}

impl<S: BoundReadContextStore> BoundSourceStore for ConnectionStore<'_, S> {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        self.with_current_context(|binding, db, _| action(binding, db))
    }
}

impl<S: CommittedChangePublisher> CommittedChangePublisher for ConnectionStore<'_, S> {
    fn publish_committed(&self, changes: CommittedChanges) {
        self.inner.publish_committed(changes);
    }
}

impl<S: BoundReadContextStore + crate::record_document_service::BoundRecordStore + Sync>
    crate::record_document_service::BoundRecordStore for ConnectionStore<'_, S>
{
    async fn flush_editors(
        &self,
        binding: &WorkspaceBinding,
        target: &crate::record_documents::RecordTarget,
    ) -> AgentResult<()> {
        self.with_authenticated(|_, _, _, _| Ok(()))?;
        self.inner.flush_editors(binding, target).await?;
        self.with_authenticated(|_, _, _, _| Ok(()))
    }

    async fn submission_lock(
        &self,
        binding: &WorkspaceBinding,
        target: &crate::record_documents::RecordTarget,
    ) -> AgentResult<Option<tokio::sync::OwnedMutexGuard<()>>> {
        self.with_authenticated(|_, _, _, _| Ok(()))?;
        let guard = self.inner.submission_lock(binding, target).await?;
        self.with_authenticated(|_, _, _, _| Ok(()))?;
        Ok(guard)
    }

    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        self.with_authenticated(|binding, db, _, _| action(binding, db))
    }
}
