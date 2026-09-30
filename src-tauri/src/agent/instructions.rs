//! User-authored constraints, separate from generated knowledge and QuickNote.
use super::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::Scope,
};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextInstruction {
    pub id: String,
    pub scope: Scope,
    pub text: String,
    pub enabled: bool,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionUpsert {
    pub scope: Scope,
    pub id: Option<String>,
    pub text: String,
    pub enabled: bool,
    pub expected_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionDelete {
    pub scope: Scope,
    pub id: String,
    pub expected_revision: u64,
}
pub fn validate_instruction_id(id: &str) -> AgentResult<()> {
    if id.len() != 32
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid instruction ID",
        ));
    }
    Ok(())
}
impl InstructionUpsert {
    pub fn validate(&self) -> AgentResult<()> {
        self.scope.validate()?;
        if self.text.trim().is_empty()
            || self.text.chars().count() > 2000
            || self.expected_revision > i64::MAX as u64 - 1
            || (self.id.is_none() && self.expected_revision != 0)
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Instruction needs 1–2000 characters and a valid baseline",
            ));
        }
        if let Some(id) = &self.id {
            validate_instruction_id(id)?;
        }
        Ok(())
    }
}
pub trait InstructionRepository {
    fn agent_instructions_list(
        &self,
        scope: &Scope,
        after_id: Option<&str>,
        limit: u16,
    ) -> AgentResult<Vec<ContextInstruction>>;
    fn agent_instruction_upsert(
        &self,
        caller_id: &str,
        request_id: &str,
        input: &InstructionUpsert,
    ) -> AgentResult<ContextInstruction>;
    fn agent_instruction_delete(
        &self,
        caller_id: &str,
        request_id: &str,
        input: &InstructionDelete,
    ) -> AgentResult<bool>;
}
