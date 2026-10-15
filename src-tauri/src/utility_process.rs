//! Fixed Node process execution shared by conversion and source extraction.
use crate::agent::errors::{AgentError, AgentResult, ErrorCode};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};
const NODE_VERSION_GUARD: &str = "data:text/javascript,if(process.versions.node!==%2724.21.0%27)throw%20new%20Error(%27Unsupported%20utility%20runtime%27)";

pub(crate) struct UtilityLimits {
    pub timeout: Duration,
    pub response_bytes: usize,
    pub heap_mib: usize,
}

pub(crate) async fn run_utility_process(
    node: &Path,
    entry: &Path,
    distribution: &Path,
    frame: &[u8],
    limits: UtilityLimits,
) -> AgentResult<Vec<u8>> {
    let source = entry.parent().ok_or_else(|| {
        AgentError::new(ErrorCode::RuntimeUnavailable, "Utility entry is missing")
    })?;
    let temporary = tempfile::tempdir()
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot prepare utility process"))?;
    let mut command = Command::new(node);
    command
        .arg("--permission")
        .arg(format!("--max-old-space-size={}", limits.heap_mib))
        .arg(format!("--allow-fs-read={}", source.display()))
        .arg(format!("--allow-fs-read={}", distribution.display()))
        .arg(format!("--import={NODE_VERSION_GUARD}"))
        .arg(entry)
        .current_dir(temporary.path())
        .env_clear()
        .env("PATH", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| {
        AgentError::new(
            ErrorCode::RuntimeUnavailable,
            "Cannot start packaged utility process",
        )
    })?;
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| AgentError::new(ErrorCode::IoFailed, "Utility input is unavailable"))?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| AgentError::new(ErrorCode::IoFailed, "Utility output is unavailable"))?;
    let result = tokio::time::timeout(limits.timeout, async {
        let send = async {
            input.write_all(frame).await?;
            input.shutdown().await?;
            drop(input);
            Ok::<_, std::io::Error>(())
        };
        let receive = async {
            let mut bytes = Vec::new();
            output
                .take(limits.response_bytes as u64 + 1)
                .read_to_end(&mut bytes)
                .await?;
            Ok::<_, std::io::Error>(bytes)
        };
        let (_, bytes) = tokio::try_join!(send, receive)
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Utility pipe failed"))?;
        if bytes.len() > limits.response_bytes {
            return Err(AgentError::new(
                ErrorCode::RuntimeIncompatible,
                "Utility response exceeds frame limit",
            ));
        }
        let status = child
            .wait()
            .await
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot settle utility process"))?;
        if !status.success() {
            return Err(AgentError::new(
                ErrorCode::RuntimeIncompatible,
                "Utility process exited unsuccessfully",
            ));
        }
        Ok(bytes)
    })
    .await;
    match result {
        Ok(result) => {
            if result.is_err() {
                let _ = child.kill().await;
            }
            result
        }
        Err(_) => {
            let _ = child.kill().await;
            Err(AgentError::new(
                ErrorCode::IoFailed,
                "Utility process timed out",
            ))
        }
    }
}
