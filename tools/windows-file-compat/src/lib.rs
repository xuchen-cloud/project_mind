#[cfg(not(windows))]
compile_error!("windows-file-compat requires a Windows target; use --target x86_64-pc-windows-msvc for cargo check --tests on other hosts");

// The directory matches the production parent module's path resolution while
// keeping the actual module nesting and pub(super) boundary identical.
#[cfg(windows)]
#[path = "../../../src-tauri/src/db"]
mod file_versions {
    use std::path::Path;

    #[path = "file_versions_windows.rs"]
    mod windows;

    #[allow(dead_code)]
    pub(crate) fn move_exclusive(from: &Path, to: &Path) -> anyhow::Result<()> {
        windows::move_exclusive(from, to)
    }
}
