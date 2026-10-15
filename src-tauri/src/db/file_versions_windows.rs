//! Windows exclusive moves, including ordinary paths longer than MAX_PATH.
#![cfg(windows)]

use std::os::windows::ffi::OsStrExt;
use std::path::{Component, Path, Prefix};

use anyhow::{bail, Result};
use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

/// Resolve lexically before adding the extended-length prefix. In particular, do
/// not canonicalize: the destination need not exist and the source may be a link.
fn extended_path(path: &Path) -> Result<Vec<u16>> {
    if path.as_os_str().encode_wide().any(|unit| unit == 0) {
        bail!("File move path contains an embedded NUL");
    }
    reject_device_namespace(path)?;
    let absolute = std::path::absolute(path)?;
    reject_device_namespace(&absolute)?;
    let mut wide = match absolute.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(_) => {
                let mut wide: Vec<u16> = r"\\?\".encode_utf16().collect();
                wide.extend(absolute.as_os_str().encode_wide());
                wide
            }
            Prefix::UNC(server, share) if !server.is_empty() && !share.is_empty() => {
                let mut wide: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
                wide.extend(absolute.as_os_str().encode_wide().skip(2));
                wide
            }
            Prefix::VerbatimDisk(_) if absolute.has_root() => {
                absolute.as_os_str().encode_wide().collect()
            }
            Prefix::VerbatimUNC(server, share) if !server.is_empty() && !share.is_empty() => {
                absolute.as_os_str().encode_wide().collect()
            }
            _ => bail!("File move requires a drive or UNC file path"),
        },
        _ => bail!("File move requires an absolute file path"),
    };
    wide.push(0);
    Ok(wide)
}

