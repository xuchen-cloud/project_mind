use super::{
    access::RequestContext,
    context::{ContextEntry, ContextGetInput},
    errors::{AgentError, AgentResult, ErrorCode},
    models::WorkspaceBinding,
    repository::ContextRepository,
};

/// GUI now, bridge and Pi tools later: one service, one bound Workspace repository.
pub struct AgentDomainService<'a, R: ContextRepository> {
    binding: &'a WorkspaceBinding,
    repository: &'a R,
}
impl<'a, R: ContextRepository> AgentDomainService<'a, R> {
    pub fn new(binding: &'a WorkspaceBinding, repository: &'a R) -> Self {
        Self {
            binding,
            repository,
        }
    }
    pub fn context_get(
        &self,
        request: &RequestContext,
        input: ContextGetInput,
    ) -> AgentResult<ContextEntry> {
        request.authorize(self.binding, &input.scope, "context.read")?;
        if input
            .query
            .as_ref()
            .is_some_and(|query| query.chars().count() > 2_000)
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "query exceeds 2000 characters",
            ));
        }
        let identity = self
            .repository
            .scope_identity(&input.scope)?
            .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Scope not found"))?;
        self.repository.context_entry(request, self.binding, &input, identity)
    }
}

impl<
        R: ContextRepository
            + super::repository::ObjectRepository
            + super::settings::SettingsRepository,
    > AgentDomainService<'_, R>
{
    pub fn settings_get(
        &self,
        request: &RequestContext,
        scope: super::models::Scope,
    ) -> AgentResult<super::settings::AgentScopeSettings> {
        request.authorize(self.binding, &scope, "settings.read")?;
        self.require_scope(&scope)?;
        self.repository.agent_settings_get(&scope)
    }
    pub fn settings_update(
        &self,
        request: &RequestContext,
        input: super::settings::SettingsUpdate,
    ) -> AgentResult<super::settings::AgentScopeSettings> {
        use super::models::{ObjectKind, ObjectRef, Scope};
        request.authorize(self.binding, &input.settings.scope, "settings.write")?;
        if !matches!(request.caller, super::access::Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Only the user can change assistant settings",
            ));
        }
        input.validate()?;
        self.require_scope(&input.settings.scope)?;
        if let Some(id) = input.settings.goal_record_id {
            if !matches!(input.settings.scope, Scope::Project { .. }) || id <= 0 {
                return Err(AgentError::new(
                    ErrorCode::InvalidArgument,
                    "A goal must be a Project Record",
                ));
            }
            self.require_object(
                request,
                &ObjectRef {
                    workspace_id: self.binding.workspace_id.clone(),
                    scope: input.settings.scope.clone(),
                    kind: ObjectKind::Record,
                    id: id.to_string(),
                },
                "settings.write",
            )?;
        }
        for pin in &input.settings.pinned_refs {
            self.require_object(request, pin, "settings.write")?;
        }
        self.repository
            .agent_settings_update(&request.caller.key(), &request.request_id, &input)
    }
    fn require_scope(&self, scope: &super::models::Scope) -> AgentResult<()> {
        self.repository
            .scope_identity(scope)?
            .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Scope not found"))?;
        Ok(())
    }
    fn require_object(
        &self,
        request: &RequestContext,
        object: &super::models::ObjectRef,
        operation: &str,
    ) -> AgentResult<()> {
        request.authorize(self.binding, &object.scope, operation)?;
        object.key()?;
        if object.workspace_id != self.binding.workspace_id {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Object is outside this Workspace",
            ));
        }
        let resolved = self
            .repository
            .resolve_object(object, &self.binding.workspace_id)?
            .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Object not found"))?;
        request.authorize_object(self.binding, object, &resolved, operation)
    }
}

impl<R: ContextRepository + super::instructions::InstructionRepository> AgentDomainService<'_, R> {
    fn authorize_user_instruction(
        &self,
        request: &RequestContext,
        scope: &super::models::Scope,
        operation: &str,
    ) -> AgentResult<()> {
        request.authorize(self.binding, scope, operation)?;
        if !matches!(request.caller, super::access::Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Only the user can change context instructions",
            ));
        }
        self.repository
            .scope_identity(scope)?
            .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Scope not found"))?;
        Ok(())
    }
    pub fn instructions_list(
        &self,
        request: &RequestContext,
        scope: super::models::Scope,
        after_id: Option<&str>,
        limit: u16,
    ) -> AgentResult<Vec<super::instructions::ContextInstruction>> {
        request.authorize(self.binding, &scope, "settings.read")?;
        self.repository
            .scope_identity(&scope)?
            .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Scope not found"))?;
        self.repository
            .agent_instructions_list(&scope, after_id, limit)
    }
    pub fn instruction_upsert(
        &self,
        request: &RequestContext,
        input: super::instructions::InstructionUpsert,
    ) -> AgentResult<super::instructions::ContextInstruction> {
        self.authorize_user_instruction(request, &input.scope, "settings.write")?;
        input.validate()?;
        self.repository
            .agent_instruction_upsert(&request.caller.key(), &request.request_id, &input)
    }
    pub fn instruction_delete(
        &self,
        request: &RequestContext,
        input: super::instructions::InstructionDelete,
    ) -> AgentResult<bool> {
        self.authorize_user_instruction(request, &input.scope, "settings.write")?;
        self.repository
            .agent_instruction_delete(&request.caller.key(), &request.request_id, &input)
    }
}

impl<R: ContextRepository + super::changes::ChangeRepository> AgentDomainService<'_, R> {
    pub fn changes_list(
        &self,
        request: &RequestContext,
        input: super::changes::ChangeInput,
    ) -> AgentResult<super::changes::ChangePage> {
        let scope = if request.scope_grant.workspace_content {
            super::models::Scope::Workspace
        } else {
            super::models::Scope::Project {
                project_id: request
                    .scope_grant
                    .project_ids
                    .first()
                    .copied()
                    .ok_or_else(|| {
                        AgentError::new(ErrorCode::ScopeDenied, "No content scope granted")
                    })?,
            }
        };
        request.authorize(self.binding, &scope, "changes.read")?;
        self.repository
            .agent_changes_list(&request.scope_grant, &input)
    }
}
