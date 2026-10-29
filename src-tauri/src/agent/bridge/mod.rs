//! Local adapters share the currently open Workspace and its native services.
pub mod cli;
pub(crate) mod cli_install;
pub mod client;
mod connection_store;
mod contacts;
pub(crate) mod embedded;
mod object_reads;
mod record_writes;
mod file_writes;
mod schedules;
pub(crate) mod commands;
pub mod credentials;
pub mod mcp;
pub(crate) mod dispatch;
pub mod protocol;
pub mod registry;
pub(crate) mod transport;

use super::errors::{AgentError, AgentResult, ErrorCode};
use std::{path::PathBuf, sync::{atomic::AtomicBool, Arc}};

#[derive(Default)]
pub(crate) struct BridgeRuntime {
    pub enabled: Arc<AtomicBool>,
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
#[cfg(test)]
mod todo_write_tests;

#[cfg(test)]
mod file_write_tests;
