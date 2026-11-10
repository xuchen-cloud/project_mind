//! Project identity, physical root placement and SQL/outbox have one recoverable
//! outcome. Callers submit ProjectUpdateInput; staging and recovery stay private.
use super::{
    file_versions as files, project_directory_changes::directory_identity, project_directory_name,
    rebase_path_prefix, Database, CURRENT_SCHEMA_VERSION, WORKSPACE_HIDDEN_DIR_NAME,
};
use crate::models::{ProjectRecord, ProjectUpdateInput};
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const JOURNALS: &str = ".project-mind/project-root-renames";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RootRenameIntent {
    schema_version: u32,
    workspace_id: Option<String>,
    workspace_identity: files::FileIdentity,
    project_id: i64,
    original: String,
    next: String,
    identity: files::FileIdentity,
}

struct Durability<'a>(&'a Connection, i64);
impl Drop for Durability<'_> {
    fn drop(&mut self) {
        if let Err(error) = self.0.pragma_update(None, "synchronous", self.1) {
            eprintln!("Project root synchronous restore failed: {error}");
        }
    }
}

impl Database {
    pub(super) fn migrate_project_root_schema(&self) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute_batch(include_str!("project_root_rename.sql"))?;
        tx.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)?;
        tx.commit()?;
        Ok(())
    }

    pub fn project_update(&self, input: ProjectUpdateInput) -> Result<ProjectRecord> {
        self.project_root_recover_pending()?;
        self.file_version_recover_pending()?;
        let project_id = input.project_id;
        let _owner = self.file_project_lock(project_id, true)?;
        let _permit = self.file_commit_permit().map_err(|e| anyhow!(e.message))?;
        self.project_root_recover_locked(project_id)?;
        let previous: i64 = self
            .conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))?;
        self.conn
            .pragma_update(None, "synchronous", previous.max(2))?;
        let _durability = Durability(&self.conn, previous);
        let outcome = self.project_update_transaction(input);
        if outcome.is_ok() {
            crash_point(4);
        }
        // The SQL transaction has ended before recovery reads its committed root.
        // This handles both ordinary errors and the same intent left by SIGKILL.
        let recovery = self.project_root_recover_locked(project_id);
        match (outcome, recovery) {
            (result, Ok(())) => result,
            (Ok(_), Err(error)) => {
                Err(error.context("Project update committed; root recovery remains pending"))
            }
            (Err(error), Err(recovery)) => Err(error.context(format!(
                "Project root recovery remains pending: {recovery:#}"
            ))),
        }
    }

    fn project_root_intent_path(&self, project_id: i64) -> PathBuf {
        self.workspace_root
            .join(JOURNALS)
            .join(format!("{project_id}.json"))
    }

    fn project_root_prepare(
        &self,
        project_id: i64,
        original: &Path,
        next: &Path,
    ) -> Result<RootRenameIntent> {
        let intent = RootRenameIntent {
            schema_version: 1,
            workspace_id: self.native_workspace_id.clone(),
            workspace_identity: directory_identity(&self.workspace_root)?,
            project_id,
            original: files::relative(&self.workspace_root, original)?,
            next: files::relative(&self.workspace_root, next)?,
            identity: directory_identity(original)?,
        };
        crash_point(0);
        let directory = self.workspace_root.join(JOURNALS);
        files::create_owned_directories(&self.workspace_root, &directory)?;
        let staging = directory.join(format!(".{project_id}-{}.tmp", files::token()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)?;
        file.write_all(&serde_json::to_vec(&intent)?)?;
        file.sync_all()?;
        files::move_exclusive(&staging, &self.project_root_intent_path(project_id))?;
        crash_point(1);
        Ok(intent)
    }

    fn project_root_recover_locked(&self, project_id: i64) -> Result<()> {
        let path = self.project_root_intent_path(project_id);
        if !path.try_exists()? {
            return Ok(());
        }
        files::relative(&self.workspace_root, &path)?;
        files::regular(&path)?;
        let intent: RootRenameIntent = serde_json::from_slice(&fs::read(&path)?)?;
        if intent.schema_version != 1
            || intent.project_id != project_id
            || project_id <= 0
            || intent.workspace_id != self.native_workspace_id
            || intent.workspace_identity != directory_identity(&self.workspace_root)?
            || intent.original == intent.next
        {
            bail!("Invalid Project root intent; recovery evidence retained");
        }
        let original = files::owned(&self.workspace_root, &intent.original)?;
        let next = files::owned(&self.workspace_root, &intent.next)?;
        // Project roots cannot target Workspace internals or a nested/foreign root.
        if original.parent() != Some(self.workspace_root.as_path())
            || next.parent() != Some(self.workspace_root.as_path())
            || original
                .file_name()
                .is_some_and(|n| n == WORKSPACE_HIDDEN_DIR_NAME)
            || next
                .file_name()
                .is_some_and(|n| n == WORKSPACE_HIDDEN_DIR_NAME)
        {
            bail!("Invalid Project root placement; intent retained");
        }
        let stored: String = self.conn.query_row(
            "SELECT root_path FROM projects WHERE id=?1",
            [project_id],
            |r| r.get(0),
        )?;
        let committed_root = self.decode_path_ref(&stored);
        let (wanted, other) = if committed_root == original {
            (&original, &next)
        } else if committed_root == next {
            (&next, &original)
        } else {
            bail!("Project root no longer matches its intent; evidence retained")
        };
        if wanted.try_exists()? {
            if directory_identity(wanted)? != intent.identity {
                bail!("Project root is occupied by another directory; intent retained");
            }
        } else {
            if directory_identity(other)? != intent.identity {
                bail!("Project root recovery identity differs; intent retained");
            }
            files::move_exclusive(other, wanted)?;
            if directory_identity(wanted)? != intent.identity {
                bail!("Project root identity changed during recovery; intent retained");
            }
        }
        fs::remove_file(&path)?;
        files::sync_directory(path.parent().unwrap())?;
        Ok(())
    }

    pub(super) fn project_root_recover_pending(&self) -> Result<()> {
        let directory = self.workspace_root.join(JOURNALS);
        if !directory.try_exists()? {
            return Ok(());
        }
        files::relative(&self.workspace_root, &directory)?;
        directory_identity(&directory)?;
        for entry in fs::read_dir(&directory)? {
            let path = entry?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let id: i64 = path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| anyhow!("Invalid Project root intent filename"))?
                .parse()?;
            if id <= 0 || path != self.project_root_intent_path(id) {
                bail!("Invalid Project root intent filename");
            }
            let _owner = self.file_project_lock(id, true)?;
            let _permit = self.file_commit_permit().map_err(|e| anyhow!(e.message))?;
            self.project_root_recover_locked(id)?;
        }
        Ok(())
    }
    /// A location is granted only to an exact reference already persisted by this
    /// Record. FK rekeying follows a later owner move without granting siblings.
    fn project_root_retain_record_assets(&self, project_id: i64, original: &Path) -> Result<()> {
        use crate::{agent::models::Scope, record_documents::RecordTarget};
        let ids = self
            .conn
            .prepare("SELECT id FROM notes WHERE project_id=?1")?
            .query_map([project_id], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in ids {
            let target = RecordTarget {
                scope: Scope::Project { project_id },
                record_id: id,
            };
            let Some(head) = self
                .record_document_head(&target)
                .map_err(|e| anyhow!(e.message))?
            else {
                continue;
            };
            let mut assets = head.projection.validate().map_err(|e| anyhow!(e.message))?;
            assets.extend(self.conn.prepare("SELECT a.asset_ref FROM record_version_assets a JOIN record_versions v ON v.id=a.version_id WHERE v.record_key=?1")?
                .query_map([target.key().map_err(|e| anyhow!(e.message))?], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
            let key = target.key().map_err(|e| anyhow!(e.message))?;
            let locations = self.record_root_asset_paths(&key)?;
            for asset in assets {
                let actual = self
                    .workspace_root
                    .join(locations.get(&asset).unwrap_or(&asset));
                if let Ok(suffix) = actual.strip_prefix(original) {
                    let suffix = suffix
                        .to_str()
                        .ok_or_else(|| anyhow!("Invalid Record resource path"))?
                        .replace(std::path::MAIN_SEPARATOR, "/");
                    if !crate::record_documents::relative_asset(&suffix) {
                        bail!("Invalid retained Record resource path");
                    }
                    self.conn.execute("INSERT OR IGNORE INTO record_root_asset_locations(record_key,asset_ref,project_id,path_suffix) VALUES(?1,?2,?3,?4)", params![key,asset,project_id,suffix])?;
                }
            }
        }
        Ok(())
    }

    pub(super) fn record_root_asset_paths(
        &self,
        key: &str,
    ) -> Result<std::collections::BTreeMap<String, String>> {
        let rows = self.conn.prepare("SELECT a.asset_ref,p.root_path,a.path_suffix FROM record_root_asset_locations a JOIN projects p ON p.id=a.project_id WHERE a.record_key=?1")?
            .query_map([key], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(asset, root, suffix)| {
                if !crate::record_documents::relative_asset(&asset)
                    || !crate::record_documents::relative_asset(&suffix)
                {
                    bail!("Invalid Record resource location");
                }
                let actual = self.decode_path_ref(&root).join(suffix);
                let relative = actual
                    .strip_prefix(&self.workspace_root)?
                    .to_str()
                    .ok_or_else(|| anyhow!("Invalid Record resource encoding"))?
                    .replace(std::path::MAIN_SEPARATOR, "/");
                Ok((asset, relative))
            })
            .collect()
    }

    /// Retained history is owned by the File, independent of its live owner.
    /// Root-local bytes move with the directory; registered external history
    /// remains at its verified Workspace path, including a former owner's root.
    fn project_root_retained_path(
        &self,
        path: &Path,
        original: &Path,
        next: &Path,
    ) -> Result<PathBuf> {
        files::relative(&self.workspace_root, path)?;
        Ok(rebase_path_prefix(path, original, next).unwrap_or_else(|| path.to_path_buf()))
    }

    pub(super) fn rename_project_root(
        &self,
        current: &ProjectRecord,
        next_name: &str,
    ) -> Result<()> {
        let current_dir = PathBuf::from(&current.root_path);
        if !current_dir.exists() {
            return Err(anyhow!(
                "project folder does not exist at {}",
                current_dir.display()
            ));
        }

        let next_dir = self
            .workspace_root
            .join(project_directory_name(next_name.trim())?);
        if current_dir == next_dir {
            return Ok(());
        }
        self.file_owner_require_unshared_root(&current_dir, Some(current.id))?;
        self.record_owner_require_unshared_root(&current_dir, Some(current.id))?;
        self.file_working_require_owner_recovered(Some(current.id))
            .map_err(|error| anyhow!(error.message))?;
        self.file_project_root_available(&next_dir)?;

        if next_dir.exists() {
            return Err(anyhow!("文件夹名称已被占用，项目名称未保存"));
        }

        let documents = self.fetch_all_documents_for_project(current.id)?;
        let mut document_path_updates = Vec::with_capacity(documents.len());
        let mut version_path_updates = Vec::new();
        for document in &documents {
            let next_managed_path =
                rebase_path_prefix(Path::new(&document.managed_path), &current_dir, &next_dir)
                    .ok_or_else(|| {
                        anyhow!(
                            "document {} is outside project root: {}",
                            document.id,
                            document.managed_path
                        )
                    })?;
            let next_history_dir = self.project_root_retained_path(
                Path::new(&document.history_dir_path),
                &current_dir,
                &next_dir,
            )?;
            let next_original_path_ref = self.rewrite_path_ref_prefix_if_within(
                &self.encode_path_ref(Path::new(&document.original_path)),
                &current_dir,
                &next_dir,
            );

            document_path_updates.push((
                document.id,
                self.encode_path_ref(&next_managed_path),
                self.encode_path_ref(&next_history_dir),
                next_original_path_ref,
            ));

            let versions = self.fetch_document_versions(document.id)?;
            for version in &versions {
                let next_managed_path = self.project_root_retained_path(
                    Path::new(&version.managed_path),
                    &current_dir,
                    &next_dir,
                )?;
                let next_source_path_ref = self.rewrite_path_ref_prefix_if_within(
                    &self.encode_path_ref(Path::new(&version.source_path)),
                    &current_dir,
                    &next_dir,
                );
                version_path_updates.push((
                    version.id,
                    self.encode_path_ref(&next_managed_path),
                    next_source_path_ref,
                ));
            }
        }

        let next_root_path_ref = self.encode_path_ref(&next_dir);

        let journal = self.project_root_prepare(current.id, &current_dir, &next_dir)?;
        files::move_exclusive(&current_dir, &next_dir)?;
        if directory_identity(&next_dir)? != journal.identity {
            bail!("Project root identity changed during rename; intent retained");
        }
        crash_point(2);
        self.project_root_retain_record_assets(current.id, &current_dir)?;
        self.conn.execute(
            "UPDATE projects SET root_path = ?1 WHERE id = ?2",
            params![next_root_path_ref, current.id],
        )?;

        for (document_id, managed_path_ref, history_dir_ref, original_path_ref) in
            &document_path_updates
        {
            self.conn.execute(
                r#"
                UPDATE documents
                SET managed_path = ?1,
                    history_dir_path = ?2,
                    original_path = ?3
                WHERE id = ?4
                "#,
                params![
                    managed_path_ref,
                    history_dir_ref,
                    original_path_ref,
                    document_id
                ],
            )?;
        }

        for (version_id, managed_path_ref, source_path_ref) in &version_path_updates {
            self.conn.execute(
                r#"
                UPDATE document_versions
                SET managed_path = ?1,
                    source_path = ?2
                WHERE id = ?3
                "#,
                params![managed_path_ref, source_path_ref, version_id],
            )?;
        }

        Ok(())
    }
}

#[cfg(test)]
pub(super) fn crash_point(phase: u8) {
    if std::env::var("MIND_PROJECT_ROOT_CRASH_STAGE")
        .ok()
        .as_deref()
        == Some(&phase.to_string())
    {
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            unsafe {
                kill(std::process::id() as i32, 9);
            }
        }
        std::process::exit(91);
    }
}
#[cfg(not(test))]
pub(super) fn crash_point(_: u8) {}
