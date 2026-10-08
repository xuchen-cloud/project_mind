//! Shared AI domain boundary. Adapters never own a second Workspace database.
pub mod access;
pub mod capabilities;
pub mod changes;
pub(crate) mod commands;
pub mod context;
pub mod conversation;
pub(crate) mod conversation_commands;
pub(crate) mod host;
pub(crate) mod process;
pub(crate) mod profile_probe;
pub(crate) mod run_commands;
pub(crate) mod source_navigation;
pub(crate) mod overview;
pub(crate) mod overview_inventory;
pub(crate) mod knowledge;
pub mod errors;
pub mod instructions;
pub mod maintenance;
pub mod models;
pub mod outputs;
pub mod repository;
pub mod runtime;
pub mod service;
pub mod sessions;
pub mod settings;
pub(crate) mod tools;

#[cfg(test)]
mod tests;