fn reject_device_namespace(path: &Path) -> Result<()> {
    if let Some(Component::Prefix(prefix)) = path.components().next() {
        if matches!(prefix.kind(), Prefix::DeviceNS(_) | Prefix::Verbatim(_)) {
            bail!("Device namespaces are unsupported for file moves");
        }
    }
    // DOS device names and alternate data streams are not ordinary file paths.
    for component in path.components() {
        if let Component::Normal(name) = component {
            let name = name.to_string_lossy();
            let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ');
            let stem = stem.to_ascii_uppercase();
            let numbered_device = stem
                .strip_prefix("COM")
                .or_else(|| stem.strip_prefix("LPT"));
            if name.contains(':')
                || matches!(
                    stem.as_str(),
                    "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                )
                || matches!(
                    numbered_device,
                    Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
                )
            {
                bail!("File move requires an ordinary file path");
            }
        }
    }
    Ok(())
}

pub(super) fn move_exclusive(from: &Path, to: &Path) -> Result<()> {
    let from = extended_path(from)?;
    let to = extended_path(to)?;
    // Neither REPLACE_EXISTING nor COPY_ALLOWED: preserve exclusive, same-volume
    // rename semantics and the original Win32 error on failure.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs::{self, File, OpenOptions};
    use std::io::Read;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::PathBuf;
    use windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };

    fn converted(path: &str) -> String {
        let wide = extended_path(Path::new(path)).unwrap();
        assert_eq!(wide.last(), Some(&0));
        String::from_utf16(&wide[..wide.len() - 1]).unwrap()
    }

    fn identity(file: &File) -> (u32, u64) {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        assert_ne!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) },
            0,
            "{}",
            std::io::Error::last_os_error()
        );
        (
            info.dwVolumeSerialNumber,
            ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        )
    }

    fn extended(path: &Path) -> PathBuf {
        let wide = extended_path(path).unwrap();
        PathBuf::from(OsString::from_wide(&wide[..wide.len() - 1]))
    }

    #[test]
    fn converts_drive_unc_and_preserves_verbatim() {
        assert_eq!(
            converted(r"C:\目录 空格\child\..\file.bin"),
            r"\\?\C:\目录 空格\file.bin"
        );
        assert_eq!(
            converted(r"C:/folder/./file.bin"),
            r"\\?\C:\folder\file.bin"
        );
        assert_eq!(
            converted(r"\\server\share\目录 空格\child\..\file.bin"),
            r"\\?\UNC\server\share\目录 空格\file.bin"
        );
        for path in [
            r"\\?\C:\目录 空格\file.bin",
            r"\\?\UNC\server\share\file.bin",
            r"\\?\C:\folder\..\file.bin",
        ] {
            assert_eq!(converted(path), path);
        }
        let relative = Path::new("relative file.bin");
        assert_eq!(
            converted("relative file.bin"),
            converted(std::path::absolute(relative).unwrap().to_str().unwrap())
        );
    }

    #[test]
    fn rejects_nul_and_non_file_namespaces() {
        for path in [
            "C:\\source\0suffix",
            "\\\\?\\C:\\target\0suffix",
            r"\\.\PhysicalDrive0",
            r"\\.\C:\file.bin",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\file.bin",
            r"\\?\Volume{00000000-0000-0000-0000-000000000000}\file.bin",
            r"C:\NUL",
            r"C:\con.txt",
            r"C:\COM1",
            r"C:\file.bin:stream",
            "",
        ] {
            assert!(extended_path(Path::new(path)).is_err(), "accepted {path:?}");
        }
    }

    #[test]
    fn long_plain_paths_move_and_keep_identity() {
        let temp = tempfile::tempdir().unwrap();
        // Temp roots may themselves be verbatim. Strip only that prefix so the
        // actual move receives ordinary long paths, as the production caller does.
        let root = extended(temp.path());
        let root_text = root.to_str().unwrap();
        let plain_root = if let Some(unc) = root_text.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{unc}"))
        } else {
            PathBuf::from(root_text.strip_prefix(r"\\?\").unwrap())
        };
        let mut directory = plain_root;
        for index in 0..20 {
            directory.push(format!("中文 目录 {index:02} 嵌套长路径测试"));
        }
        fs::create_dir_all(extended(&directory)).unwrap();
        let from = directory.join("源 文件.bin");
        let to = directory.join("目标 文件.bin");
        assert!(from.as_os_str().encode_wide().count() > 260);
        assert!(to.as_os_str().encode_wide().count() > 260);
        assert!(!from.as_os_str().to_string_lossy().starts_with(r"\\?\"));
        fs::write(extended(&from), b"long path contents").unwrap();
        let before = identity(&File::open(extended(&from)).unwrap());
        assert_ne!(before.1, 0, "filesystem must expose a stable file ID");
        move_exclusive(&from, &to).unwrap();
        assert!(!extended(&from).try_exists().unwrap());
        assert_eq!(fs::read(extended(&to)).unwrap(), b"long path contents");
        assert_eq!(identity(&File::open(extended(&to)).unwrap()), before);
    }

    #[test]
    fn existing_destination_is_not_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let from = temp.path().join("source.bin");
        let to = temp.path().join("destination.bin");
        fs::write(&from, b"source").unwrap();
        fs::write(&to, b"destination").unwrap();
        let source_id = identity(&File::open(&from).unwrap());
        let destination_id = identity(&File::open(&to).unwrap());
        let error = move_exclusive(&from, &to).unwrap_err();
        assert!(error.downcast_ref::<std::io::Error>().is_some());
        assert_eq!(fs::read(&from).unwrap(), b"source");
        assert_eq!(fs::read(&to).unwrap(), b"destination");
        assert_eq!(identity(&File::open(&from).unwrap()), source_id);
        assert_eq!(identity(&File::open(&to).unwrap()), destination_id);
    }

    #[test]
    fn reader_sharing_delete_allows_move() {
        let temp = tempfile::tempdir().unwrap();
        let from = temp.path().join("source.bin");
        let to = temp.path().join("destination.bin");
        fs::write(&from, b"shared reader").unwrap();
        let mut reader = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(&from)
            .unwrap();
        let before = identity(&reader);
        move_exclusive(&from, &to).unwrap();
        assert!(!from.try_exists().unwrap());
        assert_eq!(identity(&File::open(&to).unwrap()), before);
        assert_eq!(identity(&reader), before);
        let mut contents = String::new();
        reader.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "shared reader");
    }

    #[test]
    fn reader_without_delete_sharing_blocks_move() {
        let temp = tempfile::tempdir().unwrap();
        let from = temp.path().join("source.bin");
        let to = temp.path().join("destination.bin");
        fs::write(&from, b"locked reader").unwrap();
        let reader = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&from)
            .unwrap();
        let before = identity(&reader);
        let error = move_exclusive(&from, &to).unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .raw_os_error(),
            Some(ERROR_SHARING_VIOLATION as i32)
        );
        assert_eq!(fs::read(&from).unwrap(), b"locked reader");
        assert!(!to.try_exists().unwrap());
        assert_eq!(identity(&File::open(&from).unwrap()), before);
        assert_eq!(identity(&reader), before);
    }
}
