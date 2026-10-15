//! Shared native Todo revision heads and immutable recovery snapshots.
//! Readers never create a baseline. Mutation helpers use the caller's existing
//! business transaction; only the formal migration owns its schema savepoint.
use super::Database;
use crate::{
    agent::errors::{AgentError, AgentResult, ErrorCode},
    models::TodoScope,
};
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(super) const TODO_REVISION_SCHEMA_VERSION: i64 = 31;
const TODO_REVISION_SCHEMA_SQL: &str = r#"
CREATE TABLE todo_revision_snapshots (
 id TEXT PRIMARY KEY CHECK(length(id)=32 AND id NOT GLOB '*[^0-9a-f]*'),
 todo_id INTEGER NOT NULL CHECK(todo_id>0),
 revision INTEGER NOT NULL CHECK(revision>0),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 created_at TEXT NOT NULL,
 operation_id TEXT,
 UNIQUE(todo_id,revision)
);
CREATE TABLE todo_revision_heads (
 todo_id INTEGER PRIMARY KEY REFERENCES todos(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL CHECK(revision>0),
 snapshot_ref TEXT NOT NULL REFERENCES todo_revision_snapshots(id),
 body_hash TEXT NOT NULL
);
"#;

/// Recoverable native fields only. Display labels, owner timestamps and revision
/// metadata are excluded from the body, so changing UI labels cannot mutate it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TodoSnapshot {
    pub scope: TodoScope,
    pub project_id: Option<i64>,
    pub content: String,
    pub status: String,
    pub priority: String,
    pub due_date: Option<String>,
    pub tag_ids: Vec<i64>,
    pub children: Vec<TodoChildSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TodoChildSnapshot {
    pub id: i64,
    pub content: String,
    pub status: String,
    pub progress_date: String,
    pub due_date: Option<String>,
    pub completed_at: Option<String>,
    pub order_index: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TodoRevisionHead {
    pub todo_id: i64,
    pub revision: u64,
    pub snapshot_ref: String,
    pub body_hash: String,
}

fn io_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(
        ErrorCode::IoFailed,
        "Cannot read or commit Todo revision storage",
    )
}
fn transaction_required(conn: &Connection) -> AgentResult<()> {
    if conn.is_autocommit() {
        return Err(AgentError::new(
            ErrorCode::IoFailed,
            "Todo revision writes require the native business transaction",
        ));
    }
    Ok(())
}
fn revision_conflict(current: &TodoRevisionHead) -> AgentError {
    AgentError::new(
        ErrorCode::RevisionConflict,
        "Todo changed; reload it before saving",
    )
    .with_details(
        serde_json::json!({"currentRevision":current.revision,"bodyHash":current.body_hash}),
    )
}
fn valid_id(todo_id: i64) -> AgentResult<()> {
    if todo_id <= 0 {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Todo ID must be positive",
        ));
    }
    Ok(())
}

