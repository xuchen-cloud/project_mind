use super::{
    agent_operations::{io_error, OperationChange},
    Database,
};
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    instructions::{
        validate_instruction_id, ContextInstruction, InstructionDelete, InstructionRepository,
        InstructionUpsert,
    },
    models::Scope,
};
use chrono::Utc;
use rand::RngCore;
use rusqlite::{params, OptionalExtension};

impl InstructionRepository for Database {
    fn agent_instructions_list(
        &self,
        scope: &Scope,
        after_id: Option<&str>,
        limit: u16,
    ) -> AgentResult<Vec<ContextInstruction>> {
        scope.validate()?;
        if !(1..=100).contains(&limit) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Instruction limit must be 1–100",
            ));
        }
        if let Some(id) = after_id {
            validate_instruction_id(id)?;
        }
        let mut stmt = self.conn.prepare("SELECT id,text,enabled,revision,created_at,updated_at FROM agent_context_instructions WHERE scope_key=?1 AND id>?2 ORDER BY id LIMIT ?3").map_err(io_error)?;
        let result = stmt
            .query_map(params![scope.key(), after_id.unwrap_or(""), limit], |row| {
                Ok(ContextInstruction {
                    id: row.get(0)?,
                    scope: scope.clone(),
                    text: row.get(1)?,
                    enabled: row.get(2)?,
                    revision: row.get::<_, i64>(3)? as u64,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error);
        result
    }
    fn agent_instruction_upsert(
        &self,
        caller_id: &str,
        request_id: &str,
        input: &InstructionUpsert,
    ) -> AgentResult<ContextInstruction> {
        input.validate()?;
        self.agent_atomic_operation(caller_id, request_id, "context.instruction.upsert", input, |tx| {
            let mut bytes = [0u8;16]; rand::thread_rng().fill_bytes(&mut bytes);
            let id = input.id.clone().unwrap_or_else(|| bytes.iter().map(|b| format!("{b:02x}")).collect());
            let existing = tx.query_row("SELECT scope_key,revision,created_at FROM agent_context_instructions WHERE id=?1", [&id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?))).optional().map_err(io_error)?;
            if existing.as_ref().is_some_and(|(scope,_,_)| scope != &input.scope.key()) { return Err(AgentError::new(ErrorCode::ScopeDenied, "Instruction is outside this scope")); }
            if existing.as_ref().map_or(0,|(_,revision,_)| *revision as u64) != input.expected_revision { return Err(AgentError::new(ErrorCode::RevisionConflict, "Instruction changed; reload before saving")); }
            let now = Utc::now().to_rfc3339();
            let instruction = ContextInstruction { id, scope: input.scope.clone(), text: input.text.clone(), enabled: input.enabled, revision: input.expected_revision+1, created_at: existing.map_or_else(|| now.clone(),|(_,_,created)| created), updated_at: now };
            tx.execute("INSERT INTO agent_context_instructions(id,scope_key,text,enabled,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET text=excluded.text,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at", params![instruction.id,instruction.scope.key(),instruction.text,instruction.enabled,instruction.revision as i64,instruction.created_at,instruction.updated_at]).map_err(io_error)?;
            let change = OperationChange { object_key: format!("agent_instruction/{}",instruction.id), scope: instruction.scope.clone(), revision: instruction.revision.to_string() };
            Ok((instruction,Some(change)))
        })
    }
    fn agent_instruction_delete(
        &self,
        caller_id: &str,
        request_id: &str,
        input: &InstructionDelete,
    ) -> AgentResult<bool> {
        input.scope.validate()?;
        validate_instruction_id(&input.id)?;
        if input.expected_revision == 0 || input.expected_revision > i64::MAX as u64 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid instruction baseline",
            ));
        }
        self.agent_atomic_operation(
            caller_id,
            request_id,
            "context.instruction.delete",
            input,
            |tx| {
                let existing = tx
                    .query_row(
                        "SELECT scope_key,revision FROM agent_context_instructions WHERE id=?1",
                        [&input.id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .optional()
                    .map_err(io_error)?;
                let (scope, revision) = existing
                    .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Instruction not found"))?;
                if scope != input.scope.key() {
                    return Err(AgentError::new(
                        ErrorCode::ScopeDenied,
                        "Instruction is outside this scope",
                    ));
                }
                if revision as u64 != input.expected_revision {
                    return Err(AgentError::new(
                        ErrorCode::RevisionConflict,
                        "Instruction changed; reload before deleting",
                    ));
                }
                tx.execute(
                    "DELETE FROM agent_context_instructions WHERE id=?1",
                    [&input.id],
                )
                .map_err(io_error)?;
                Ok((
                    true,
                    Some(OperationChange {
                        object_key: format!("agent_instruction/{}", input.id),
                        scope: input.scope.clone(),
                        revision: revision.to_string(),
                    }),
                ))
            },
        )
    }
}
impl InstructionRepository for super::agent::WorkspaceContextRepository<'_> {
    fn agent_instructions_list(
        &self,
        scope: &Scope,
        after_id: Option<&str>,
        limit: u16,
    ) -> AgentResult<Vec<ContextInstruction>> {
        self.db.agent_instructions_list(scope, after_id, limit)
    }
    fn agent_instruction_upsert(
        &self,
        caller_id: &str,
        request_id: &str,
        input: &InstructionUpsert,
    ) -> AgentResult<ContextInstruction> {
        self.db
            .agent_instruction_upsert(caller_id, request_id, input)
    }
    fn agent_instruction_delete(
        &self,
        caller_id: &str,
        request_id: &str,
        input: &InstructionDelete,
    ) -> AgentResult<bool> {
        self.db
            .agent_instruction_delete(caller_id, request_id, input)
    }
}
