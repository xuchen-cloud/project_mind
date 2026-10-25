//! One native ownership boundary for Workspace and Project Files.
use super::Database;
use crate::agent::models::Scope;
use anyhow::{bail, Result};
use rusqlite::OptionalExtension;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn scope(project_id: Option<i64>) -> Scope {
    project_id.map_or(Scope::Workspace, |project_id| Scope::Project { project_id })
}
pub(crate) fn owner(scope: &Scope) -> Option<i64> {
    match scope {
        Scope::Workspace => None,
        Scope::Project { project_id } => Some(*project_id),
    }
}
pub(super) fn owner_key(project_id: Option<i64>) -> String {
    project_id.map_or_else(|| "workspace".into(), |id| id.to_string())
}
fn case_prefix(path: &Path, prefix: &Path) -> bool {
    let mut components = path.components();
    prefix.components().all(|expected| {
        components.next().is_some_and(|actual| {
            actual
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&expected.as_os_str().to_string_lossy())
        })
    })
}
impl Database {
    pub(crate) fn file_project_ids(&self) -> Result<Vec<i64>> {
        let mut statement = self.conn.prepare("SELECT id FROM projects ORDER BY id")?;
        let ids = statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<i64>>>()?;
        Ok(ids)
    }
    pub(crate) fn file_project_roots(&self) -> Result<Vec<(i64, PathBuf)>> {
        let mut statement = self
            .conn
            .prepare("SELECT id,root_path FROM projects ORDER BY id")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            row.map(|(id, path)| (id, self.decode_path_ref(&path)))
                .map_err(Into::into)
        })
        .collect()
    }
    pub(crate) fn file_scope_root(&self, project_id: impl Into<Option<i64>>) -> Result<PathBuf> {
        let project_id = project_id.into();
        let root = match project_id {
            Some(id) => PathBuf::from(self.project_record(id)?.root_path),
            None => self.workspace_root.join("files"),
        };
        super::file_versions::relative(&self.workspace_root, &root)?;
        if root
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            bail!("File root cannot be a symlink");
        }
        let actual = if root.exists() {
            root.canonicalize()?
        } else {
            root.clone()
        };
        let mut statement = self.conn.prepare("SELECT id,root_path FROM projects")?;
        let projects =
            statement.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for project in projects {
            let (id, path) = project?;
            if project_id == Some(id) {
                continue;
            }
            let path = self.decode_path_ref(&path);
            let path = if path.exists() {
                path.canonicalize()?
            } else {
                path
            };
            if actual.starts_with(&path)
                || path.starts_with(&actual)
                || (project_id.is_none()
                    && (case_prefix(&actual, &path) || case_prefix(&path, &actual)))
            {
                bail!("File directories overlap an existing Project; resolve the directory conflict first");
            }
        }
        Ok(root)
    }
    pub(crate) fn ensure_file_scope_root(&self, project_id: Option<i64>) -> Result<PathBuf> {
        let root = self.file_scope_root(project_id)?;
        if self.file_scope_archived(project_id)? {
            bail!("Project is archived");
        }
        if project_id.is_none() {
            super::file_versions::create_owned_directories(&self.workspace_root, &root)?;
        } else if !root.is_dir() {
            bail!("Project File directory does not exist");
        }
        Ok(root)
    }
    pub(super) fn file_scope_archived(&self, project_id: impl Into<Option<i64>>) -> Result<bool> {
        project_id
            .into()
            .map(|id| self.project_record(id).map(|p| p.is_archived))
            .transpose()
            .map(|value| value.unwrap_or(false))
    }
    pub(super) fn file_project_root_available(&self, candidate: &Path) -> Result<()> {
        let reserved = self.workspace_root.join("files");
        if case_prefix(candidate, &reserved) || case_prefix(&reserved, candidate) {
            bail!("Project directory conflicts with the reserved Workspace files directory");
        }
        let candidate = if candidate.exists() {
            candidate.canonicalize()?
        } else {
            candidate.to_path_buf()
        };
        let reserved = if reserved.exists() {
            reserved.canonicalize()?
        } else {
            reserved
        };
        // Project names are flat components. Case-insensitive comparison also
        // protects the same reservation on case-sensitive hosts before export.
        if candidate.starts_with(&reserved)
            || reserved.starts_with(&candidate)
            || candidate
                .to_string_lossy()
                .eq_ignore_ascii_case(&reserved.to_string_lossy())
        {
            bail!("Project directory conflicts with the reserved Workspace files directory");
        }
        Ok(())
    }
    pub(super) fn ensure_workspace_file_schema(&self) -> Result<()> {
        if self.schema_version()? >= 38 {
            return Ok(());
        }
        let required: bool = self
            .conn
            .prepare("PRAGMA table_info(documents)")?
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, bool>(3)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|(name, required)| name == "project_id" && *required);
        if required {
            let table: String = self.conn.query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'",
                [],
                |r| r.get(0),
            )?;
            let schema = table.replacen("project_id INTEGER NOT NULL", "project_id INTEGER", 1);
            if schema == table {
                bail!("Cannot identify the native File ownership column");
            }
            let views = self
                .conn
                .prepare(
                    "SELECT name,sql FROM sqlite_master WHERE type='view' AND sql IS NOT NULL",
                )?
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let attached = self.conn.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='documents' AND type IN ('index','trigger') AND sql IS NOT NULL")?.query_map([], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            self.conn.pragma_update(None, "foreign_keys", "OFF")?;
            let result = (|| -> Result<()> {
                let tx = self.conn.unchecked_transaction()?;
                let sequence: Option<i64> = tx
                    .query_row(
                        "SELECT seq FROM sqlite_sequence WHERE name='documents'",
                        [],
                        |row| row.get(0),
                    )
                    .optional()?;
                for (name, _) in &views {
                    tx.execute_batch(&format!("DROP VIEW \"{}\"", name.replace('"', "\"\"")))?;
                }
                tx.execute_batch("CREATE TEMP TABLE workspace_file_copy AS SELECT * FROM documents; DROP TABLE documents;")?;
                tx.execute_batch(&schema)?;
                tx.execute_batch("INSERT INTO documents SELECT * FROM workspace_file_copy; DROP TABLE workspace_file_copy;")?;
                if let Some(sequence) = sequence {
                    tx.execute("DELETE FROM sqlite_sequence WHERE name='documents'", [])?;
                    tx.execute(
                        "INSERT INTO sqlite_sequence(name,seq) VALUES ('documents',?1)",
                        [sequence],
                    )?;
                }
                for sql in &attached {
                    tx.execute_batch(sql)?;
                }
                for (name, sql) in &views {
                    tx.execute_batch(if name == "agent_visible_files" {
                        super::agent_file_undo::FILE_VISIBILITY_VIEW_SQL
                    } else {
                        sql
                    })?;
                }
                let violations: bool = tx.prepare("PRAGMA foreign_key_check")?.exists([])?;
                if violations {
                    bail!("File ownership migration violates a foreign key");
                }
                tx.pragma_update(None, "user_version", 38)?;
                tx.commit()?;
                Ok(())
            })();
            self.conn.pragma_update(None, "foreign_keys", "ON")?;
            result?;
        } else {
            let tx = self.conn.unchecked_transaction()?;
            tx.execute_batch("DROP VIEW agent_visible_files;")?;
            tx.execute_batch(super::agent_file_undo::FILE_VISIBILITY_VIEW_SQL)?;
            tx.pragma_update(None, "user_version", 38)?;
            tx.commit()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DocumentImportInput, ProjectCreateInput};
    #[test]
    fn workspace_file_migration_preserves_project_versions_and_monotonic_identity() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let (_, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Original".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let source = external.path().join("original.md");
        fs::write(&source, b"Original bytes").unwrap();
        let document = db
            .document_import(DocumentImportInput {
                project_id: Some(project.id),
                source_path: source.to_string_lossy().into(),
                is_starred: true,
                tag_ids: None,
            })
            .unwrap();
        let versions = db
            .document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: document.id,
            })
            .unwrap();
        // Reconstitute the released schema-37 NOT NULL table with real linked
        // versions, identities and hashes. The high sequence represents IDs
        // already used by deleted Files and still present in retained receipts.
        let schema: String = db
            .conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='documents'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let schema = schema.replacen("project_id INTEGER,", "project_id INTEGER NOT NULL,", 1);
        assert!(schema.contains("project_id INTEGER NOT NULL"));
        let views = db
            .conn
            .prepare("SELECT name,sql FROM sqlite_master WHERE type='view'")
            .unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let indexes = db.conn.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='documents' AND type='index' AND sql IS NOT NULL").unwrap().query_map([], |r| r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        db.conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        for (name, _) in &views {
            db.conn
                .execute_batch(&format!("DROP VIEW \"{name}\";"))
                .unwrap();
        }
        db.conn
            .execute_batch(
                "CREATE TEMP TABLE old_files AS SELECT * FROM documents; DROP TABLE documents;",
            )
            .unwrap();
        db.conn.execute_batch(&schema).unwrap();
        db.conn.execute_batch("INSERT INTO documents SELECT * FROM old_files; DROP TABLE old_files; UPDATE sqlite_sequence SET seq=99 WHERE name='documents'; PRAGMA user_version=37;").unwrap();
        for sql in indexes {
            db.conn.execute_batch(&sql).unwrap();
        }
        for (_, sql) in views {
            db.conn.execute_batch(&sql).unwrap();
        }
        db.conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        drop(db);
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let retained = db.document_record(document.id).unwrap();
        assert_eq!(retained.project_id, Some(project.id));
        assert!(retained.is_starred);
        assert_eq!(fs::read(retained.managed_path).unwrap(), b"Original bytes");
        let restored_versions = db
            .document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: document.id,
            })
            .unwrap();
        assert_eq!(restored_versions[0].id, versions[0].id);
        assert!(!db
            .conn
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
        let source = external.path().join("workspace.md");
        fs::write(&source, b"Workspace bytes").unwrap();
        let imported = db
            .document_import(DocumentImportInput {
                project_id: None,
                source_path: source.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        assert_eq!(imported.id, 100);
        assert_eq!(
            db.workspace_page_get().unwrap().workspace_documents[0].id,
            100
        );
    }
    #[test]
    fn workspace_file_null_owner_version_journal_recovers_real_crash() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let (metadata, paths) =
            crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let original = external.path().join("original.html");
        fs::write(&original, b"<p>Original</p>").unwrap();
        let document = db
            .document_import(DocumentImportInput {
                project_id: None,
                source_path: original.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        fs::write(root.path().join("picked.html"), b"<p>Replaced</p>").unwrap();
        drop(db);
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::file_versions::tests::file_version_crash_process_fixture",
                "--ignored",
            ])
            .env("MIND_FILE_VERSION_CRASH_FIXTURE", root.path())
            .env("MIND_FILE_VERSION_GUI_CRASH", "1")
            .env("MIND_FILE_VERSION_CRASH_STAGE", "3")
            .output()
            .unwrap();
        assert!(!output.status.success());
        let mut db = crate::workspace_initialization::open_workspace_database(
            &paths.db_path,
            root.path(),
            None,
            &metadata.workspace_id,
        )
        .unwrap()
        .db;
        let current = db.document_record(document.id).unwrap();
        assert_eq!(current.current_version_number, 1);
        assert_eq!(fs::read(&current.managed_path).unwrap(), b"<p>Original</p>");
        let intent = db
            .file_version_prepare_gui(&crate::db::file_versions::GuiFileVersionPrepare {
                document_id: current.id,
                project_id: None,
                managed_path: current.managed_path,
                expected_version_number: 1,
                source_path: Some(root.path().join("picked.html").to_string_lossy().into()),
            })
            .unwrap();
        let binding = crate::agent::models::WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "real-open".into(),
        };
        let result = db
            .file_version_commit_gui(&binding, "gui-crash-save", &intent, false)
            .unwrap();
        assert_eq!(result.version_number, 2);
        let replay = db
            .file_version_commit_gui(&binding, "gui-crash-save", &intent, false)
            .unwrap();
        assert_eq!(result.version_number, replay.version_number);
        assert_eq!(
            db.document_list_versions(crate::models::DocumentListVersionsInput {
                document_id: document.id
            })
            .unwrap()
            .len(),
            2
        );
    }

    #[test]
    fn workspace_file_reserved_root_preserves_legacy_project_and_rejects_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let (_, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
        let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
        for name in ["files", "FILES"] {
            assert!(db
                .project_create(ProjectCreateInput {
                    name: name.into(),
                    summary: None,
                    status: None
                })
                .is_err());
        }
        let project = db
            .project_create(ProjectCreateInput {
                name: "Legacy".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let legacy = root.path().join("files");
        fs::rename(&project.root_path, &legacy).unwrap();
        db.conn
            .execute(
                "UPDATE projects SET name='files',root_path=?1 WHERE id=?2",
                rusqlite::params![db.encode_path_ref(&legacy), project.id],
            )
            .unwrap();
        db.project_update(crate::models::ProjectUpdateInput {
            project_id: project.id,
            name: Some("files".into()),
            summary: "Legacy remains editable".into(),
            summary_markdown: None,
            summary_html: None,
            summary_code_language: None,
            status: None,
        })
        .unwrap();
        let picked = external.path().join("picked.txt");
        fs::write(&picked, b"Legacy bytes").unwrap();
        let input = |owner| DocumentImportInput {
            project_id: owner,
            source_path: picked.to_string_lossy().into(),
            is_starred: false,
            tag_ids: None,
        };
        assert!(db.document_import(input(None)).is_err());
        let file = db.document_import(input(Some(project.id))).unwrap();
        assert_eq!(fs::read(file.managed_path).unwrap(), b"Legacy bytes");
        assert!(db
            .workspace_page_get()
            .unwrap()
            .workspace_documents
            .is_empty());
        let alias = root.path().join("Files");
        if !alias.exists() {
            fs::rename(&legacy, &alias).unwrap();
            db.conn
                .execute(
                    "UPDATE projects SET root_path=?1 WHERE id=?2",
                    rusqlite::params![db.encode_path_ref(&alias), project.id],
                )
                .unwrap();
            assert!(db.file_scope_root(None).is_err());
            assert_eq!(db.file_scope_root(Some(project.id)).unwrap(), alias);
        }

        #[cfg(unix)]
        {
            let clean = tempfile::tempdir().unwrap();
            let (_, paths) = crate::workspace::create_workspace(clean.path(), "password").unwrap();
            let mut db = Database::open(&paths.db_path, clean.path(), None).unwrap();
            std::os::unix::fs::symlink(external.path(), clean.path().join("files")).unwrap();
            assert!(db.document_import(input(None)).is_err());
            assert_eq!(fs::read(&picked).unwrap(), b"Legacy bytes");
        }
    }
}
