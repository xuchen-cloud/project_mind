//! Workspace Record references use their own typed token and business table.
use super::{
    build_internal_reference_search_fields, normalize_internal_reference_label, truncate_text,
    Database, InternalReferenceSearchCandidate, INTERNAL_REFERENCE_PRIORITY_NOTE_CONTENT,
    INTERNAL_REFERENCE_PRIORITY_NOTE_TITLE,
};
use crate::models::{InternalReferenceResolveResult, InternalReferenceSearchResult, TodoScope};
use anyhow::Result;
use rusqlite::OptionalExtension;

impl Database {
    pub(super) fn workspace_record_reference_resolve(
        &self,
        id: i64,
    ) -> Result<Option<InternalReferenceResolveResult>> {
        super::agent_record_withdrawals::require_record_visible(
            &self.conn,
            &crate::record_documents::RecordTarget {
                scope: crate::agent::models::Scope::Workspace,
                record_id: id,
            },
        )
        .map_err(|error| anyhow::anyhow!(serde_json::to_string(&error).unwrap_or(error.message)))?;
        Ok(self.conn.query_row(
            "SELECT id,CASE WHEN NULLIF(TRIM(title),'') IS NOT NULL AND TRIM(title)!='记录' THEN TRIM(title) ELSE COALESCE(NULLIF(TRIM(content_markdown),''),'记录') END FROM workspace_notes WHERE id=?1 AND note_kind='workspace_note'",
            [id],
            |row| {
                let id: i64 = row.get(0)?;
                Ok(InternalReferenceResolveResult {
                    kind: "workspace_record".into(),
                    id,
                    label: truncate_text(&normalize_internal_reference_label("workspace_record", &row.get::<_, String>(1)?), 72),
                    scope: TodoScope::Workspace,
                    project_id: None,
                    route: format!("/workspace/records/{id}"),
                    focus_id: None,
                    managed_path: None,
                })
            },
        ).optional()?)
    }
    pub(super) fn workspace_record_reference_candidates(
        &self,
    ) -> Result<Vec<InternalReferenceSearchCandidate>> {
        let mut statement=self.conn.prepare("SELECT id,CASE WHEN NULLIF(TRIM(title),'') IS NOT NULL AND TRIM(title)!='记录' THEN TRIM(title) ELSE COALESCE(NULLIF(TRIM(content_markdown),''),'记录') END,CASE WHEN NULLIF(TRIM(title),'') IS NOT NULL AND TRIM(title)!='记录' THEN TRIM(title) ELSE '' END,content_markdown,updated_at FROM agent_visible_workspace_notes WHERE note_kind='workspace_note' ORDER BY updated_at DESC")?;
        let rows = statement.query_map([], |row| {
            Ok(InternalReferenceSearchCandidate {
                result: InternalReferenceSearchResult {
                    kind: "workspace_record".into(),
                    id: row.get(0)?,
                    scope: TodoScope::Workspace,
                    project_id: None,
                    label: truncate_text(
                        &normalize_internal_reference_label(
                            "workspace_record",
                            &row.get::<_, String>(1)?,
                        ),
                        72,
                    ),
                    subtitle: "工作区".into(),
                    updated_at: row.get(4)?,
                },
                fields: build_internal_reference_search_fields([
                    (INTERNAL_REFERENCE_PRIORITY_NOTE_TITLE, row.get(2)?),
                    (INTERNAL_REFERENCE_PRIORITY_NOTE_CONTENT, row.get(3)?),
                ]),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
#[cfg(test)]
mod tests {
    use super::super::Database;
    use crate::models::*;
    #[test]
    fn workspace_record_reference_search_navigation_and_todo_scope_are_distinct() {
        let directory = tempfile::tempdir().unwrap();
        let mut db = Database::open(
            &directory.path().join("references.sqlite"),
            directory.path(),
            None,
        )
        .unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Reference Project".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let workspace = db
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("共同资料 工作区".into()),
                html: "<p>个人方法</p>".into(),
                markdown: "个人方法".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let record = db
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                note_id: None,
                title: Some("共同资料 项目".into()),
                html: "<p>项目资料</p>".into(),
                markdown: "项目资料".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        assert_eq!(workspace.id, record.id);
        let resolved = db
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "workspace_record".into(),
                id: workspace.id,
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            resolved.route,
            format!("/workspace/records/{}", workspace.id)
        );
        assert_eq!(resolved.scope, TodoScope::Workspace);
        assert_eq!(resolved.project_id, None);
        let historical = db
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "note".into(),
                id: record.id,
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            historical.route,
            format!("/projects/{}/records/{}", project.id, record.id)
        );
        let query = |scope: &str, project_id, query: &str| InternalReferenceSearchInput {
            scope: scope.into(),
            project_id,
            query: query.into(),
            limit: 8,
        };
        let hits = db
            .internal_reference_search(query("workspace", None, "共同资料"))
            .unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits
            .iter()
            .any(|hit| hit.kind == "workspace_record" && hit.scope == TodoScope::Workspace));
        let project_hits = db
            .internal_reference_search(query("project", Some(project.id), "共同资料"))
            .unwrap();
        assert_eq!(project_hits.len(), 1);
        assert_eq!(project_hits[0].kind, "note");
        let filtered = db
            .internal_reference_search(query("workspace", None, "workspace_record:共同资料"))
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].kind, "workspace_record");
        let token = format!("[[workspace_record:{}|个人方法]]", workspace.id);
        db.todo_create(TodoCreateInput {
            scope: TodoScope::Workspace,
            project_id: None,
            content: token.clone(),
            priority: "not_urgent_important".into(),
            due_date: None,
            tag_ids: vec![],
        })
        .unwrap();
        let denied = db
            .todo_create(TodoCreateInput {
                scope: TodoScope::Project,
                project_id: Some(project.id),
                content: token,
                priority: "not_urgent_important".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap_err();
        assert!(denied.to_string().contains("不能引用 Workspace"));
        db.workspace_record_delete(WorkspaceRecordDeleteInput {
            note_id: workspace.id,
        })
        .unwrap();
        assert!(db
            .internal_reference_resolve(InternalReferenceResolveInput {
                kind: "workspace_record".into(),
                id: workspace.id
            })
            .unwrap()
            .is_none());
        assert_eq!(
            db.internal_reference_resolve(InternalReferenceResolveInput {
                kind: "note".into(),
                id: record.id
            })
            .unwrap()
            .unwrap()
            .project_id,
            Some(project.id)
        );
    }
}
