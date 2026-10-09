use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::models::WorkspaceBinding;

pub const DISCOVERY_FILE: &str = "agent-bridge.json";
pub const ENDPOINT_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Discovery {
    pub instance_id: String,
    pub port: u16,
    pub endpoint_version: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectInput {
    pub instance_id: String,
    pub grant_id: String,
    pub request_id: String,
    pub workspace_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallInput {
    pub instance_id: String,
    pub grant_id: String,
    pub request_id: String,
    pub binding: WorkspaceBinding,
    pub method: String,
    pub params: Value,
}
