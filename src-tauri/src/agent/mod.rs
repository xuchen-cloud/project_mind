//! Shared AI domain boundary. Adapters never own a second Workspace database.
pub mod access;
pub mod capabilities;
pub mod bridge;
pub mod connections;
pub(crate) mod references;
pub(crate) mod connection_operations;
pub(crate) mod connection_todos;
pub mod changes;
pub(crate) mod commands;
pub mod context;
pub mod conversation;
pub mod errors;
pub(crate) mod local_metrics;
pub mod instructions;
pub(crate) mod knowledge;
pub(crate) mod memory;
pub mod maintenance;
pub mod models;
pub(crate) mod operations;
pub(crate) mod operation_batches;
pub(crate) mod output_commands;
pub(crate) mod output_runtime;
pub(crate) mod output_review;
pub(crate) mod output_service;
pub(crate) mod output_tools;
pub mod outputs;
pub(crate) mod overview;
pub(crate) mod overview_inventory;
pub(crate) mod profile_probe;
pub(crate) mod record_blocks;
pub(crate) mod record_get;
pub(crate) mod record_text;
pub(crate) mod record_list;
pub(crate) mod listing;
pub(crate) mod file_list;
pub(crate) mod record_outputs;
pub(crate) mod record_write_tools;
pub mod repository;
pub(crate) mod run_commands;
pub mod runtime;
pub mod service;
pub mod sessions;
pub mod settings;
pub(crate) mod source_navigation;
pub(crate) mod source_trace;
pub(crate) mod tools;
pub(crate) mod todo_outputs;
pub(crate) mod todo_tools;
pub(crate) mod file_tools;
pub(crate) mod file_outputs;
pub(crate) mod file_undo;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod file_dispatch_tests;
