use serde::{Deserialize, Serialize};
use super::models::{ObjectRef, Scope};

/// Trusted GUI input. Operations are assigned by the Host, never by a client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionCreateInput {
    pub client_label: String,
    pub workspace_content: bool,
    pub project_ids: Vec<i64>,
    /// Resolve all current, unarchived Projects when each request authenticates.
    #[serde(default)]
    pub all_projects: bool,
    pub session_read: bool,
    /// Explicit trusted GUI selection; the Host accepts only implemented Record operations.
    #[serde(default)]
    pub write_operations: Vec<String>,
    #[serde(default)]
    pub objects: Option<Vec<ObjectRef>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGrant {
    pub id: String,
    pub client_label: String,
    pub workspace_id: String,
    pub workspace_content: bool,
    pub project_ids: Vec<i64>,
    #[serde(default)]
    pub all_projects: bool,
    pub operations: Vec<String>,
    #[serde(default)]
    pub objects: Option<Vec<ObjectRef>>,
    pub enabled: bool,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProject {
    pub id: i64,
    pub name: String,
}

/// Trusted GUI selector input; it does not grant access by itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionObjectsInput {
    pub scope: Scope,
    pub query: String,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionObjectOption {
    pub object: ObjectRef,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionObjectPage {
    pub items: Vec<ConnectionObjectOption>,
    pub next_cursor: Option<String>,
}
