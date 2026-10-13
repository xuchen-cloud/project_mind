//! OS type/application icons and registered handlers for work package #124.
//! DSH file-type mapping and render caching belong to the frontend. All icons
//! returned here are OS icons; application ids are opaque, never commands.
use crate::db::project_directory_files::FileServiceError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeFileApplication {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub is_default: bool,
}

#[cfg(target_os = "macos")]
#[path = "native_file_icons_macos.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "native_file_icons_windows.rs"]
mod platform;

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) use platform::Applications;

static NATIVE_ICON_JOBS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

pub(crate) async fn native_icon_permit() -> Result<tokio::sync::SemaphorePermit<'static>, String> {
    NATIVE_ICON_JOBS
        .acquire()
        .await
        .map_err(|error| error.to_string())
}

pub(crate) fn type_icon(name: &str) -> Result<Option<String>, String> {
    let extension = type_extension(name)?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return platform::type_icon(&extension).map(Some);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = extension;
        Ok(None)
    }
}

// This boundary accepts a name, never a path, executable or source code.
fn type_extension(name: &str) -> Result<String, String> {
    if name.is_empty()
        || name.chars().count() > 255
        || matches!(name, "." | "..")
        || name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
    {
        return Err("File type icon requires a basename of at most 255 characters".into());
    }
    // Match DSH fileExtension, including a leading dot as a suffix. Otherwise
    // `.txt` and `note.txt` share the frontend cache but request different types.
    Ok(name.rsplit_once('.').map(|(_, suffix)| suffix).unwrap_or("").to_lowercase())
}

#[tauri::command]
pub(crate) async fn desktop_file_type_icon(name: String) -> Result<Option<String>, String> {
    let permit = native_icon_permit().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        type_icon(&name)
    })
    .await
    .map_err(|error| error.to_string())?
}
pub(crate) fn select_application<'a>(
    handlers: &'a [NativeFileApplication],
    id: &str,
) -> Result<&'a NativeFileApplication, FileServiceError> {
    handlers
        .iter()
        .find(|app| app.id == id)
        .ok_or_else(|| FileServiceError {
            code: "application_not_registered",
            message: "Application is no longer registered for this File".into(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::path::Path;

    #[tokio::test]
    async fn native_file_icons_bounds_admission_before_blocking_lookup() {
        let permits = NATIVE_ICON_JOBS.acquire_many(4).await.unwrap();
        let request = desktop_file_type_icon("invalid/path.txt".into());
        tokio::pin!(request);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), &mut request)
                .await
                .is_err()
        );
        drop(permits);
        assert!(
            request.await.is_err(),
            "validation error must propagate after admission"
        );
    }

    #[test]
    fn native_file_icons_reject_paths_and_invalid_basenames() {
        for name in [
            "",
            ".",
            "..",
            "/tmp/test.txt",
            "../test.txt",
            "a/b.txt",
            "C:\\test.txt",
            "a\\b.txt",
            "a\0.txt",
            "a\n.txt",
            "file:stream.txt",
        ] {
            assert!(type_icon(name).is_err(), "accepted {name:?}");
        }
        assert!(type_icon(&"x".repeat(256)).is_err());
        assert_eq!(type_extension(".TXT").unwrap(), type_extension("note.txt").unwrap());
        assert_eq!(type_extension("no-extension").unwrap(), "");
    }

    #[test]
    fn native_file_icons_application_selection_rejects_unregistered_id() {
        let app = NativeFileApplication {
            id: "registered".into(),
            name: "App".into(),
            icon: None,
            is_default: true,
        };
        let handlers = [app];
        assert_eq!(
            select_application(&handlers, "registered").unwrap().name,
            "App"
        );
        for id in [
            "",
            "/Applications/Other.app",
            "registered --args",
            "REGISTERED",
        ] {
            assert_eq!(
                select_application(&handlers, id).unwrap_err().code,
                "application_not_registered"
            );
        }
        assert!(select_application(&[], "registered").is_err());
        let dto = serde_json::to_value(&handlers[0]).unwrap();
        assert_eq!(dto["isDefault"], true);
        assert_eq!(dto["icon"], serde_json::Value::Null);
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn native_file_icons_registered_application_enumeration_has_os_png_without_launch() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("registered-handlers.txt");
        std::fs::write(&file, "OS association probe; no application launch").unwrap();
        let handlers = Applications::load(&file).unwrap().list();
        assert!(!handlers.is_empty(), "text file handlers");
        assert!(
            handlers.iter().any(|app| app.is_default),
            "default text handler"
        );
        assert!(handlers.len() <= 64);
        for app in &handlers {
            assert!(!app.id.is_empty() && !app.name.is_empty());
            let icon = app.icon.as_deref().expect("registered application OS icon");
            let bytes = STANDARD
                .decode(icon.strip_prefix("data:image/png;base64,").unwrap())
                .unwrap();
            let png = image::load_from_memory(&bytes).unwrap();
            assert!(png.width() <= 64 && png.height() <= 64);
            assert!(
                png.to_rgba8().pixels().any(|pixel| pixel[3] != 0),
                "blank icon for {}",
                app.name
            );
            #[cfg(target_os = "macos")]
            assert!(app.id.ends_with(".app") && Path::new(&app.id).is_dir());
        }
        println!(
            "Native registered handlers (no launch): {:?}",
            handlers
                .iter()
                .map(|app| (&app.name, app.is_default))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            select_application(&handlers, "/tmp/not-a-registered-application")
                .unwrap_err()
                .code,
            "application_not_registered"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[tokio::test]
    async fn native_file_icons_public_type_boundary_returns_os_png_without_physical_file() {
        for name in [
            "missing-native-file-icon-124.txt",
            "missing-native-file-icon-124.docx",
            "missing-native-file-icon-124.unregistered124",
            "README",
            ".gitignore",
            "a'\";$.pdf",
        ] {
            let icon = desktop_file_type_icon(name.into())
                .await
                .unwrap()
                .expect("OS type icon");
            let bytes = STANDARD
                .decode(icon.strip_prefix("data:image/png;base64,").unwrap())
                .unwrap();
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
            let image = image::load_from_memory(&bytes).unwrap();
            assert!(image.width() <= 64 && image.height() <= 64);
            assert!(
                image.to_rgba8().pixels().any(|pixel| pixel[3] != 0),
                "blank type icon for {name}"
            );
        }
    }
}