/// Reads the existing business tables. Callers verify current binding, scope and
/// ownership before this helper; it cannot fabricate a grant or resolve a label.
pub(super) fn snapshot(conn: &Connection, todo_id: i64) -> AgentResult<TodoSnapshot> {
    valid_id(todo_id)?;
    let (scope, project_id, content, status, priority, due_date) = conn
        .query_row(
            "SELECT scope,project_id,content,status,priority,due_date FROM todos WHERE id=?1",
            [todo_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(io_error)?
        .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Todo is no longer present"))?;
    let scope = match (scope.as_str(), project_id) {
        ("workspace", None) => TodoScope::Workspace,
        ("project", Some(project_id)) if project_id > 0 => TodoScope::Project,
        _ => {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "Stored Todo ownership is damaged",
            ))
        }
    };
    let mut tags = conn
        .prepare("SELECT tag_id FROM todo_tag_links WHERE todo_id=?1 ORDER BY tag_id")
        .map_err(io_error)?;
    let tag_ids = tags
        .query_map([todo_id], |row| row.get::<_, i64>(0))
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    let mut progress = conn.prepare("SELECT id,content,status,progress_date,due_date,completed_at,order_index,created_at FROM todo_progresses WHERE todo_id=?1 ORDER BY order_index,created_at,id").map_err(io_error)?;
    let children = progress
        .query_map([todo_id], |row| {
            Ok(TodoChildSnapshot {
                id: row.get(0)?,
                content: row.get(1)?,
                status: row.get(2)?,
                progress_date: row.get(3)?,
                due_date: row.get(4)?,
                completed_at: row.get(5)?,
                order_index: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    Ok(TodoSnapshot {
        scope,
        project_id,
        content,
        status,
        priority,
        due_date,
        tag_ids,
        children,
    })
}

fn encode_snapshot(value: &TodoSnapshot) -> AgentResult<(String, String)> {
    // Use serde_json's ordered map representation, independent of DTO field order.
    let json = serde_json::to_value(value)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode Todo snapshot"))?
        .to_string();
    let hash = format!("sha256:{:x}", Sha256::digest(json.as_bytes()));
    Ok((json, hash))
}

/// Reading a legacy/missing head fails explicitly; initialization is a separate
/// creation/migration operation and never a side effect of viewing a Todo.
pub(super) fn head(conn: &Connection, todo_id: i64) -> AgentResult<TodoRevisionHead> {
    valid_id(todo_id)?;
    conn.query_row(
        "SELECT revision,snapshot_ref,body_hash FROM todo_revision_heads WHERE todo_id=?1",
        [todo_id],
        |row| {
            Ok(TodoRevisionHead {
                todo_id,
                revision: row.get::<_, i64>(0)? as u64,
                snapshot_ref: row.get(1)?,
                body_hash: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(io_error)?
    .ok_or_else(|| {
        AgentError::new(
            ErrorCode::SourceNotReady,
            "Todo has no committed revision baseline",
        )
    })
}

/// Reads a retained revision independently of the current Todo's existence.
pub(super) fn retained_snapshot(
    conn: &Connection,
    snapshot_ref: &str,
) -> AgentResult<TodoSnapshot> {
    if snapshot_ref.len() != 32
        || !snapshot_ref
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid Todo snapshot identity",
        ));
    }
    let json: String = conn
        .query_row(
            "SELECT snapshot_json FROM todo_revision_snapshots WHERE id=?1",
            [snapshot_ref],
            |row| row.get(0),
        )
        .optional()
        .map_err(io_error)?
        .ok_or_else(|| {
            AgentError::new(
                ErrorCode::NotFound,
                "Todo revision snapshot is not retained",
            )
        })?;
    serde_json::from_str(&json)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Stored Todo snapshot is damaged"))
}

pub(super) fn require_expected_revision(
    conn: &Connection,
    todo_id: i64,
    expected: u64,
) -> AgentResult<TodoRevisionHead> {
    if expected == 0 || expected > i64::MAX as u64 {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid expected Todo revision",
        ));
    }
    let current = head(conn, todo_id)?;
    if expected != current.revision {
        return Err(revision_conflict(&current));
    }
    Ok(current)
}

fn insert_snapshot(
    conn: &Connection,
    todo_id: i64,
    revision: u64,
    json: &str,
    operation_id: Option<&str>,
) -> AgentResult<String> {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    conn.execute("INSERT INTO todo_revision_snapshots(id,todo_id,revision,snapshot_json,created_at,operation_id) VALUES (?1,?2,?3,?4,?5,?6)",params![id,todo_id,revision as i64,json,Utc::now().to_rfc3339(),operation_id]).map_err(io_error)?;
    Ok(id)
}

/// Initialize a newly inserted Todo (or migration backfill) at revision one.
/// An existing head is never silently replaced by a newly guessed baseline.
pub(super) fn initialize(
    conn: &Connection,
    todo_id: i64,
    operation_id: Option<&str>,
) -> AgentResult<TodoRevisionHead> {
    transaction_required(conn)?;
    let value = snapshot(conn, todo_id)?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM todo_revision_heads WHERE todo_id=?1)",
            [todo_id],
            |row| row.get(0),
        )
        .map_err(io_error)?;
    if exists {
        return Err(revision_conflict(&head(conn, todo_id)?));
    }
    let (json, body_hash) = encode_snapshot(&value)?;
    let snapshot_ref = insert_snapshot(conn, todo_id, 1, &json, operation_id)?;
    conn.execute("INSERT INTO todo_revision_heads(todo_id,revision,snapshot_ref,body_hash) VALUES (?1,1,?2,?3)",params![todo_id,snapshot_ref,body_hash]).map_err(io_error)?;
    Ok(TodoRevisionHead {
        todo_id,
        revision: 1,
        snapshot_ref,
        body_hash,
    })
}

/// After the caller has applied its native mutation, commit the resulting body
/// and revision CAS in that same transaction. Every successful business write
/// receives a new revision and snapshot, including an identical body.
pub(super) fn commit(
    conn: &Connection,
    todo_id: i64,
    expected: u64,
    operation_id: Option<&str>,
) -> AgentResult<TodoRevisionHead> {
    transaction_required(conn)?;
    let current = require_expected_revision(conn, todo_id, expected)?;
    let (json, body_hash) = encode_snapshot(&snapshot(conn, todo_id)?)?;
    let revision = current
        .revision
        .checked_add(1)
        .filter(|revision| *revision <= i64::MAX as u64)
        .ok_or_else(|| AgentError::new(ErrorCode::BudgetExceeded, "Todo revision exhausted"))?;
    let snapshot_ref = insert_snapshot(conn, todo_id, revision, &json, operation_id)?;
    let changed=conn.execute("UPDATE todo_revision_heads SET revision=?1,snapshot_ref=?2,body_hash=?3 WHERE todo_id=?4 AND revision=?5 AND snapshot_ref=?6 AND body_hash=?7",params![revision as i64,snapshot_ref,body_hash,todo_id,expected as i64,current.snapshot_ref,current.body_hash]).map_err(io_error)?;
    if changed != 1 {
        return Err(revision_conflict(&current));
    }
    Ok(TodoRevisionHead {
        todo_id,
        revision,
        snapshot_ref,
        body_hash,
    })
}

impl Database {
    pub(super) fn ensure_todo_revision_schema(&self) -> anyhow::Result<()> {
        if self.schema_version()? >= TODO_REVISION_SCHEMA_VERSION {
            return Ok(());
        }
        self.conn.execute_batch("SAVEPOINT todo_revision_schema")?;
        let result = (|| -> anyhow::Result<()> {
            self.conn.execute_batch(TODO_REVISION_SCHEMA_SQL)?;
            let mut statement = self.conn.prepare("SELECT id FROM todos ORDER BY id")?;
            let ids = statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            for id in ids {
                initialize(&self.conn, id, None).map_err(|error| anyhow::anyhow!(error.message))?;
            }
            self.conn.execute_batch(
                "ALTER TABLE agent_outputs ADD COLUMN dedupe_key TEXT;
                CREATE UNIQUE INDEX agent_todo_output_dedupe ON agent_outputs(run_id,dedupe_key)
                WHERE kind='todo' AND intent='create' AND dedupe_key IS NOT NULL;",
            )?;
            self.conn
                .execute_batch(super::agent_todo_undo::AGENT_TODO_VISIBILITY_SQL)?;
            self.set_schema_version(TODO_REVISION_SCHEMA_VERSION)?;
            self.conn.execute_batch("RELEASE todo_revision_schema")?;
            Ok(())
        })();
        if result.is_err() {
            self.conn
                .execute_batch("ROLLBACK TO todo_revision_schema; RELEASE todo_revision_schema")?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(path: Option<&std::path::Path>) -> Database {
        let conn = match path {
            Some(path) => Connection::open(path).unwrap(),
            None => Connection::open_in_memory().unwrap(),
        };
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY,scope TEXT NOT NULL,project_id INTEGER,content TEXT NOT NULL,status TEXT NOT NULL,priority TEXT NOT NULL,due_date TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS todo_progresses(id INTEGER PRIMARY KEY,todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,content TEXT NOT NULL,status TEXT NOT NULL,progress_date TEXT NOT NULL,due_date TEXT,completed_at TEXT,order_index INTEGER NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS todo_tag_links(todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,tag_id INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(todo_id,tag_id));").unwrap();
        conn.execute_batch(include_str!("agent_schema.sql"))
            .unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS agent_object_withdrawals(object_key TEXT PRIMARY KEY,creation_operation_id TEXT NOT NULL,withdrawn_at TEXT,restore_operation_id TEXT,revision INTEGER NOT NULL CHECK(revision>0));").unwrap();
        Database {
            conn,
            workspace_root: Default::default(),
            secret_password: None,
            native_workspace_id: None,
        }
    }
    fn seed(db: &Database) {
        db.conn.execute_batch("INSERT INTO todos VALUES (1,'workspace',NULL,'原始待办','unfinished','normal',NULL,'created','updated'); INSERT INTO todo_progresses VALUES (2,1,'child later','finished','2026-01-02','2026-01-03','2026-01-04',1,'child-2'),(3,1,'child earlier','unfinished','2026-01-01',NULL,NULL,0,'child-3'); INSERT INTO todo_tag_links VALUES (1,8,'tag-8'),(1,4,'tag-4');").unwrap();
        db.set_schema_version(30).unwrap();
    }
    #[test]
    fn todo_revision_migration_backfills_actual_children_and_reopens_without_new_baselines() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("todo.sqlite");
        let db = fixture(Some(&path));
        seed(&db);
        db.ensure_todo_revision_schema().unwrap();
        let current = head(&db.conn, 1).unwrap();
        assert_eq!(current.revision, 1);
        let value = retained_snapshot(&db.conn, &current.snapshot_ref).unwrap();
        assert_eq!(value.tag_ids, vec![4, 8]);
        assert_eq!(
            value
                .children
                .iter()
                .map(|child| child.id)
                .collect::<Vec<_>>(),
            vec![3, 2]
        );
        assert_eq!(
            value.children[1].completed_at.as_deref(),
            Some("2026-01-04")
        );
        assert_eq!(encode_snapshot(&value).unwrap().1, current.body_hash);
        assert_eq!(db.schema_version().unwrap(), 31);
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM agent_change_log", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(db);
        let reopened = fixture(Some(&path));
        reopened.ensure_todo_revision_schema().unwrap();
        assert_eq!(head(&reopened.conn, 1).unwrap(), current);
        assert_eq!(
            reopened
                .conn
                .query_row("SELECT count(*) FROM todo_revision_snapshots", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
    }
    #[test]
    fn todo_revision_mutation_snapshot_and_head_cas_share_native_transaction() {
        let db = fixture(None);
        seed(&db);
        db.ensure_todo_revision_schema().unwrap();
        let initial = head(&db.conn, 1).unwrap();
        assert_eq!(
            commit(&db.conn, 1, 1, None).unwrap_err().code,
            ErrorCode::IoFailed
        );
        let tx = db.conn.unchecked_transaction().unwrap();
        require_expected_revision(&tx, 1, 1).unwrap();
        tx.execute("UPDATE todo_progresses SET content='新的子项',status='unfinished',completed_at=NULL WHERE id=2",[]).unwrap();
        let changed = commit(&tx, 1, 1, Some("operation")).unwrap();
        assert_eq!(changed.revision, 2);
        tx.commit().unwrap();
        assert_eq!(
            retained_snapshot(&db.conn, &initial.snapshot_ref)
                .unwrap()
                .children[1]
                .content,
            "child later"
        );
        assert_eq!(
            retained_snapshot(&db.conn, &changed.snapshot_ref)
                .unwrap()
                .children[1]
                .content,
            "新的子项"
        );
        assert_eq!(
            require_expected_revision(&db.conn, 1, 1).unwrap_err().code,
            ErrorCode::RevisionConflict
        );
        let tx = db.conn.unchecked_transaction().unwrap();
        tx.execute("UPDATE todos SET content=content WHERE id=1", [])
            .unwrap();
        let identical = commit(&tx, 1, 2, None).unwrap();
        assert_eq!(identical.revision, 3);
        assert_eq!(identical.body_hash, changed.body_hash);
        assert_ne!(identical.snapshot_ref, changed.snapshot_ref);
        tx.commit().unwrap();
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM todo_revision_snapshots", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            3
        );
    }
    #[test]
    fn todo_revision_rollback_preserves_business_body_snapshot_and_head() {
        let db = fixture(None);
        seed(&db);
        db.ensure_todo_revision_schema().unwrap();
        let initial = head(&db.conn, 1).unwrap();
        {
            let tx = db.conn.unchecked_transaction().unwrap();
            tx.execute("UPDATE todos SET content='未提交修改' WHERE id=1", [])
                .unwrap();
            commit(&tx, 1, 1, None).unwrap();
        }
        assert_eq!(head(&db.conn, 1).unwrap(), initial);
        assert_eq!(snapshot(&db.conn, 1).unwrap().content, "原始待办");
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM todo_revision_snapshots", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        db.conn.execute_batch("CREATE TRIGGER fixture_fail_head BEFORE UPDATE ON todo_revision_heads BEGIN SELECT RAISE(ABORT,'head failure'); END").unwrap();
        {
            let tx = db.conn.unchecked_transaction().unwrap();
            tx.execute("UPDATE todos SET content='failure' WHERE id=1", [])
                .unwrap();
            assert_eq!(
                commit(&tx, 1, 1, None).unwrap_err().code,
                ErrorCode::IoFailed
            );
        }
        assert_eq!(head(&db.conn, 1).unwrap(), initial);
        assert_eq!(snapshot(&db.conn, 1).unwrap().content, "原始待办");
    }
    #[test]
    fn todo_revision_missing_head_read_never_initializes_and_explicit_creation_is_atomic() {
        let db = fixture(None);
        db.set_schema_version(30).unwrap();
        db.ensure_todo_revision_schema().unwrap();
        db.conn.execute("INSERT INTO todos VALUES (1,'project',7,'new','unfinished','normal',NULL,'created','updated')",[]).unwrap();
        assert_eq!(
            head(&db.conn, 1).unwrap_err().code,
            ErrorCode::SourceNotReady
        );
        assert_eq!(
            initialize(&db.conn, 1, None).unwrap_err().code,
            ErrorCode::IoFailed
        );
        {
            let tx = db.conn.unchecked_transaction().unwrap();
            let current = initialize(&tx, 1, Some("create-operation")).unwrap();
            assert_eq!(current.revision, 1);
            tx.commit().unwrap();
        }
        let tx = db.conn.unchecked_transaction().unwrap();
        assert_eq!(
            initialize(&tx, 1, None).unwrap_err().code,
            ErrorCode::RevisionConflict
        );
        tx.rollback().unwrap();
        let retained = head(&db.conn, 1).unwrap().snapshot_ref;
        db.conn.execute("DELETE FROM todos WHERE id=1", []).unwrap();
        assert_eq!(
            head(&db.conn, 1).unwrap_err().code,
            ErrorCode::SourceNotReady
        );
        assert_eq!(
            retained_snapshot(&db.conn, &retained).unwrap().project_id,
            Some(7)
        );
    }
    #[test]
    fn todo_revision_schema_failure_rolls_back_schema_version_and_every_backfill() {
        let db = fixture(None);
        seed(&db);
        db.conn
            .execute("CREATE TABLE todo_revision_heads(incompatible TEXT)", [])
            .unwrap();
        assert!(db.ensure_todo_revision_schema().is_err());
        assert_eq!(db.schema_version().unwrap(), 30);
        assert!(!db.table_exists("todo_revision_snapshots").unwrap());
        assert!(db.conn.is_autocommit());
    }
    #[test]
    fn todo_revision_late_view_failure_rolls_back_backfill_and_dedupe_schema() {
        let db = fixture(None);
        seed(&db);
        db.conn
            .execute("CREATE TABLE agent_visible_todos(incompatible TEXT)", [])
            .unwrap();
        assert!(db.ensure_todo_revision_schema().is_err());
        assert_eq!(db.schema_version().unwrap(), 30);
        assert!(!db.table_exists("todo_revision_heads").unwrap());
        assert!(!db.table_exists("todo_revision_snapshots").unwrap());
        assert!(!db.has_column("agent_outputs", "dedupe_key").unwrap());
        let index_exists: bool = db
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='agent_todo_output_dedupe')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!index_exists);
        assert_eq!(snapshot(&db.conn, 1).unwrap().content, "原始待办");
        assert!(db.conn.is_autocommit());
    }
}
