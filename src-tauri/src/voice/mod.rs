//! Platform-independent contracts for Voice Record capture.
mod session;
pub use session::*;
pub mod capture;
pub mod commands;
pub mod contracts;
pub mod processing;
pub mod recognition;
pub mod runtime;
pub mod storage;
