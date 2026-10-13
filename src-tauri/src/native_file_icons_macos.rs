use super::{select_application, NativeFileApplication};
use std::{
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const SCRIPT: &str = include_str!("native_file_icons_macos.js");
const OUTPUT_LIMIT: u64 = 4 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(15);

// Fixed Apple program/source. Arguments are data and cannot become JXA code.
fn query(operation: &str, input: &std::ffi::OsStr) -> Result<Vec<u8>, String> {
    let mut script = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    script
        .write_all(SCRIPT.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut child = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript"])
        .arg(script.path())
        .arg(operation)
        .arg(input)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(OUTPUT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let errors = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .take(16 * 1024)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if start.elapsed() < DEADLINE => thread::sleep(Duration::from_millis(10)),
            Ok(None) => break Err("Native icon lookup timed out".to_string()),
            Err(error) => break Err(error.to_string()),
        }
    };
    if status.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let output = reader
        .join()
        .map_err(|_| "Native icon output reader failed")?
        .map_err(|e| e.to_string())?;
    let error = errors
        .join()
        .map_err(|_| "Native icon error reader failed")?
        .map_err(|e| e.to_string())?;
    if !status?.success() {
        return Err(format!(
            "Native icon lookup failed: {}",
            String::from_utf8_lossy(&error).trim()
        ));
    }
    if output.len() as u64 > OUTPUT_LIMIT {
        return Err("Native icon output exceeded its budget".into());
    }
    Ok(output)
}

pub(super) fn type_icon(extension: &str) -> Result<String, String> {
    serde_json::from_slice(&query("type", extension.as_ref())?).map_err(|e| e.to_string())
}

pub(crate) struct Applications {
    entries: Vec<NativeFileApplication>,
}
impl Applications {
    pub(crate) fn load(path: &Path) -> Result<Self, String> {
        let entries = serde_json::from_slice(&query("applications", path.as_os_str())?)
            .map_err(|e| e.to_string())?;
        Ok(Self { entries })
    }
    pub(crate) fn list(&self) -> Vec<NativeFileApplication> {
        self.entries.clone()
    }
    pub(crate) fn open(&self, id: &str, path: &Path) -> anyhow::Result<()> {
        let app = select_application(&self.entries, id)?;
        let mut child = Command::new("/usr/bin/open")
            .arg("-a")
            .arg(&app.id)
            .arg("--")
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let start = Instant::now();
        loop {
            if let Some(status) = child.try_wait()? {
                anyhow::ensure!(
                    status.success(),
                    "Registered application failed to open the current File"
                );
                return Ok(());
            }
            if start.elapsed() >= DEADLINE {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!("Registered application launch timed out");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}
