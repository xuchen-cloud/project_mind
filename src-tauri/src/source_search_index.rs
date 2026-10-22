//! Internal retrieval cache; business ownership and policy remain in the shared
//! source service. This module is not a public tool adapter or fact source.
use crate::agent::{
    access::RequestContext,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, SourceLocator, SourceRef, WorkspaceBinding},
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub(crate) struct SourceIndex<'a> {
    conn: &'a Connection,
}
#[derive(Clone)]
pub(crate) struct IndexChunk {
    pub text: String,
    pub locator: SourceLocator,
    pub block_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IndexCoverage {
    pub chars: u32,
    pub complete: bool,
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
    pub coverage: IndexCoverage,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchCandidate {
    pub object_key: String,
    pub title: String,
    pub excerpt: String,
    pub score: f64,
    pub source_ref: SourceRef,
    pub coverage: IndexCoverage,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceCacheCapacity {
    pub objects: u64,
    pub snapshots: u64,
    pub chunks: u64,
    pub content_bytes: u64,
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
        let upgrade = || -> rusqlite::Result<()> {
            conn.execute_batch("SAVEPOINT source_index_prepare")?;
            let result = (|| -> rusqlite::Result<()> {
                conn.execute_batch(include_str!("source_search_index.sql"))?;
                let columns = {
                    let mut statement =
                        conn.prepare("PRAGMA table_info(source_index_snapshots)")?;
                    let names = statement
                        .query_map([], |row| row.get::<_, String>(1))?
                        .collect::<Result<Vec<_>, _>>()?;
                    names
                };
                if !columns.iter().any(|column| column == "coverage_json") {
                    conn.execute_batch("ALTER TABLE source_index_snapshots ADD COLUMN coverage_json TEXT NOT NULL DEFAULT '{\"chars\":0,\"complete\":false}' CHECK(json_valid(coverage_json));")?;
                }
                let legacy:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_index_exclusions')",[],|row|row.get(0))?;
                if legacy {
                    conn.execute_batch("INSERT INTO source_access_policies(object_key,excluded,revision) SELECT object_key,1,1 FROM source_index_exclusions WHERE 1 ON CONFLICT(object_key) DO NOTHING; DROP TABLE source_index_exclusions;")?;
                }
                conn.execute_batch("RELEASE source_index_prepare")
            })();
            if result.is_err() {
                conn.execute_batch(
                    "ROLLBACK TO source_index_prepare; RELEASE source_index_prepare",
                )?;
            }
            result
        };
        upgrade().map_err(|_| {
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
                        && *end_ms <= crate::agent::models::MAX_SAFE_SOURCE_TIME_MS =>
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
        if chars > 3 * 1024 * 1024
            || source.coverage.chars as usize > 2 * 1024 * 1024
            || source.coverage.chars as usize > chars
        {
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
        let id: i64 = tx.query_row("INSERT INTO source_index_snapshots(object_key,workspace_id,scope_key,object_json,revision,version,title,updated_at,is_current,coverage_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(object_key,revision,version) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at,is_current=excluded.is_current,coverage_json=excluded.coverage_json RETURNING id",params![key,source.object.workspace_id,source.object.scope.key(),object,source.revision,version,source.title,source.updated_at,source.current,serde_json::to_string(&source.coverage).map_err(|_|invalid("Invalid source coverage"))?], |row| row.get(0)).map_err(io_error)?;
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
    #[cfg(test)]
    fn exclude(&self, object: &ObjectRef, excluded: bool) -> AgentResult<()> {
        self.conn.execute("INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,?2,1) ON CONFLICT(object_key) DO UPDATE SET excluded=excluded.excluded,revision=revision+1",params![object.key()?,excluded]).map_err(io_error)?;
        Ok(())
    }
    /// Stored payload only: FTS/B-tree pages are additional SQLite overhead.
    pub(crate) fn capacity(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
    ) -> AgentResult<SourceCacheCapacity> {
        request.authorize(binding, scope, "source.read")?;
        self.conn.query_row("SELECT count(DISTINCT s.object_key),count(*),(SELECT count(*) FROM source_index_chunks c JOIN source_index_snapshots t ON t.id=c.snapshot_id WHERE t.workspace_id=?1 AND t.scope_key=?2),coalesce(sum(length(CAST(s.object_json AS BLOB))+length(CAST(s.title AS BLOB))+length(s.revision)+length(s.coverage_json)),0)+(SELECT coalesce(sum(length(CAST(c.title AS BLOB))+length(CAST(c.text AS BLOB))+length(c.locator_json)+coalesce(length(c.block_id),0)),0) FROM source_index_chunks c JOIN source_index_snapshots t ON t.id=c.snapshot_id WHERE t.workspace_id=?1 AND t.scope_key=?2) FROM source_index_snapshots s WHERE s.workspace_id=?1 AND s.scope_key=?2",params![binding.workspace_id,scope.key()],|row|Ok(SourceCacheCapacity {objects:row.get::<_,i64>(0)? as u64,snapshots:row.get::<_,i64>(1)? as u64,chunks:row.get::<_,i64>(2)? as u64,content_bytes:row.get::<_,i64>(3)? as u64})).map_err(io_error)
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
        kinds: Option<&[ObjectKind]>,
    ) -> AgentResult<SearchPage> {
        request.authorize(binding, scope, "source.read")?;
        if query.trim().is_empty() {
            return Err(invalid("Source search query must contain non-whitespace characters"));
        }
        if query.chars().count() > 256 {
            return Err(invalid("Source search query must contain at most 256 characters"));
        }
        let query = query.trim();
        let terms: Vec<_> = query.split_whitespace().collect();
        if terms.len() > 16 {
            return Err(invalid("Source search query must contain at most 16 whitespace-separated terms"));
        }
        if selected.len() > 50 {
            return Err(invalid("Source search selected sources must contain at most 50 items"));
        }
        if limit == 0 {
            return Err(invalid("Source search limit must be positive"));
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
        let title_terms: Vec<_> = long
            .iter()
            .chain(short.iter())
            .map(|term| {
                term.replace('!', "!!")
                    .replace('%', "!%")
                    .replace('_', "!_")
            })
            .collect();
        let title_terms_json =
            serde_json::to_string(&title_terms).map_err(|_| invalid("Invalid title search"))?;
        let short_json =
            serde_json::to_string(&escaped).map_err(|_| invalid("Invalid search text"))?;
        let selected_json =
            serde_json::to_string(selected).map_err(|_| invalid("Invalid selected sources"))?;
        let kinds_json = kinds
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| invalid("Invalid source kinds"))?;
        let allowed_keys_json = request
            .scope_grant
            .object_keys
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| invalid("Invalid granted objects"))?;
        // Apply scope/policy/current-version constraints before materializing
        // candidates, including the short-query fallback.
        let source_filters = "s.workspace_id=?2 AND s.scope_key=?3 AND (?4 OR s.is_current)
            AND (?9 IS NULL OR json_extract(s.object_json,'$.kind') IN (SELECT value FROM json_each(?9)))
            AND (?11 IS NULL OR s.object_key IN (SELECT value FROM json_each(?11)))
            AND NOT EXISTS(SELECT 1 FROM source_access_policies x WHERE x.object_key=s.object_key AND x.excluded=1)";
        let filters = format!("{source_filters} AND NOT EXISTS(SELECT 1 FROM json_each(?5) t WHERE s.title NOT LIKE '%'||t.value||'%' ESCAPE '!' AND c.text NOT LIKE '%'||t.value||'%' ESCAPE '!')");
        let matches = if long.is_empty() {
            format!("SELECT c.id AS rowid,0.0 AS rank,substr(c.text,1,240) AS excerpt FROM source_index_snapshots s JOIN source_index_chunks c ON c.snapshot_id=s.id WHERE {filters}")
        } else {
            // Bundled SQLite otherwise scans scope/chunks first and reruns FTS MATCH per chunk.
            // At 3000 indexed Records that plan took seconds per search.
            format!("SELECT source_index_fts.rowid,bm25(source_index_fts) AS rank,snippet(source_index_fts,1,'','','…',64) AS excerpt FROM source_index_fts CROSS JOIN source_index_chunks c ON c.id=source_index_fts.rowid CROSS JOIN source_index_snapshots s ON s.id=c.snapshot_id WHERE source_index_fts MATCH ?1 AND {filters}")
        };
        // A title-only source has no body chunk or invented paragraph anchor.
        // Apply the identical source filters before it joins ranking/pagination.
        let sql = format!("WITH matches AS MATERIALIZED ({matches}), ranked AS (
            SELECT s.object_key,s.object_json,s.revision,s.version,s.title,s.updated_at,s.coverage_json,
                   c.locator_json,c.block_id,m.rank,m.excerpt,
                   ROW_NUMBER() OVER(PARTITION BY s.id ORDER BY m.rank,c.ordinal) AS n
            FROM matches m JOIN source_index_chunks c ON c.id=m.rowid
            JOIN source_index_snapshots s ON s.id=c.snapshot_id
            UNION ALL
            SELECT s.object_key,s.object_json,s.revision,s.version,s.title,s.updated_at,s.coverage_json,
                   'null' AS locator_json,NULL AS block_id,0.0 AS rank,'' AS excerpt,1 AS n
            FROM source_index_snapshots s WHERE {source_filters}
              AND NOT EXISTS(SELECT 1 FROM source_index_chunks c WHERE c.snapshot_id=s.id)
              AND NOT EXISTS(SELECT 1 FROM json_each(?10) t WHERE s.title NOT LIKE '%'||t.value||'%' ESCAPE '!')
        ) SELECT object_key,object_json,revision,version,title,locator_json,block_id,rank,excerpt,coverage_json
        FROM ranked WHERE n=1
        ORDER BY (title=?6 COLLATE NOCASE) DESC,(object_key IN (SELECT value FROM json_each(?7))) DESC,
                 rank,updated_at DESC,object_key,version DESC LIMIT ?8");
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
                    limit.min(50) as i64 + 1,
                    kinds_json,
                    title_terms_json,
                    allowed_keys_json
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
                        row.get::<_, String>(9)?,
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
                |(
                    key,
                    object,
                    revision,
                    version,
                    title,
                    locator,
                    block_id,
                    rank,
                    excerpt,
                    coverage,
                )| {
                    let object: ObjectRef = serde_json::from_str(&object)
                        .map_err(|_| invalid("Corrupt source identity"))?;
                    if object.key()? != key
                        || object.scope != *scope
                        || object.workspace_id != binding.workspace_id
                    {
                        return Err(invalid("Corrupt source cache scope"));
                    }
                    let locator: Option<SourceLocator> = serde_json::from_str(&locator)
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
                        locator,
                        title: title.clone(),
                        excerpt: excerpt.clone(),
                    };
                    let coverage: IndexCoverage = serde_json::from_str(&coverage)
                        .map_err(|_| invalid("Corrupt source coverage"))?;
                    Ok(SearchCandidate {
                        object_key: key,
                        title,
                        excerpt,
                        score: -rank,
                        source_ref,
                        coverage,
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

    #[test]
    fn source_search_query_schema_exposes_length_and_nonwhitespace_contract() {
        let schema = serde_json::to_value(schemars::schema_for!(crate::source_service::SourceSearchInput)).unwrap();
        let query = &schema["properties"]["query"];
        assert_eq!(query["type"], "string");
        assert_eq!(query["minLength"], 1);
        assert_eq!(query["maxLength"], 256);
        assert_eq!(query["pattern"], r"\S");
        let description = query["description"].as_str().unwrap_or_default();
        for semantic in ["non-whitespace", "256", "16", "trim"] {
            assert!(description.contains(semantic), "Missing {semantic}: {description}");
        }
    }

    #[test]
    fn source_search_reports_query_constraints_separately_from_budgets() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        let scope = Scope::Project { project_id: 1 };
        for (query, message) in [
            (String::new(), "Source search query must contain non-whitespace characters"),
            (" \t\n\u{3000}".into(), "Source search query must contain non-whitespace characters"),
            ("文".repeat(257), "Source search query must contain at most 256 characters"),
            (format!(" {} ", "a".repeat(255)), "Source search query must contain at most 256 characters"),
            (vec!["a"; 17].join(" "), "Source search query must contain at most 16 whitespace-separated terms"),
        ] {
            let error = index.search(&request(), &binding(), &scope, &query, &[], false, 8, None)
                .err().expect("invalid query");
            assert_eq!(error.code, ErrorCode::InvalidArgument);
            assert_eq!(error.message, message);
        }
        let selected = vec!["record:1".to_owned(); 51];
        for (selected, limit, message) in [
            (selected.as_slice(), 8, "Source search selected sources must contain at most 50 items"),
            ([].as_slice(), 0, "Source search limit must be positive"),
        ] {
            let error = index.search(&request(), &binding(), &scope, "evidence", selected, false, limit, None)
                .err().expect("invalid search budget");
            assert_eq!(error.code, ErrorCode::InvalidArgument);
            assert_eq!(error.message, message);
        }
    }

    #[test]
    fn source_search_accepts_unicode_character_and_term_boundaries_and_trims_query() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        let scope = Scope::Project { project_id: 1 };
        index.replace(&source(1, scope.clone(), "Evidence", "evidence")).unwrap();
        for query in ["文".repeat(256), vec!["a"; 16].join(" ")] {
            assert!(index.search(&request(), &binding(), &scope, &query, &[], false, 8, None).is_ok());
        }
        let page = index.search(&request(), &binding(), &scope, " \tevidence\n", &[], false, 8, None).unwrap();
        assert_eq!(page.items.len(), 1);
    }

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
                object_keys: None,
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
            coverage: IndexCoverage {
                chars: text.chars().count() as u32,
                complete: true,
            },
        }
    }
    #[test]
    fn source_index_discovers_title_only_sources_without_fabricating_body_or_locator() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        let scope = Scope::Project { project_id: 1 };
        let mut scan = source(1, scope.clone(), "扫描验收资料", "unused");
        scan.object.kind = ObjectKind::File;
        scan.chunks.clear();
        scan.coverage = IndexCoverage {
            chars: 0,
            complete: false,
        };
        index.replace(&scan).unwrap();
        let found = index
            .search(
                &request(),
                &binding(),
                &scope,
                "验收",
                &[],
                false,
                8,
                Some(&[ObjectKind::File]),
            )
            .unwrap();
        assert_eq!(found.items.len(), 1);
        assert_eq!(found.items[0].source_ref.object, scan.object);
        assert_eq!(found.items[0].source_ref.excerpt, "");
        assert!(found.items[0].source_ref.locator.is_none());
        assert_eq!(found.items[0].coverage.chars, 0);
        assert!(!found.items[0].coverage.complete);
        index.exclude(&scan.object, true).unwrap();
        assert!(index
            .search(&request(), &binding(), &scope, "验收", &[], true, 8, None)
            .unwrap()
            .items
            .is_empty());
        let mut empty = source(2, scope.clone(), "Empty 100% plan", "unused");
        empty.chunks.clear();
        empty.coverage = IndexCoverage {
            chars: 0,
            complete: true,
        };
        index.replace(&empty).unwrap();
        let found = index
            .search(
                &request(),
                &binding(),
                &scope,
                "Empty plan",
                &[],
                false,
                8,
                None,
            )
            .unwrap();
        assert_eq!(found.items.len(), 1);
        assert_eq!(found.items[0].source_ref.object, empty.object);
        assert!(found.items[0].source_ref.locator.is_none());
        assert!(index
            .search(
                &request(),
                &binding(),
                &scope,
                "absent%",
                &[],
                false,
                8,
                None
            )
            .unwrap()
            .items
            .is_empty());
        assert_eq!(
            index
                .search(&request(), &binding(), &scope, "%", &[], false, 8, None)
                .unwrap()
                .items
                .len(),
            1
        );
    }
    #[test]
    fn source_index_filters_supported_kinds_before_ranking_limit_and_pagination_hint() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        let scope = Scope::Project { project_id: 1 };
        let visible = source(1, scope.clone(), "Visible", "evidence");
        index.replace(&visible).unwrap();
        let mut unsupported = source(2, scope.clone(), "evidence", "evidence");
        unsupported.object.kind = ObjectKind::QuickNote;
        unsupported.version = None;
        index.replace(&unsupported).unwrap();
        let page = index
            .search(
                &request(),
                &binding(),
                &scope,
                "evidence",
                &[],
                false,
                1,
                Some(&[ObjectKind::Record, ObjectKind::File]),
            )
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].source_ref.object, visible.object);
        assert!(!page.has_more);
    }
    #[test]
    fn source_index_upgrades_earlier_cache_without_losing_exclusion_policy() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE source_index_snapshots (id INTEGER PRIMARY KEY,object_key TEXT NOT NULL,workspace_id TEXT NOT NULL,scope_key TEXT NOT NULL,object_json TEXT NOT NULL,revision TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,title TEXT NOT NULL,updated_at TEXT NOT NULL,is_current INTEGER NOT NULL CHECK(is_current IN (0,1)),UNIQUE(object_key,revision,version)); CREATE TABLE source_index_exclusions(object_key TEXT PRIMARY KEY);").unwrap();
        let item = source(
            1,
            Scope::Project { project_id: 1 },
            "Policy",
            "policy evidence",
        );
        conn.execute(
            "INSERT INTO source_index_exclusions(object_key) VALUES (?1)",
            [item.object.key().unwrap()],
        )
        .unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        index.replace(&item).unwrap();
        assert!(index
            .search(
                &request(),
                &binding(),
                &item.object.scope,
                "evidence",
                &[],
                false,
                8,
                None
            )
            .unwrap()
            .items
            .is_empty());
        index.exclude(&item.object, false).unwrap();
        let reopened = SourceIndex::prepare(&conn).unwrap();
        let page = reopened
            .search(
                &request(),
                &binding(),
                &item.object.scope,
                "evidence",
                &[],
                false,
                8,
                None,
            )
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.items[0].coverage.complete);
        assert_eq!(page.items[0].coverage.chars, 15);
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
                    None,
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
                    None,
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
                8,
                None
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
                .search(
                    &request(),
                    &binding(),
                    &scope,
                    "evidence",
                    &[],
                    false,
                    8,
                    None
                )
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
                None,
            )
            .err()
            .expect("ungranted scope");
        assert_eq!(denied.code, ErrorCode::ScopeDenied);
        index.exclude(&item.object, true).unwrap();
        assert!(index
            .search(
                &request(),
                &binding(),
                &scope,
                "evidence",
                &[],
                false,
                8,
                None
            )
            .unwrap()
            .items
            .is_empty());
        index.exclude(&item.object, false).unwrap();
        let mut current = item.clone();
        current.revision = format!("sha256:{}", "b".repeat(64));
        current.chunks[0].text = "updated evidence".into();
        current.coverage.chars = 16;
        current.version = Some(2);
        index.replace(&current).unwrap();
        assert!(index
            .search(
                &request(),
                &binding(),
                &scope,
                "searchable",
                &[],
                false,
                8,
                None
            )
            .unwrap()
            .items
            .is_empty());
        assert_eq!(
            index
                .search(
                    &request(),
                    &binding(),
                    &scope,
                    "searchable",
                    &[],
                    true,
                    8,
                    None
                )
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
                    8,
                    None
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
                None,
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
                    8,
                    None
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
                    8,
                    None
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
        replacement.coverage.chars = 15;
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
                None,
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
                None,
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
                None,
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
    #[test]
    fn object_limited_search_filters_before_rank_and_limit() {
        let conn = Connection::open_in_memory().unwrap();
        let index = SourceIndex::prepare(&conn).unwrap();
        let scope = Scope::Project { project_id: 1 };
        let allowed = source(1, scope.clone(), "Allowed evidence", "evidence");
        let hidden = source(2, scope.clone(), "evidence", "evidence evidence");
        index.replace(&allowed).unwrap();
        index.replace(&hidden).unwrap();
        let mut restricted = request();
        restricted.scope_grant.object_keys = Some(vec![allowed.object.key().unwrap()]);
        let page = index.search(&restricted, &binding(), &scope, "evidence",
            &[hidden.object.key().unwrap()], false, 1, None).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].object_key, allowed.object.key().unwrap());
        assert!(!page.has_more);

        let title_only = IndexSource {
            chunks: vec![],
            coverage: IndexCoverage { chars: 0, complete: false },
            ..allowed
        };
        index.replace(&title_only).unwrap();
        let page = index.search(&restricted, &binding(), &scope, "Allowed",
            &[hidden.object.key().unwrap()], false, 1, None).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].object_key, title_only.object.key().unwrap());
        assert!(!page.has_more);
    }
}
