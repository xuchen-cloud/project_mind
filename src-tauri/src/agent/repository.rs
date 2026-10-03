use super::{context::ScopeIdentity, errors::AgentResult, models::Scope};

/// Metadata-only seam. Implementations must not fetch Record/QuickNote bodies for L0.
/// Configuration, ownership and knowledge have separate repository boundaries.
pub trait ContextRepository {
    fn scope_identity(&self, scope: &Scope) -> AgentResult<Option<ScopeIdentity>>;
    fn context_entry(
        &self,
        _request: &super::access::RequestContext,
        _binding: &super::models::WorkspaceBinding,
        input: &super::context::ContextGetInput,
        identity: ScopeIdentity,
    ) -> AgentResult<super::context::ContextEntry> {
        super::context::ContextEntry::not_built(identity, input.budget_chars)
    }
}

/// Ownership is resolved from authoritative business rows, never from the supplied scope.
pub trait ObjectRepository {
    fn resolve_object(
        &self,
        object: &super::models::ObjectRef,
        workspace_id: &str,
    ) -> AgentResult<Option<super::models::ObjectRef>>;
}
