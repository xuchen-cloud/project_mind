//! Search-only keyset cursors. The database counter changes with source data,
//! not connection activity, job polling or CLI transport bookkeeping.
use super::SearchCandidate;
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
    },
    source_service::SourceSearchInput,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Position {
    pub exact: u8,
    pub selected: u8,
    pub updated_at: String,
    pub key: String,
    pub version: i64,
}
impl Ord for Position {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.exact
            .cmp(&other.exact)
            .then(self.selected.cmp(&other.selected))
            .then_with(|| other.updated_at.cmp(&self.updated_at))
            .then(self.key.cmp(&other.key))
            .then(self.version.cmp(&other.version))
    }
}
impl PartialOrd for Position {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Position {
    pub(crate) fn of(item: &SearchCandidate, input: &SourceSearchInput) -> Self {
        Self {
            exact: u8::from(!item.title.eq_ignore_ascii_case(input.query.trim())),
            selected: u8::from(!input.selected.contains(&item.source_ref.object)),
            updated_at: item.updated_at.clone(),
            key: item.object_key.clone(),
            version: -i64::from(
                item.source_ref
                    .file_version
                    .or(item.source_ref.record_version)
                    .unwrap_or(0),
            ),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    context: String,
    epoch: i64,
    expires: i64,
    after: Position,
}
pub(crate) struct State {
    pub epoch: i64,
    secret: String,
    context: String,
    expires: i64,
    pub after: Option<Position>,
}
pub(crate) fn changed() -> AgentError {
    AgentError::new(
        ErrorCode::SourceChanged,
        "Search data, authorization or query changed, or cursor expired; restart the search",
    )
}
fn io(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot access search pagination state")
}
// Persist a tiny invalidation counter rather than hashing or concatenating every
// source body on each page. Update triggers ignore no-op UPDATEs from cache prune.
pub(crate) fn epoch(conn: &Connection) -> AgentResult<(i64, String)> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS source_search_epoch(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,secret TEXT NOT NULL); INSERT OR IGNORE INTO source_search_epoch VALUES(1,0,lower(hex(randomblob(32))));").map_err(io)?;
    const TABLES: &[&str] = &[
        "source_index_snapshots",
        "source_index_chunks",
        "source_access_policies",
        "source_file_version_hashes",
        "record_document_heads",
        "record_versions",
        "notes",
        "workspace_notes",
        "projects",
        "documents",
        "document_versions",
        "todos",
        "voice_records",
        "recording_sessions",
        "voice_transcript_segments",
        "note_tag_links",
        "workspace_note_tag_links",
        "document_tag_links",
        "todo_tag_links",
        "agent_object_withdrawals",
        "agent_knowledge_nodes",
        "agent_knowledge_versions",
        "agent_source_policies",
    ];
    // Only install once per schema: business tables are created during DB open.
    let installed: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='source_search_epoch_installed')", [], |r| r.get(0)).map_err(io)?;
    if !installed {
        let tx = conn.unchecked_transaction().map_err(io)?;
        for table in TABLES {
            let mut stmt = tx
                .prepare(&format!("PRAGMA table_info({table})"))
                .map_err(io)?;
            let columns = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(io)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(io)?;
            if columns.is_empty() {
                continue;
            }
            let changed = columns
                .iter()
                .map(|c| format!("OLD.\"{c}\" IS NOT NEW.\"{c}\""))
                .collect::<Vec<_>>()
                .join(" OR ");
            for (event, condition) in [
                ("INSERT", String::new()),
                ("DELETE", String::new()),
                ("UPDATE", format!(" WHEN {changed}")),
            ] {
                tx.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS source_search_epoch_{table}_{event} AFTER {event} ON {table}{condition} BEGIN UPDATE source_search_epoch SET revision=revision+1 WHERE id=1; END;")).map_err(io)?;
            }
        }
        // Appending transport/tool messages and advancing a session checkpoint do
        // not change a published summary. Track visibility loss and changes to
        // existing evidence, without expiring every cursor after its own tool call.
        for table in [
            "agent_session_search_rows",
            "agent_run_provenance",
            "agent_run_source_dependencies",
        ] {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |r| r.get(0),
                )
                .map_err(io)?;
            if !exists {
                continue;
            }
            let mut stmt = tx
                .prepare(&format!("PRAGMA table_info({table})"))
                .map_err(io)?;
            let columns = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(io)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(io)?;
            let changed = columns
                .iter()
                .map(|c| format!("OLD.\"{c}\" IS NOT NEW.\"{c}\""))
                .collect::<Vec<_>>()
                .join(" OR ");
            for (event, condition) in [
                ("DELETE", String::new()),
                ("UPDATE", format!(" WHEN {changed}")),
            ] {
                tx.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS source_search_epoch_{table}_{event} AFTER {event} ON {table}{condition} BEGIN UPDATE source_search_epoch SET revision=revision+1 WHERE id=1; END;")).map_err(io)?;
            }
        }
        let sessions:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_sessions')", [], |r|r.get(0)).map_err(io)?;
        if sessions {
            tx.execute_batch("CREATE TRIGGER IF NOT EXISTS source_search_epoch_session_visibility AFTER UPDATE ON agent_sessions
                WHEN OLD.scope_key IS NOT NEW.scope_key OR OLD.runtime_id IS NOT NEW.runtime_id
                  OR (OLD.checkpoint_json IS NULL)!=(NEW.checkpoint_json IS NULL)
                BEGIN UPDATE source_search_epoch SET revision=revision+1 WHERE id=1; END;
                CREATE TRIGGER IF NOT EXISTS source_search_epoch_session_delete AFTER DELETE ON agent_sessions
                BEGIN UPDATE source_search_epoch SET revision=revision+1 WHERE id=1; END;").map_err(io)?;
        }
        tx.execute_batch("CREATE TRIGGER IF NOT EXISTS source_search_epoch_installed AFTER DELETE ON source_search_epoch BEGIN SELECT 1; END;").map_err(io)?;
        tx.commit().map_err(io)?;
    }
    conn.query_row(
        "SELECT revision,secret FROM source_search_epoch WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(io)
}
fn context(
    request: &RequestContext,
    binding: &WorkspaceBinding,
    input: &SourceSearchInput,
) -> AgentResult<String> {
    let mut kinds = input
        .kinds
        .iter()
        .map(|k| serde_json::to_string(k).unwrap())
        .collect::<Vec<_>>();
    kinds.sort();
    kinds.dedup();
    let mut selected = input
        .selected
        .iter()
        .map(|o| o.key())
        .collect::<AgentResult<Vec<_>>>()?;
    selected.sort();
    selected.dedup();
    let grant = &request.scope_grant;
    let mut projects = grant.project_ids.clone();
    projects.sort();
    projects.dedup();
    let mut ops = grant.operations.clone();
    ops.sort();
    ops.dedup();
    let mut keys = grant.object_keys.clone();
    if let Some(keys) = &mut keys {
        keys.sort();
        keys.dedup();
    }
    let bytes = serde_json::to_vec(&(
        binding,
        &input.scope,
        &input.query,
        kinds,
        selected,
        input.include_history,
        &grant.workspace_id,
        grant.workspace_content,
        projects,
        ops,
        keys,
        request.caller.key(),
    ))
    .map_err(|_| changed())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
// RFC 2104 HMAC-SHA256, using the per-database random secret. No new dependency.
fn mac(secret: &str, bytes: &[u8]) -> Vec<u8> {
    let key = Sha256::digest(secret.as_bytes());
    let mut inner = [0x36; 64];
    let mut outer = [0x5c; 64];
    for i in 0..key.len() {
        inner[i] ^= key[i];
        outer[i] ^= key[i];
    }
    let mut h = Sha256::new();
    h.update(inner);
    h.update(bytes);
    let mut out = Sha256::new();
    out.update(outer);
    out.update(h.finalize());
    out.finalize().to_vec()
}
impl State {
    pub(crate) fn begin(
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &SourceSearchInput,
        epoch: i64,
        secret: String,
    ) -> AgentResult<Self> {
        let context = context(request, binding, input)?;
        let mut state = Self {
            epoch,
            secret,
            context,
            expires: chrono::Utc::now().timestamp() + 1800,
            after: None,
        };
        if let Some(encoded) = &input.cursor {
            if encoded.len() > 4096 {
                return Err(changed());
            }
            let (body, signature) = encoded.split_once('.').ok_or_else(changed)?;
            let bytes = URL_SAFE_NO_PAD.decode(body).map_err(|_| changed())?;
            let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| changed())?;
            let expected = mac(&state.secret, &bytes);
            if signature.len() != expected.len()
                || signature
                    .iter()
                    .zip(expected)
                    .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                    != 0
            {
                return Err(changed());
            }
            let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| changed())?;
            if cursor.context != state.context
                || cursor.epoch != epoch
                || cursor.expires <= chrono::Utc::now().timestamp()
            {
                return Err(changed());
            }
            state.expires = cursor.expires;
            state.after = Some(cursor.after);
        }
        Ok(state)
    }
    pub(crate) fn encode(&self, after: Position) -> AgentResult<String> {
        let bytes = serde_json::to_vec(&Cursor {
            context: self.context.clone(),
            epoch: self.epoch,
            expires: self.expires,
            after,
        })
        .map_err(|_| changed())?;
        Ok(format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(&bytes),
            URL_SAFE_NO_PAD.encode(mac(&self.secret, &bytes))
        ))
    }
}
// Internal SQL providers use the already-authorized cursor's position. The shared
// service validates its MAC/context/epoch before invoking any provider.
pub(crate) fn position(input: &SourceSearchInput) -> AgentResult<Option<Position>> {
    input
        .cursor
        .as_ref()
        .map(|token| {
            let body = token.split_once('.').ok_or_else(changed)?.0;
            let bytes = URL_SAFE_NO_PAD.decode(body).map_err(|_| changed())?;
            let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| changed())?;
            Ok(cursor.after)
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{
        access::{Caller, ScopeGrant},
        models::Scope,
    };
    fn fixture() -> (RequestContext, SourceSearchInput) {
        let binding = WorkspaceBinding {
            workspace_id: "cursor-test".into(),
            generation: "open-1".into(),
        };
        (
            RequestContext {
                binding: binding.clone(),
                scope_grant: ScopeGrant {
                    workspace_id: binding.workspace_id,
                    workspace_content: true,
                    project_ids: vec![],
                    operations: vec!["source.read".into()],
                    object_keys: None,
                },
                caller: Caller::Gui,
                request_id: "page-1".into(),
            },
            SourceSearchInput {
                scope: Scope::Workspace,
                query: "needle".into(),
                kinds: vec![],
                selected: vec![],
                include_history: false,
                limit: Some(1),
                budget_chars: Some(12000),
                cursor: None,
            },
        )
    }
    #[test]
    fn source_search_cursor_mac_expiration_and_context_are_enforced() {
        let (request, mut input) = fixture();
        let mut state =
            State::begin(&request, &request.binding, &input, 7, "secret".into()).unwrap();
        let position = Position {
            exact: 1,
            selected: 1,
            updated_at: "2026-10-01".into(),
            key: "record".into(),
            version: 0,
        };
        input.cursor = Some(state.encode(position.clone()).unwrap());
        assert_eq!(
            State::begin(&request, &request.binding, &input, 7, "secret".into())
                .unwrap()
                .after,
            Some(position.clone())
        );
        assert!(State::begin(&request, &request.binding, &input, 8, "secret".into()).is_err());
        assert!(State::begin(&request, &request.binding, &input, 7, "another DB".into()).is_err());
        let saved = input.cursor.clone();
        input.cursor.as_mut().unwrap().replace_range(0..1, "!");
        assert_eq!(
            State::begin(&request, &request.binding, &input, 7, "secret".into())
                .err()
                .unwrap()
                .code,
            ErrorCode::SourceChanged
        );
        input.cursor = saved;
        state.expires = chrono::Utc::now().timestamp() - 1;
        input.cursor = Some(state.encode(position).unwrap());
        assert_eq!(
            State::begin(&request, &request.binding, &input, 7, "secret".into())
                .err()
                .unwrap()
                .code,
            ErrorCode::SourceChanged
        );
    }
    #[test]
    fn source_search_epoch_tracks_real_changes_across_connections_and_ignores_noops() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("epoch.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT);INSERT INTO notes VALUES(1,'old');
            CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,scope_key TEXT,runtime_id TEXT,checkpoint_json TEXT,updated_at TEXT);
            INSERT INTO agent_sessions VALUES('s','workspace','builtin-pi','{}','now');
            CREATE TABLE agent_messages(id TEXT PRIMARY KEY,text TEXT);").unwrap();
        let before = epoch(&conn).unwrap();
        conn.execute("UPDATE notes SET title=title", []).unwrap();
        assert_eq!(epoch(&conn).unwrap(), before);
        conn.execute(
            "INSERT INTO agent_messages VALUES('tool-result','done')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE agent_sessions SET checkpoint_json='{\"checksum\":\"new\"}',updated_at='later'",
            [],
        )
        .unwrap();
        assert_eq!(
            epoch(&conn).unwrap(),
            before,
            "tool calls must not invalidate their own pagination"
        );
        let other = Connection::open(&path).unwrap();
        other.execute("UPDATE notes SET title='new'", []).unwrap();
        let after = epoch(&conn).unwrap();
        assert!(after.0 > before.0);
        assert_eq!(after.1, before.1);
        assert_eq!(epoch(&other).unwrap(), after);
    }
}
