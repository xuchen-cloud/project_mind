//! Shared AI domain boundary. Adapters never own a second Workspace database.
pub mod access;
pub mod capabilities;
pub mod changes;
pub(crate) mod commands;
pub mod context;
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

#[cfg(test)]
mod tests;
