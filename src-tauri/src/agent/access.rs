use super::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectRef, Scope, WorkspaceBinding},
};

/// Trusted adapter input, deliberately not Deserialize: tool arguments cannot mint grants.
#[derive(Debug, Clone)]
pub struct ScopeGrant {
    pub workspace_id: String,
    pub workspace_content: bool,
    pub project_ids: Vec<i64>,
    pub operations: Vec<String>,
    pub object_keys: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub enum Caller {
    Gui,
    BuiltinRun { run_id: String },
    Connection { grant_id: String },
}

#[derive(Debug, Clone)]
pub struct RequestContext {
    pub binding: WorkspaceBinding,
    pub scope_grant: ScopeGrant,
    pub caller: Caller,
    pub request_id: String,
}

impl RequestContext {
    pub fn authorize(
        &self,
        current: &WorkspaceBinding,
        scope: &Scope,
        operation: &str,
    ) -> AgentResult<()> {
        if &self.binding != current {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace binding is no longer current",
            ));
        }
        scope.validate()?;
        if self.request_id.is_empty() || self.request_id.len() > 128 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "requestId must contain 1–128 bytes",
            ));
        }
        let scope_allowed = match scope {
            Scope::Workspace => self.scope_grant.workspace_content,
            Scope::Project { project_id } => self.scope_grant.project_ids.contains(project_id),
        };
        if self.scope_grant.workspace_id != current.workspace_id
            || !scope_allowed
            || !self
                .scope_grant
                .operations
                .iter()
                .any(|allowed| allowed == operation)
        {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Operation is outside the granted scope",
            ));
        }
        Ok(())
    }

    /// Resolve ownership from storage first; never authorize a caller-supplied scope alone.
    pub fn authorize_object(
        &self,
        current: &WorkspaceBinding,
        claimed: &ObjectRef,
        resolved: &ObjectRef,
        operation: &str,
    ) -> AgentResult<()> {
        if claimed != resolved || resolved.workspace_id != current.workspace_id {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Object is outside the granted scope",
            ));
        }
        self.authorize(current, &resolved.scope, operation)?;
        self.require_object_allowed(resolved)
    }

    /// Only the object allowlist check. Callers must first resolve and authorize
    /// the object's actual scope and ownership from native storage.
    pub(crate) fn require_object_allowed(&self, object: &ObjectRef) -> AgentResult<()> {
        if let Some(keys) = &self.scope_grant.object_keys {
            if !keys.contains(&object.key()?) {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Object is outside the granted connection objects",
                ));
            }
        }
        Ok(())
    }

    /// Scope summaries can include objects outside an object-limited grant.
    pub fn require_scope_context(&self) -> AgentResult<()> {
        if self.scope_grant.object_keys.is_some() {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Object-limited connection: use source.search or direct Record/File reads",
            ));
        }
        Ok(())
    }
}

impl Caller {
    pub fn key(&self) -> String {
        match self {
            Self::Gui => "gui".into(),
            Self::BuiltinRun { run_id } => format!("run:{run_id}"),
            Self::Connection { grant_id } => format!("connection:{grant_id}"),
        }
    }
}
