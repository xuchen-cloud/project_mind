//! Internal retrieval cache; business ownership and policy remain in the shared
//! source service. This module is not a public tool adapter or fact source.
use crate::agent::{
    access::RequestContext,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, SourceLocator, SourceRef, WorkspaceBinding},
};
use rusqlite::{params, Connection};

pub(crate) struct SourceIndex<'a> {
    conn: &'a Connection,
}
#[derive(Clone)]
pub(crate) struct IndexChunk {
    pub text: String,
    pub locator: SourceLocator,
    pub block_id: Option<String>,
}
#[derive(Clone)]
pub(crate) struct IndexSource {
    pub object: ObjectRef,
    pub revision: String,
    pub title: String,
    pub chunks: Vec<IndexChunk>,
    /// Some only for a retained File/Record Version. Autosave heads have no
    /// independent cache history and replace the previous unversioned head.
    pub version: Option<u32>,
    pub updated_at: String,
    pub current: bool,
}
#[derive(Debug)]
pub(crate) struct SearchCandidate {
    pub object_key: String,
    pub title: String,
    pub excerpt: String,
    pub score: f64,
    pub source_ref: SourceRef,
}
pub(crate) struct SearchPage {
    pub items: Vec<SearchCandidate>,
    pub has_more: bool,
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn io_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot access source retrieval cache")
}
impl<'a> SourceIndex<'a> {
    pub(crate) fn prepare(conn: &'a Connection) -> AgentResult<Self> {
        conn.execute_batch(include_str!("source_search_index.sql"))
            .map_err(|_| {
                AgentError::new(
                    ErrorCode::SourceNotReady,
                    "Bundled SQLite source search is unavailable",
                )
            })?;
        Ok(Self { conn })
    }
    pub(crate) fn replace(&self, source: &IndexSource) -> AgentResult<()> {
        let key = source.object.key()?;
        if source.revision.len() != 71
            || !source.revision.starts_with("sha256:")
            || !source.revision[7..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || source.title.chars().count() > 1000
            || source.chunks.len() > 10000
            || source.version == Some(0)
            || (source.version.is_some()
                && !matches!(source.object.kind, ObjectKind::Record | ObjectKind::File))
            || (!source.current && source.version.is_none())
        {
            return Err(invalid("Invalid source index snapshot"));
        }
        let mut chars = 0;
        for chunk in &source.chunks {
            let length = chunk.text.chars().count();
            chars += length;
            if length == 0 || length > 1800 {
                return Err(invalid("Invalid source index chunk"));
            }
            match &chunk.locator {
                SourceLocator::Paragraph { start, end } if *start > 0 && start == end => (),
                SourceLocator::Page { page, start, end }
                    if source.object.kind == ObjectKind::File
                        && (1..=500).contains(page)
                        && end >= start
                        && *end <= 2 * 1024 * 1024
                        && end - start == length as u32 =>
                {
                    ()
                }
                SourceLocator::Time { start_ms, end_ms }
                    if source.object.kind == ObjectKind::Transcript
                        && *end_ms >= *start_ms
                        && *end_ms <= 9_007_199_254_740_991 =>
                {
                    ()
                }
                SourceLocator::Messages {
                    session_id,
                    branch_id,
                    start_message_id,
                    end_message_id,
                } if [session_id, branch_id, start_message_id, end_message_id]
                    .iter()
                    .all(|id| {
                        !id.is_empty()
                            && id.len() <= 128
                            && id
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
                    }) =>
                {
                    ()
                }
                _ => return Err(invalid("Invalid source index locator")),
            }
            if chunk.block_id.as_ref().is_some_and(|id| {
                source.object.kind != ObjectKind::Record
                    || id.len() != 32
                    || !id
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            }) {
                return Err(invalid("Invalid source block identity"));
            }
        }
        // The sum includes the documented overlap; the extraction boundary
        // separately verifies unique coverage never exceeds 2 Mi characters.
        if chars > 3 * 1024 * 1024 {
            return Err(invalid("Source index exceeds capacity"));
        }
        let tx = self.conn.unchecked_transaction().map_err(io_error)?;
        if source.current {
            tx.execute(
                "DELETE FROM source_index_snapshots WHERE object_key=?1 AND version=0",
                [&key],
            )
            .map_err(io_error)?;
            tx.execute(
                "UPDATE source_index_snapshots SET is_current=0 WHERE object_key=?1",
                [&key],
            )
            .map_err(io_error)?;
        }
        let object = serde_json::to_string(&source.object)
            .map_err(|_| invalid("Invalid source identity"))?;
        let version = source.version.map(i64::from).unwrap_or(0);
        let id: i64 = tx.query_row("INSERT INTO source_index_snapshots(object_key,workspace_id,scope_key,object_json,revision,version,title,updated_at,is_current) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(object_key,revision,version) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at,is_current=excluded.is_current RETURNING id",params![key,source.object.workspace_id,source.object.scope.key(),object,source.revision,version,source.title,source.updated_at,source.current], |row| row.get(0)).map_err(io_error)?;
        tx.execute("DELETE FROM source_index_chunks WHERE snapshot_id=?1", [id])
            .map_err(io_error)?;
        for (ordinal, chunk) in source.chunks.iter().enumerate() {
            let locator = serde_json::to_string(&chunk.locator)
                .map_err(|_| invalid("Invalid source locator"))?;
            tx.execute("INSERT INTO source_index_chunks(snapshot_id,ordinal,title,text,locator_json,block_id) VALUES (?1,?2,?3,?4,?5,?6)",params![id,ordinal as i64,source.title,chunk.text,locator,chunk.block_id]).map_err(io_error)?;
        }
        tx.commit().map_err(io_error)
    }
    /// Deletion removes every cached version. The exclusion policy remains so
    /// a later retry cannot silently resurrect an intentionally excluded source.
    pub(crate) fn remove(&self, object: &ObjectRef) -> AgentResult<()> {
        self.conn
            .execute(
                "DELETE FROM source_index_snapshots WHERE object_key=?1",
                [object.key()?],
            )
            .map_err(io_error)?;
        Ok(())
    }
    pub(crate) fn exclude(&self, object: &ObjectRef, excluded: bool) -> AgentResult<()> {
        let key = object.key()?;
        if excluded {
            self.conn
                .execute(
                    "INSERT OR IGNORE INTO source_index_exclusions(object_key) VALUES (?1)",
                    [key],
                )
                .map_err(io_error)?;
        } else {
            self.conn
                .execute(
                    "DELETE FROM source_index_exclusions WHERE object_key=?1",
                    [key],
                )
                .map_err(io_error)?;
        }
        Ok(())
    }
    pub(crate) fn search(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
        query: &str,
        selected: &[String],
        include_history: bool,
        limit: usize,
    ) -> AgentResult<SearchPage> {
        request.authorize(binding, scope, "source.read")?;
        let query = query.trim();
        let terms: Vec<_> = query.split_whitespace().collect();
        if terms.is_empty()
            || terms.len() > 16
            || query.chars().count() > 256
            || selected.len() > 50
            || limit == 0
        {
            return Err(invalid("Invalid source search budget"));
        }
        let (long, short): (Vec<_>, Vec<_>) = terms
            .into_iter()
            .partition(|term| term.chars().count() >= 3);
        let fts = long
            .iter()
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        let escaped: Vec<_> = short
            .iter()
            .map(|term| {
                term.replace('!', "!!")
                    .replace('%', "!%")
                    .replace('_', "!_")
            })
            .collect();
        let short_json =
            serde_json::to_string(&escaped).map_err(|_| invalid("Invalid search text"))?;
        let selected_json =
            serde_json::to_string(selected).map_err(|_| invalid("Invalid selected sources"))?;
        // Apply scope/policy/current-version constraints before materializing
        // candidates, including the short-query fallback.
        let filters = "s.workspace_id=?2 AND s.scope_key=?3 AND (?4 OR s.is_current) AND NOT EXISTS(SELECT 1 FROM source_index_exclusions x WHERE x.object_key=s.object_key) AND NOT EXISTS(SELECT 1 FROM json_each(?5) t WHERE s.title NOT LIKE '%'||t.value||'%' ESCAPE '!' AND c.text NOT LIKE '%'||t.value||'%' ESCAPE '!')";
        let matches = if long.is_empty() {
            format!("SELECT c.id AS rowid,0.0 AS rank,substr(c.text,1,240) AS excerpt FROM source_index_snapshots s JOIN source_index_chunks c ON c.snapshot_id=s.id WHERE {filters}")
        } else {
            format!("SELECT source_index_fts.rowid,bm25(source_index_fts) AS rank,snippet(source_index_fts,1,'','','…',64) AS excerpt FROM source_index_fts JOIN source_index_chunks c ON c.id=source_index_fts.rowid JOIN source_index_snapshots s ON s.id=c.snapshot_id WHERE source_index_fts MATCH ?1 AND {filters}")
        };
        let sql = format!("WITH matches AS MATERIALIZED ({matches}), ranked AS (SELECT s.object_key,s.object_json,s.revision,s.version,s.title,s.updated_at,c.locator_json,c.block_id,m.rank,m.excerpt,ROW_NUMBER() OVER(PARTITION BY s.id ORDER BY m.rank,c.ordinal) AS n FROM matches m JOIN source_index_chunks c ON c.id=m.rowid JOIN source_index_snapshots s ON s.id=c.snapshot_id) SELECT object_key,object_json,revision,version,title,locator_json,block_id,rank,excerpt FROM ranked WHERE n=1 ORDER BY (title=?6 COLLATE NOCASE) DESC,(object_key IN (SELECT value FROM json_each(?7))) DESC,rank,updated_at DESC,object_key,version DESC LIMIT ?8");
        let mut statement = self.conn.prepare(&sql).map_err(io_error)?;
        let rows = statement
            .query_map(
                params![
                    fts,
                    binding.workspace_id,
                    scope.key(),
                    include_history,
                    short_json,
                    query,
                    selected_json,
                    limit.min(50) as i64 + 1
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, u32>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, f64>(7)?,
                        row.get::<_, String>(8)?,
                    ))
                },
            )
            .map_err(io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        let has_more = rows.len() > limit.min(50);
        let items = rows
            .into_iter()
            .take(limit.min(50))
            .map(
                |(key, object, revision, version, title, locator, block_id, rank, excerpt)| {
                    let object: ObjectRef = serde_json::from_str(&object)
                        .map_err(|_| invalid("Corrupt source identity"))?;
                    if object.key()? != key
                        || object.scope != *scope
                        || object.workspace_id != binding.workspace_id
                    {
                        return Err(invalid("Corrupt source cache scope"));
                    }
                    let locator = serde_json::from_str(&locator)
                        .map_err(|_| invalid("Corrupt source locator"))?;
                    let excerpt: String = excerpt.chars().take(240).collect();
                    let source_ref = SourceRef {
                        file_version: (object.kind == ObjectKind::File && version > 0)
                            .then_some(version),
                        record_version: (object.kind == ObjectKind::Record && version > 0)
                            .then_some(version),
                        object,
                        revision,
                        block_id,
                        locator: Some(locator),
                        title: title.clone(),
                        excerpt: excerpt.clone(),
                    };
                    Ok(SearchCandidate {
                        object_key: key,
                        title,
                        excerpt,
                        score: -rank,
                        source_ref,
                    })
                },
            )
            .collect::<AgentResult<Vec<_>>>()?;
        Ok(SearchPage { items, has_more })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{
        access::{Caller, ScopeGrant},
        errors::ErrorCode,
        models::ObjectKind,
    };
    fn binding() -> WorkspaceBinding {
        WorkspaceBinding {
            workspace_id: "source-workspace".into(),
            generation: "opened".into(),
        }
    }
    fn request() -> RequestContext {
        RequestContext {
            binding: binding(),
            scope_grant: ScopeGrant {
                workspace_id: "source-workspace".into(),
                workspace_content: true,
                project_ids: vec![1],
                operations: vec!["source.read".into()],
            },
            caller: Caller::Gui,
            request_id: "search-fixture".into(),
        }
    }
    fn source(id: i64, scope: Scope, title: &str, text: &str) -> IndexSource {
        IndexSource {
            object: ObjectRef {
                workspace_id: "source-workspace".into(),
                scope,
                kind: ObjectKind::Record,
                id: id.to_string(),
            },
            revision: format!("sha256:{}", "a".repeat(64)),
            title: title.into(),
            chunks: vec![IndexChunk {
                text: text.into(),
                locator: SourceLocator::Paragraph { start: 1, end: 1 },
                block_id: None,
            }],
            version: Some(1),
            updated_at: "2026-10-01T00:00:00Z".into(),
            current: true,
        }
    }
    #[test]
    fn source_index_bundled_trigram_recalls_chinese_and_mixed_english() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        let item = source(
            1,
            Scope::Project { project_id: 1 },
            "合同审阅",
            "合同风险需要确认。contract evidence 已保留。",
        );
        index.replace(&item).unwrap();
        for query in ["合同风险", "contract evidence", "合同 evidence"] {
            let page = index
                .search(
                    &request(),
                    &binding(),
                    &item.object.scope,
                    query,
                    &[],
                    false,
                    8,
                )
                .unwrap();
            assert_eq!(page.items.len(), 1, "Query {query}");
            assert_eq!(page.items[0].object_key, item.object.key().unwrap());
        }
    }
    #[test]
    fn source_index_short_queries_are_literal_and_hard_limit_is_fifty() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        for id in 1..=60 {
            index
                .replace(&source(
                    id,
                    Scope::Project { project_id: 1 },
                    "风险",
                    "风险与 100% 进度，以及 a_b 标识。",
                ))
                .unwrap();
        }
        for query in ["风", "风险", "%", "_"] {
            let page = index
                .search(
                    &request(),
                    &binding(),
                    &Scope::Project { project_id: 1 },
                    query,
                    &[],
                    false,
                    500,
                )
                .unwrap();
            assert_eq!(page.items.len(), 50);
            assert!(page.has_more);
            assert!(page
                .items
                .iter()
                .all(|item| item.excerpt.chars().count() <= 240));
        }
        assert!(index
            .search(
                &request(),
                &binding(),
                &Scope::Project { project_id: 1 },
                "' OR 1=1 --",
                &[],
                false,
                8
            )
            .unwrap()
            .items
            .is_empty());
    }
    #[test]
    fn source_index_scope_exclusion_and_history_are_mandatory_filters() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        let scope = Scope::Project { project_id: 1 };
        let item = source(1, scope.clone(), "Visible", "searchable evidence");
        index.replace(&item).unwrap();
        index
            .replace(&source(
                2,
                Scope::Project { project_id: 2 },
                "Private",
                "searchable evidence",
            ))
            .unwrap();
        index
            .replace(&source(
                1,
                Scope::Workspace,
                "Workspace",
                "searchable evidence",
            ))
            .unwrap();
        assert_eq!(
            index
                .search(&request(), &binding(), &scope, "evidence", &[], false, 8)
                .unwrap()
                .items
                .len(),
            1
        );
        let denied = index
            .search(
                &request(),
                &binding(),
                &Scope::Project { project_id: 2 },
                "evidence",
                &[],
                false,
                8,
            )
            .err()
            .expect("ungranted scope");
        assert_eq!(denied.code, ErrorCode::ScopeDenied);
        index.exclude(&item.object, true).unwrap();
        assert!(index
            .search(&request(), &binding(), &scope, "evidence", &[], false, 8)
            .unwrap()
            .items
            .is_empty());
        index.exclude(&item.object, false).unwrap();
        let mut current = item.clone();
        current.revision = format!("sha256:{}", "b".repeat(64));
        current.chunks[0].text = "updated evidence".into();
        current.version = Some(2);
        index.replace(&current).unwrap();
        assert!(index
            .search(&request(), &binding(), &scope, "searchable", &[], false, 8)
            .unwrap()
            .items
            .is_empty());
        assert_eq!(
            index
                .search(&request(), &binding(), &scope, "searchable", &[], true, 8)
                .unwrap()
                .items
                .len(),
            1
        );
    }
    #[test]
    fn source_index_does_not_retain_a_full_body_for_each_autosave_head() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        for edit in 0..30 {
            let mut head = source(
                1,
                Scope::Project { project_id: 1 },
                "Current",
                &format!("autosave evidence {edit}"),
            );
            head.version = None;
            head.revision = format!("sha256:{edit:064x}");
            index.replace(&head).unwrap();
        }
        let count: i64 = conn
            .query_row("SELECT count(*) FROM source_index_snapshots", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            count, 1,
            "unversioned indexing must replace the previous head cache"
        );
        assert_eq!(
            index
                .search(
                    &request(),
                    &binding(),
                    &Scope::Project { project_id: 1 },
                    "evidence",
                    &[],
                    true,
                    8
                )
                .unwrap()
                .items
                .len(),
            1
        );
    }
    #[test]
    fn source_index_rolls_back_replacement_if_a_chunk_locator_is_invalid() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        let original = source(
            1,
            Scope::Project { project_id: 1 },
            "Current",
            "original evidence",
        );
        index.replace(&original).unwrap();
        let mut invalid = original.clone();
        invalid.revision = format!("sha256:{}", "b".repeat(64));
        invalid.version = Some(2);
        invalid.chunks[0].locator = SourceLocator::Paragraph { start: 0, end: 0 };
        assert!(index.replace(&invalid).is_err());
        let page = index
            .search(
                &request(),
                &binding(),
                &original.object.scope,
                "original",
                &[],
                false,
                8,
            )
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].source_ref.revision, original.revision);
        assert_eq!(page.items[0].source_ref.record_version, Some(1));
    }
    #[test]
    fn source_index_removes_deleted_object_from_current_and_history_search() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        let item = source(
            1,
            Scope::Project { project_id: 1 },
            "Deleted",
            "deleted evidence",
        );
        index.replace(&item).unwrap();
        index.remove(&item.object).unwrap();
        for history in [false, true] {
            assert!(index
                .search(
                    &request(),
                    &binding(),
                    &item.object.scope,
                    "evidence",
                    &[],
                    history,
                    8
                )
                .unwrap()
                .items
                .is_empty());
        }
        index.remove(&item.object).unwrap();
        let survivor = source(
            2,
            item.object.scope.clone(),
            "Survivor",
            "surviving evidence",
        );
        index.replace(&survivor).unwrap();
        assert_eq!(
            index
                .search(
                    &request(),
                    &binding(),
                    &item.object.scope,
                    "evidence",
                    &[],
                    true,
                    8
                )
                .unwrap()
                .items[0]
                .object_key,
            survivor.object.key().unwrap()
        );
    }
    #[test]
    fn source_index_failed_chunk_write_preserves_previous_current_source() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        let mut original = source(
            1,
            Scope::Project { project_id: 1 },
            "Original",
            "original evidence",
        );
        original.version = None;
        index.replace(&original).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_source_chunk BEFORE INSERT ON source_index_chunks WHEN NEW.text='failed evidence' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;").unwrap();
        let mut replacement = original.clone();
        replacement.revision = format!("sha256:{}", "b".repeat(64));
        replacement.chunks[0].text = "failed evidence".into();
        assert_eq!(
            index.replace(&replacement).unwrap_err().code,
            ErrorCode::IoFailed
        );
        let page = index
            .search(
                &request(),
                &binding(),
                &original.object.scope,
                "evidence",
                &[],
                false,
                8,
            )
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].source_ref.revision, original.revision);
        assert_eq!(page.items[0].excerpt, "original evidence");
    }
    #[test]
    fn source_index_returns_exact_record_and_file_locators() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        let mut record = source(1, Scope::Project { project_id: 1 }, "Record", "evidence");
        record.chunks[0].block_id = Some("1234567890abcdef1234567890abcdef".into());
        index.replace(&record).unwrap();
        let mut file = source(1, record.object.scope.clone(), "File", "PDF evidence");
        file.object.kind = ObjectKind::File;
        file.version = Some(4);
        file.chunks[0].locator = SourceLocator::Page {
            page: 3,
            start: 10,
            end: 22,
        };
        index.replace(&file).unwrap();
        let page = index
            .search(
                &request(),
                &binding(),
                &record.object.scope,
                "evidence",
                &[],
                false,
                8,
            )
            .unwrap();
        let record_hit = page
            .items
            .iter()
            .find(|item| item.object_key == record.object.key().unwrap())
            .unwrap();
        assert_eq!(record_hit.source_ref.record_version, Some(1));
        assert_eq!(record_hit.source_ref.file_version, None);
        assert_eq!(record_hit.source_ref.block_id, record.chunks[0].block_id);
        let file_hit = page
            .items
            .iter()
            .find(|item| item.object_key == file.object.key().unwrap())
            .unwrap();
        assert_eq!(file_hit.source_ref.file_version, Some(4));
        assert_eq!(file_hit.source_ref.record_version, None);
        assert_eq!(
            serde_json::to_value(&file_hit.source_ref.locator).unwrap(),
            serde_json::json!({"kind":"page","page":3,"start":10,"end":22})
        );
        assert!(page
            .items
            .iter()
            .all(|item| item.score.is_finite() && !item.title.is_empty()));
    }
    #[test]
    fn source_index_prioritizes_exact_title_then_selected_source() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        let scope = Scope::Project { project_id: 1 };
        let exact = source(1, scope.clone(), "evidence", "other details");
        let selected = source(2, scope.clone(), "Selected", "evidence");
        let other = source(3, scope.clone(), "Other", "evidence evidence evidence");
        for item in [&exact, &selected, &other] {
            index.replace(item).unwrap();
        }
        let page = index
            .search(
                &request(),
                &binding(),
                &scope,
                "evidence",
                &[selected.object.key().unwrap()],
                false,
                8,
            )
            .unwrap();
        assert_eq!(
            page.items
                .iter()
                .map(|item| &item.object_key)
                .collect::<Vec<_>>(),
            [
                &exact.object.key().unwrap(),
                &selected.object.key().unwrap(),
                &other.object.key().unwrap()
            ]
        );
    }
}
