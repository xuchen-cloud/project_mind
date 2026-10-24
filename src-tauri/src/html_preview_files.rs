//! Verified File inputs for a read-only website rooted at the HTML directory.
use crate::{db::project_directory_files::FileBytesInput, db::Database};
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};

pub(crate) struct PreparedFile {
    pub name: String,
    pub bytes: Vec<u8>,
    input: FileBytesInput,
    relative_path: Option<String>,
}
impl PreparedFile {
    pub fn read(db: &Database, input: FileBytesInput, historical: bool) -> Result<Self> {
        let original = db.project_file_read_bytes(&input)?;
        if !original.name.to_ascii_lowercase().ends_with(".html")
            && !original.name.to_ascii_lowercase().ends_with(".htm")
            && original.mime != "text/html"
        {
            bail!("此文件不是 HTML 网页");
        }
        let relative_path = if historical {
            None
        } else {
            let current = db.project_file_resolve(&input.object)?;
            if current.state != "ready"
                || current.version_number != input.version_number
                || current.content_hash.as_deref() != Some(&input.expected_content_hash)
            {
                bail!("网页文件已变化，请刷新后打开");
            }
            Some(current.relative_path)
        };
        let bytes = STANDARD.decode(&original.base64)?;
        if bytes.len() != original.byte_length {
            bail!("网页原件不完整");
        }
        Ok(Self {
            name: original.name,
            bytes,
            input,
            relative_path,
        })
    }
    pub fn validate(&self, db: &Database) -> Result<()> {
        if let Some(path) = &self.relative_path {
            let current = db.project_file_resolve(&self.input.object)?;
            if current.state != "ready"
                || current.relative_path != *path
                || current.version_number != self.input.version_number
                || current.content_hash.as_deref() != Some(&self.input.expected_content_hash)
            {
                bail!("网页文件已变化，请刷新后打开");
            }
        }
        Ok(())
    }
    pub fn read_related(&self, db: &Database, path: &str) -> Result<(String, Vec<u8>)> {
        let Some(root_file) = &self.relative_path else {
            bail!("历史版本未保留关联资源快照");
        };
        if path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
            || path.contains(['\\', ':', '\0'])
        {
            bail!("资源超出网页目录");
        }
        self.validate(db)?;
        let reference =
            percent_encoding::utf8_percent_encode(path, percent_encoding::NON_ALPHANUMERIC)
                .to_string();
        let related = db.project_file_resolve_related(&self.input.object, &reference)?;
        let root_prefix = root_file.rsplit_once('/').map_or("", |(parent, _)| parent);
        if !root_prefix.is_empty()
            && !related
                .relative_path
                .starts_with(&format!("{root_prefix}/"))
        {
            bail!("资源超出网页目录");
        }
        if related.state != "ready" {
            bail!("网页资源尚不可用");
        }
        let bytes = db.project_file_read_bytes(&FileBytesInput {
            object: related.object,
            version_number: related.version_number,
            expected_content_hash: related
                .content_hash
                .ok_or_else(|| anyhow::anyhow!("网页资源没有完整版本"))?,
        })?;
        Ok((bytes.mime, STANDARD.decode(bytes.base64)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db::Database, models::ProjectCreateInput};
    use std::{fs, path::PathBuf};
    fn fixture() -> (tempfile::TempDir, Database, i64, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("web-workspace").unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Website".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let path = PathBuf::from(project.root_path);
        fs::create_dir(path.join("网页 空格")).unwrap();
        fs::write(
            path.join("网页 空格/index.html"),
            b"<script src='app.js'></script>",
        )
        .unwrap();
        fs::write(path.join("网页 空格/app.js"), b"document.title = 'working'").unwrap();
        (root, db, project.id, path)
    }
    fn input(db: &Database, project: i64) -> FileBytesInput {
        let file = db
            .project_file_register("web-workspace", project, "网页 空格/index.html")
            .unwrap();
        FileBytesInput {
            object: file.object,
            version_number: file.version_number,
            expected_content_hash: file.content_hash.unwrap(),
        }
    }
    #[test]
    fn html_site_reads_original_script_and_relative_project_file() {
        let (_root, db, project, _path) = fixture();
        let site = PreparedFile::read(&db, input(&db, project), false).unwrap();
        assert_eq!(site.bytes, b"<script src='app.js'></script>");
        let (mime, bytes) = site.read_related(&db, "app.js").unwrap();
        assert!(mime.contains("javascript"));
        assert_eq!(bytes, b"document.title = 'working'");
    }
    #[test]
    fn historical_html_never_loads_current_dependencies() {
        let (_root, db, project, path) = fixture();
        let original = input(&db, project);
        fs::write(path.join("网页 空格/index.html"), b"<h1>new</h1>").unwrap();
        db.project_file_resolve(&original.object).unwrap();
        let site = PreparedFile::read(&db, original, true).unwrap();
        assert!(site
            .read_related(&db, "app.js")
            .unwrap_err()
            .to_string()
            .contains("历史"));
        assert_eq!(site.bytes, b"<script src='app.js'></script>");
    }
    #[test]
    fn changed_root_retires_the_old_site_before_reading_assets() {
        let (_root, db, project, path) = fixture();
        let site = PreparedFile::read(&db, input(&db, project), false).unwrap();
        fs::write(path.join("网页 空格/index.html"), b"<h1>changed</h1>").unwrap();
        assert!(site.read_related(&db, "app.js").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn site_cannot_read_a_symlink_outside_its_root() {
        let (_root, db, project, path) = fixture();
        fs::write(path.join("private.js"), b"private project bytes").unwrap();
        std::os::unix::fs::symlink(path.join("private.js"), path.join("网页 空格/link.js"))
            .unwrap();
        let site = PreparedFile::read(&db, input(&db, project), false).unwrap();
        assert!(site.read_related(&db, "link.js").is_err());
    }
}
