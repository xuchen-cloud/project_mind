//! Local adapters share the currently open Workspace and its native services.
pub mod cli;
pub mod client;
mod connection_store;
mod object_reads;
mod record_writes;
pub(crate) mod commands;
pub mod credentials;
pub mod mcp;
pub(crate) mod dispatch;
pub mod protocol;
pub mod registry;
pub(crate) mod transport;

use super::errors::{AgentError, AgentResult, ErrorCode};
use std::{path::PathBuf, sync::atomic::AtomicBool};

#[derive(Default)]
pub(crate) struct BridgeRuntime {
    pub enabled: AtomicBool,
    pub running: tokio::sync::Mutex<Option<transport::RunningBridge>>,
}

pub fn local_data_dir() -> AgentResult<PathBuf> {
    crate::default_app_data_dir()
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot locate application data"))
}

#[cfg(test)]
mod transport_tests;
#[cfg(test)]
mod dispatch_tests;

#[cfg(test)]
mod read_tests;
#[cfg(test)]
mod write_tests;
